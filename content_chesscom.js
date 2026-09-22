// Chess.com content script for Stockfish Continue to Play.
// After a game ends, injects a "Continue vs Computer" button. Clicking it hides
// the game-over modal and lets you keep playing the final position vs Stockfish
// on the original Chess.com board. The engine runs in a Web Worker; correctness
// (castling, en-passant, 50-move, repetition) is delegated to Stockfish by
// replaying the move history with `position fen <start> moves …`.
//
// Pure helpers live in lib/chess-core.js (logic) and lib/chess-dom.js (scraping),
// loaded before this file by the manifest. They are referenced here as globals.

const DEBUG = false;
function log(...args) { if (DEBUG) console.log('[SF+]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[SF+]', ...args); }

log('content script loaded — v' + chrome.runtime.getManifest().version + ' —', location.href);

const ENGINE_DEPTH = 12;
// An instant reply reads as a glitch, not as a move. Every engine move is held
// back to the pace of the game you were just playing: the average move time read
// off the finished game's clocks when Chess.com shows them, otherwise the pace
// you are setting yourself in this continuation. Clamped at both ends — never
// instant, never a wait.
const PACE_MIN_MS = 400;
const PACE_MAX_MS = 1600;   // past this a reply stops feeling like thinking and starts feeling like waiting
const PACE_OF_GAME = 0.7;   // a continuation runs brisker than the game it came from
const PACE_DEFAULT_MS = 650;
const PACE_SAMPLES = 3; // how many of your own recent moves the pace follows

// Let Chess.com's own board render the continuation, by playing our moves on it
// through the bridge. OFF.
//
// The bridge READS beautifully: getFEN gives the displayed position with real
// castling rights, a real en-passant square and the right side to move, and
// getResult says outright whether a game has finished. All of that is kept.
//
// Driving their board is the part that does not hold up. On a review page
// game.move() behaves in ways this extension cannot predict — the view does not
// follow the move, moves land in variations, the animation jumps — and each fix
// for one of those uncovered the next. A continuation where the pieces do not
// visibly move is worse than one drawn in our own overlay, which has worked
// since 3.3.0.
//
// One line to turn it back on, once that behaviour is understood well enough to
// be tested rather than discovered.
const NATIVE_RENDERING = false;
const ENGINE_INIT_TIMEOUT_MS = 15000;
const REFRESH_INTERVAL_MS = 1000;
const POLL_INTERVAL_MS = 200;
const NAV_POLL_INTERVAL_MS = 1000;
const BANNER_TIMEOUT_MS = 15000;

// Only the page identity, never the query: Chess.com rewrites ?move=N on every
// click in the move list, and treating that as navigation would tear down a
// continuation the moment the player glanced at an earlier move.
const pageKey = () => location.origin + location.pathname;
let lastPage = pageKey();

// ── State ───────────────────────────────────────────────────────────────────
// chesscomState = { startFen, moves[], boardData, selectedSq, playerSide,
//                   engineSide, sideToMove, board, _ptrCleanup, _refreshTimer }
let chesscomState = null;

// ── What the page world can see ────────────────────────────────────────
// page-bridge.js runs inside Chess.com's own JavaScript world — the only place
// their board component is reachable — and publishes what it says about the
// position. null when it is not there: an older Chess.com, or a browser where
// world:"MAIN" did not take. Everything here falls back to scraping in that
// case, which is exactly what shipped before, so the bridge can only add.
let pageState = null;

let _cmdId = 0;
const _pending = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d) return;
  if (d.__sfct === 'page-state') { pageState = d.state || null; return; }
  if (d.__sfct === 'cmd-reply') { _pending.get(d.id)?.({ ok: d.ok, value: d.value }); _pending.delete(d.id); }
});

// Ask the page world to do something. The bridge refuses anything that changes
// the board unless Chess.com's own game reports a result, so this asking is only
// ever half of the decision — the other half is the gate that let the trigger
// appear in the first place.
function pageCmd(op, args) {
  if (!pageState) return Promise.resolve({ ok: false, value: 'nessun bridge' });
  const id = ++_cmdId;
  return new Promise((resolve) => {
    _pending.set(id, resolve);
    setTimeout(() => { if (_pending.delete(id)) resolve({ ok: false, value: 'timeout' }); }, 2500);
    window.postMessage({ __sfct: 'cmd', id, op, args }, location.origin);
  });
}

// Their board says which colour you are playing. The shape is not documented,
// so only values we actually recognise are honoured — a wrong colour hands you
// your opponent's pieces, which is the worst failure this extension has.
function bridgePlayerColor() {
  const v = pageState?.playingAs;
  if (v === 'white' || v === 'black') return v;
  if (v === 1) return 'white';
  if (v === 2) return 'black';
  return null;
}
let _perftMoves = null;   // null = idle, [] = collecting `go perft 1` output
let _legalMoves = null;   // UCI legal moves for the side to move, or null
let _mateSide = null;     // the side with no moves, while working out mate vs stalemate
let _mateScore = null;    // 'mate' | 'draw' — what the engine said about that position

// ── Stockfish engine (Web Worker) ───────────────────────────────────────────
let sfWorker = null;
let workerReady = false;
let cmdQueue = [];
let initPromise = null;
let initTimer = null;
// Bumped on every stop. A slow init that settles after the user stopped (or
// restarted) must not touch the current session — the abandoned init's 15 s
// timeout used to fire long after the fact and pop "Engine failed to load."
// over the restored board.
let sessionId = 0;

// Terminate the worker and reset all engine state so the next init starts clean.
function teardownEngine() {
  if (initTimer) { clearTimeout(initTimer); initTimer = null; }
  if (sfWorker) {
    try { sfWorker.postMessage('quit'); } catch (_) {}
    try { sfWorker.terminate(); } catch (_) {}
  }
  sfWorker = null; workerReady = false; cmdQueue = []; initPromise = null;
}

function initEngine() {
  if (workerReady && sfWorker) return Promise.resolve();
  if (initPromise) return initPromise; // de-dupe concurrent inits
  initPromise = new Promise((resolve, reject) => {
    let settled = false;
    // Always tear the worker down before rejecting, so a failed/timed-out init
    // never leaks a live Worker or leaves sfWorker assigned-but-unconfigured.
    const fail = (err) => { if (settled) return; settled = true; teardownEngine(); reject(err); };
    fetch(chrome.runtime.getURL('stockfish.js'))
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(src => {
        // The engine is WebAssembly: the loader is a small .js file and the
        // 7 MB binary sits beside it. From a blob the loader cannot resolve a
        // relative path, so it reads the .wasm URL out of the fragment of its
        // own worker URL (self.location.hash). Both files are packaged; this
        // is still a package-internal URL, not a download.
        const wasmUrl = chrome.runtime.getURL('stockfish.wasm');
        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        sfWorker = new Worker(blobUrl + '#' + encodeURIComponent(wasmUrl));
        URL.revokeObjectURL(blobUrl);
        sfWorker.onmessage = onEngineMessage;
        sfWorker.onerror = (e) => {
          warn('worker error', e);
          if (!settled) { fail(e); return; }
          // Crashed mid-game — full teardown so overlays/handlers don't linger.
          if (chesscomState) endGame('Game stopped', 'the engine crashed');
          else teardownEngine();
        };
        sfWorker.postMessage('uci');
        initTimer = setTimeout(() => { if (!workerReady) fail(new Error('Engine init timeout')); }, ENGINE_INIT_TIMEOUT_MS);
        // resolve happens in onEngineMessage on 'readyok'
        initEngine._resolve = () => {
          if (settled) return;
          settled = true;
          if (initTimer) { clearTimeout(initTimer); initTimer = null; }
          resolve();
        };
      })
      .catch(fail);
  });
  return initPromise;
}

function onEngineMessage({ data }) {
  if (typeof data !== 'string') return;

  if (data === 'uciok') { sfWorker.postMessage('isready'); return; }
  if (data === 'readyok') {
    workerReady = true;
    while (cmdQueue.length) sfWorker.postMessage(cmdQueue.shift());
    if (initEngine._resolve) initEngine._resolve();
    return;
  }
  if (_mateSide) { // a mate/stalemate probe is in flight — read its verdict
    if (data.startsWith('info') && / score /.test(data)) {
      if (/ score mate 0\b/.test(data)) _mateScore = 'mate';
      else if (/ score cp 0\b/.test(data)) _mateScore = 'draw';
    }
    if (data.startsWith('bestmove')) finishMateProbe();
    return;
  }

  if (data.startsWith('bestmove')) {
    const move = data.split(' ')[1];
    const uci = move && move !== '(none)' ? move : null;
    // A real bestmove proves the side to move HAS one, so the position is
    // neither mate nor stalemate and a draw can be claimed — before the engine
    // plays a reply to a game that is already over.
    const drawn = uci && drawReason(chesscomState);
    if (drawn) { declareDraw(chesscomState, drawn); return; }
    const session = sessionId;
    const rest = Math.max(0, pacingTarget() - (Date.now() - _thinkStart));
    setTimeout(() => { if (session === sessionId) onEngineMove(uci); }, rest);
    return;
  }
  // Perft output: legal-move lines, then a "Nodes searched:" terminator.
  if (_perftMoves !== null) {
    const pm = parsePerftMove(data);
    if (pm) { _perftMoves.push(pm); return; }
    if (data.startsWith('Nodes searched:')) {
      _legalMoves = _perftMoves || [];
      _perftMoves = null;
      if (_legalMoves.length === 0) { probeMate(chesscomState?.sideToMove); return; }
      // Legal moves exist, so this is not mate or stalemate: any draw now
      // standing is one of the quiet ones.
      const drawn = drawReason(chesscomState);
      if (drawn) { declareDraw(chesscomState, drawn); return; }
      if (chesscomState?.selectedSq) syncBoardToState();
      return;
    }
  }
}

function postCmd(cmd) {
  if (workerReady) sfWorker.postMessage(cmd);
  else cmdQueue.push(cmd);
}

function enginePosition() {
  const { startFen, moves } = chesscomState;
  return 'position fen ' + startFen + (moves.length ? ' moves ' + moves.join(' ') : '');
}

let _thinkStart = 0;

const clampPace = (ms) => Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, Math.round(ms)));

// How long the engine's next move should take, all in.
function pacingTarget() {
  const st = chesscomState;
  if (!st) return PACE_DEFAULT_MS;
  const base = st.gamePaceMs ? st.gamePaceMs * PACE_OF_GAME
    : st.yourPaces?.length ? st.yourPaces.reduce((a, b) => a + b, 0) / st.yourPaces.length
    : PACE_DEFAULT_MS;
  return clampPace(base * (0.88 + Math.random() * 0.24)); // never twice the same beat
}

function engineThink() {
  updateStatus('Stockfish thinking…');
  _thinkStart = Date.now();
  postCmd('go depth ' + ENGINE_DEPTH);
}

function requestLegalMoves() {
  _legalMoves = null;
  _perftMoves = [];
  postCmd('go perft 1');
}

// A side with no legal moves is either checkmated or stalemated. Ask the engine
// what the OTHER side could play from the same placement: if one of those moves
// lands on the stuck king, the king is attacked and it is checkmate.
// A side with no legal moves is either checkmated or stalemated, and the board
// alone cannot tell you which. Searching the position does: Stockfish scores a
// mated side as `score mate 0` and a stalemated one as `score cp 0`.
// (Asking it to enumerate the other side's moves does not work — it never
// generates a capture of the enemy king, so every mate looked like stalemate.)
function probeMate(side) {
  if (!chesscomState || !side) { endGame('Game over'); return; }
  _mateSide = side;
  _mateScore = null;
  postCmd(enginePosition());
  postCmd('go depth 1');
}

function finishMateProbe() {
  const st = chesscomState;
  const side = _mateSide, score = _mateScore;
  _mateSide = null; _mateScore = null;
  if (!st) return;
  // Nothing has been played yet, so the position you picked was already over.
  // Say that, rather than announce the result of a game that never started.
  if (!st.moves.length) {
    const title = score === 'mate' ? 'Already checkmate'
      : score === 'draw' ? 'Already stalemate' : 'No legal moves here';
    endGame(title, 'there is nothing to play from this position', { rematch: false });
    return;
  }
  const youLost = side === st.playerSide;
  if (score === 'mate') {
    endGame(youLost ? 'Stockfish won' : 'You won!', 'by checkmate',
      { winner: side === 'w' ? 'b' : 'w' });
    return;
  }
  if (score === 'draw') { endGame('Draw', 'by stalemate'); return; }
  endGame('Game over', 'no legal moves left');
}

// ── Board lookup ─────────────────────────────────────────────────────────────
function findActiveBoard() {
  let best = null;
  for (const b of document.querySelectorAll('wc-chess-board, chess-board')) {
    if (!document.body.contains(b)) continue;
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!best || r.width > best.getBoundingClientRect().width) best = b;
  }
  return best;
}

// ── Game-over modal ──────────────────────────────────────────────────────────
// Hide only the specific Chess.com game-over surfaces (no wildcard removal, which
// previously nuked unrelated UI). Interaction with the board still works because
// our pointer listeners run in the capture phase.
function removeGameOverModal() {
  if (document.getElementById('sfct-modal-blocker')) return;
  const s = document.createElement('style');
  s.id = 'sfct-modal-blocker';
  // :not([data-sfct]) on every one of them. Our own result card wears Chess.com's
  // modal classes so it matches their design exactly — without this it would be
  // hidden by the very rule that hides theirs.
  s.textContent = [
    '.game-over-modal-shell', '.game-over-modal-component', '.game-over-modal-content',
    '.game-over-buttons-component', '.game-over-container', '[data-cy="game-over-dialog"]',
    '.game-result-component', '[class*="game-over-modal"]', '.board-modal-overlay',
  ].map(sel => sel + ':not([data-sfct])').join(',') + '{display:none!important}';
  document.head.appendChild(s);
}

// ── Show / hide the inline board ─────────────────────────────────────────────
function injectBoardStyle(native) {
  if (document.getElementById('sfct-board-style')) return;
  const bs = document.createElement('style');
  bs.id = 'sfct-board-style';
  bs.textContent = [
    // Only when we are drawing. In native mode Chess.com keeps its own pieces on
    // the board and plays our moves itself, so there is nothing to hide.
    ...(native ? [] : [
      'wc-chess-board [class*="piece"]:not([data-sfct]),chess-board [class*="piece"]:not([data-sfct]){display:none!important}',
      '[data-sfct="piece"]{transition:transform var(--move-animation-duration,180ms) ease-out}',
    ]),
    // The king in check. Chess.com draws this with a VFX layer whose artwork is
    // not reachable from a class, so this is their red radial glow instead.
    //
    // Their motion is NOT copied wholesale any more. The ±4° wiggle is theirs,
    // but it is theirs for an ICON: rotating a square div full of a gradient
    // just swings its corners through the fade, which read as a rotating
    // rectangle rather than a glow. The element is clipped to a circle so it has
    // no corners to show, and the motion is the pulse alone — grow on their
    // 50ms, settle on their easing.
    '[data-sfct="check"]{pointer-events:none}',
    '.sfct-check-el{width:100%;height:100%;border-radius:50%;' +
      'background:radial-gradient(circle at center,rgba(255,0,0,.92) 0%,rgba(231,0,0,.78) 28%,rgba(169,0,0,0) 72%);' +
      'animation:_sfctgrow 50ms linear 0s 1 normal forwards,' +
      '_sfctshrink .25s cubic-bezier(.16,1,.3,1) .35s 1 normal forwards}',
    '@keyframes _sfctgrow{0%{transform:scale(.86)}100%{transform:scale(1.12)}}',
    '@keyframes _sfctshrink{0%{transform:scale(1.12)}100%{transform:scale(1)}}',
  ].join('');
  document.head.appendChild(bs);
}

// Engine strength: 'auto' matches the opponent you just played, anything else is
// a fixed rating ('max' = no limit at all).
function engineStrength(setting) {
  if (setting === 'max') return { label: 'full strength', uciElo: null };
  const rating = setting && setting !== 'auto' ? parseInt(setting, 10) : getOpponentElo();
  return { label: String(rating), uciElo: eloToUCIElo(rating) };
}

// Turn the opponent's own player card into Stockfish, so who you are playing is
// where you already look for it rather than on a strip of our own.
//
// Found by DATA, not by class names: inside the opponent's row, the leaf that
// reads as a rating is the rating, and the first other leaf carrying letters is
// the name. Chess.com has renamed everything about that row three times in this
// project's history; what it holds has not changed.
//
// Returns a function that puts every word back exactly as it was.
function labelOpponentAsEngine(name, rating) {
  const row = opponentRow();
  if (!row) return null;
  const leaves = [...row.querySelectorAll('*')].filter(el => !el.children.length && (el.textContent || '').trim());
  const ratingEl = leaves.find(el => RATING_RE.test((el.textContent || '').trim()));
  const nameEl = leaves.find(el => el !== ratingEl && /[a-z]/i.test((el.textContent || '').trim()));
  const undo = [];
  const set = (el, text) => {
    if (!el) return;
    const was = el.textContent;
    undo.push(() => { try { el.textContent = was; } catch (_) {} });
    // Keep their own parenthesised shape when that is how the rating is written.
    el.textContent = text;
  };
  if (nameEl && nameEl === ratingEl) {
    set(nameEl, rating ? `${name} (${rating})` : name);
    return () => undo.forEach(f => f());
  }
  set(nameEl, name);
  if (ratingEl && rating) {
    const parenthesised = /^\(.*\)$/.test((ratingEl.textContent || '').trim());
    set(ratingEl, parenthesised ? `(${rating})` : String(rating));
  }
  return undo.length ? () => undo.forEach(f => f()) : null;
}

function showChesscomBoard(fen, color, strengthSetting) {
  try {
    hideChesscomBoard();
    removeGameOverModal();

    const [, fenSide, fenCastling = '-', fenEp = '-', fenHalf = '0'] = fen.split(' ');
    const sideToMove = fenSide || 'w';
    const playerSide = color === 'white' ? 'w' : 'b';
    const engineSide = playerSide === 'w' ? 'b' : 'w';
    const strength = engineStrength(strengthSetting);

    const session = ++sessionId;
    const board = findActiveBoard();
    if (!board) { showBanner('Board not found.'); return; }
    board.style.touchAction = 'none';

    chesscomState = {
      startFen: fen, moves: [], boardData: fenToBoard(fen),
      selectedSq: null, playerSide, engineSide, sideToMove, board,
      strengthSetting, finished: false,
      // Chess.com draws the game when we can reach their board.
      native: NATIVE_RENDERING && !!pageState,
      // How far back through the move list this position sits. A rematch has to
      // come back here: resetToMainLine() lands at the END of the game, so
      // branching straight after it restarts from the finish — which is over
      // already, and the new game ended the instant it began.
      pliesBack: (() => {
        const total = plyNodes().length;
        const at = plyFromUrl();
        return at && total ? Math.max(0, total - at) : 0;
      })(),
      // Seconds per move in the game just played, when its clocks are on the page.
      gamePaceMs: (averageMoveSeconds() || 0) * 1000,
      yourPaces: [],
      turnStart: Date.now(),
      // Draw bookkeeping. The engine keeps its own copy of all of this, but it
      // is only ever asked for legal moves, and a drawn position still has
      // plenty of those — so the claim has to be made here.
      castling: fenCastling, enPassant: fenEp,
      halfmove: parseInt(fenHalf, 10) || 0,
      seen: new Map(), repeats: 1,
    };
    chesscomState.seen.set(
      positionKey(chesscomState.boardData, sideToMove, fenCastling, fenEp), 1);

    injectBoardStyle(chesscomState.native);
    // Branch off the position being shown: our moves then land in a variation
    // beside the real game, and resetToMainLine() on stop discards it and
    // hands the game back exactly as it was.
    if (chesscomState.native) {
      pageCmd('continuation').then(r => { if (!r.ok) fallBackToOverlay(r.value); });
    }
    syncBoardToState();
    attachPointerHandlers();
    startRefreshTimer();
    chesscomState._restoreOpponentName = labelOpponentAsEngine('Stockfish', strength.label);
    showStatusBadge('loading engine…');
    initEngine().then(() => {
      if (session !== sessionId || !chesscomState) return; // stopped or restarted while loading
      if (strength.uciElo) {
        postCmd('setoption name UCI_LimitStrength value true');
        postCmd(`setoption name UCI_Elo value ${strength.uciElo}`);
      }
      postCmd(enginePosition());
      if (sideToMove === engineSide) engineThink();
      else { updateStatus('Your move'); requestLegalMoves(); }
    }).catch(e => {
      warn('engine init failed', e);
      if (session !== sessionId) return; // belongs to a game the user already stopped
      hideChesscomBoard();
      showBanner('Engine failed to load.');
    });
  } catch (e) {
    warn('showChesscomBoard error', e);
    showBanner('Error: ' + (e?.message || e));
  }
}

function hideChesscomBoard() {
  // Drop our variation and put their move list back on the real game.
  if (chesscomState?.native) pageCmd('reset');
  if (chesscomState?._ptrCleanup) chesscomState._ptrCleanup();
  if (chesscomState?._refreshTimer) clearInterval(chesscomState._refreshTimer);
  releaseColumnFoot();
  document.getElementById('sfct-modal-blocker')?.remove();
  document.getElementById('sfct-badge')?.remove();
  document.getElementById('sfct-result')?.remove();
  // Dropping this un-hides Chess.com's own pieces again.
  document.getElementById('sfct-board-style')?.remove();
  chesscomState?._restoreOpponentName?.();
  if (chesscomState?.board) {
    chesscomState.board.style.touchAction = '';
    chesscomState.board.removeAttribute('data-sfct-state');
  }
  // Drop our overlay pieces/dots so the board shows Chess.com's again.
  // _sfctCleanup first: a card removed without it leaves its resize/scroll
  // listeners on window, holding the detached node alive.
  document.querySelectorAll('[data-sfct]').forEach(el => { el._sfctCleanup?.(); el.remove(); });
  sessionId++;
  teardownEngine();
  _perftMoves = null;
  _legalMoves = null;
  chesscomState = null;
}

// End of game. The final position STAYS on the board — a game that just ended
// does not reset itself — and the result arrives as a modal over the board, the
// way Chess.com announces one. Everything is only torn down when the player
// dismisses that modal.
function endGame(title, subtitle, opts) {
  const st = chesscomState;
  if (!st) return;
  st.finished = true;
  st._ptrCleanup?.();
  st._ptrCleanup = null;
  st.selectedSq = null;
  teardownEngine();
  _legalMoves = null;
  _perftMoves = null;
  syncBoardToState();
  updateStatus('Game over');
  showResultModal(title, subtitle || '', opts);
}

// Give the board back to Chess.com.
function dismissResult() {
  const card = document.getElementById('sfct-result');
  card?._sfctCleanup?.();
  card?.remove();
  hideChesscomBoard();
}

async function rematch() {
  const st = chesscomState;
  if (!st) return;
  const { startFen, playerSide, strengthSetting, native, pliesBack } = st;
  const card = document.getElementById('sfct-result');
  card?._sfctCleanup?.();
  card?.remove();
  hideChesscomBoard(); // this is what sends resetToMainLine
  // …which leaves their board at the end of the real game. Walk it back to where
  // the continuation began before branching again. Messages are handled in the
  // order they are posted, so this lands after the reset.
  if (native && pliesBack > 0) await pageCmd('backward', { n: pliesBack });
  showChesscomBoard(startFen, playerSide === 'w' ? 'white' : 'black', strengthSetting);
}

// ── Rendering ────────────────────────────────────────────────────────────────
// Move the piece nodes that moved; add and remove only what changed. Rebuilding
// every node on every move is what made play look jumpy — a piece has to keep
// its node for the board's transition to animate it across.
let _sfSyncing = false;

// One board square, positioned by place(). Same values Chess.com gives its own
// .highlight / .hint / .capture-hint, so the two never disagree.
const SQUARE_BOX = 'position:absolute;top:0;left:0;width:12.5%;height:12.5%;';

// Chess.com's capture ring is NOT the 5px their base rule declares: measured
// against a live board it computes to 7.5px on an 86px square, so they scale it
// with the board and the declared value is only a floor. Taking the class alone
// left ours a third too thin — everything else about it matched to the pixel.
// Recomputed every render, so a resized board keeps the right weight.
const RING_RATIO = 7.5 / 86;

function makePieceNode(pc) {
  const el = document.createElement('div');
  el.setAttribute('data-sfct', 'piece');
  el.dataset.pc = pc;
  el.className = `piece ${pc === pc.toUpperCase() ? 'w' : 'b'}${pc.toLowerCase()}`;
  el.style.cssText = 'position:absolute;top:0;left:0;width:12.5%;height:12.5%;z-index:5';
  return el;
}

// Chess.com's own token for a selected square. Copying the paint off whichever
// highlight happened to be first on the board looked clever and was not: on a
// review page the first one is an annotation — a red blunder, a yellow
// inaccuracy — so the square you picked up came out in whatever colour that
// move had been graded. --color-bg-selected means exactly this and nothing
// else.
const SELECTED_PAINT = { background: 'var(--color-bg-selected, rgba(255,255,255,.4))', opacity: '1' };

// Restart Chess.com's grow / wiggle / shrink on the checked king.
function replayCheck() {
  const el = document.querySelector('[data-sfct="check"] .sfct-check-el');
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

// Their board would not take a move — the bridge's own result gate said no, or
// the component went away under us. Draw the game ourselves from here instead of
// leaving a board that never changes: a refusal must cost the native LOOK, never
// the game. Silence was the whole failure: pieces simply stopped moving, with
// nothing in the console to say why.
function fallBackToOverlay(why) {
  const st = chesscomState;
  if (!st || !st.native) return;
  st.native = false;
  warn('page bridge refused (' + why + ') \u2014 drawing the board ourselves');
  document.getElementById('sfct-board-style')?.remove();
  injectBoardStyle(false);
  st._flipped = undefined; // force every piece to be placed again
  syncBoardToState();
  showBanner('Chess.com would not take the moves \u2014 playing on our own board.', 5000);
}

function syncBoardToState() {
  if (!chesscomState?.board || _sfSyncing) return;
  _sfSyncing = true;
  try {
    const st = chesscomState;
    const { board, boardData, selectedSq } = st;
    const flipped = isFlipped(board);
    const dests = (selectedSq && _legalMoves) ? legalDestsFrom(_legalMoves, selectedSq) : null;

    // A square is 12.5% of the board, and a transform percentage is relative to
    // the element's own size — so whole-percent steps land on squares at any
    // board size, and a resize needs no recalculation at all.
    const place = (el, sq) => {
      const f = sq.charCodeAt(0) - 97;
      const r = parseInt(sq[1], 10);
      el.dataset.sq = sq;
      el.className = el.className.replace(/\s*square-\d\d/, '') + ` square-${f + 1}${r}`;
      el.style.transform = `translate(${(flipped ? 7 - f : f) * 100}%,${(flipped ? r - 1 : 8 - r) * 100}%)`;
    };

    if (!st.native) {
    const nodes = new Map();
    board.querySelectorAll(':scope > [data-sfct="piece"]').forEach(el => nodes.set(el.dataset.sq, el));

    if (st._flipped !== flipped) { // the user flipped the board — everything moves
      st._flipped = flipped;
      nodes.forEach((el, sq) => place(el, sq));
    }

    const prev = {};
    nodes.forEach((el, sq) => { prev[sq] = el.dataset.pc; });
    const { moved, added, removed } = diffBoards(prev, boardData);

    for (const sq of removed) { nodes.get(sq)?.remove(); nodes.delete(sq); }
    for (const m of moved) {
      const el = nodes.get(m.from);
      if (!el) continue;
      nodes.delete(m.from);
      place(el, m.to);
      nodes.set(m.to, el);
    }
    for (const a of added) {
      const el = makePieceNode(a.piece);
      place(el, a.sq);
      board.appendChild(el);
      nodes.set(a.sq, el);
    }

    }

    // The checked king. Chess.com plays its own effect in native mode — the
    // real one, an image asset on a VFX layer, not this approximation.
    if (!st.native) {
    // A king in check keeps the red square while the check stands. The node is
    // REUSED, never rebuilt: recreating it restarts Chess.com's grow/wiggle, so
    // it replayed on every re-render — picking a piece up made the king twitch.
    // It only plays when the check first appears, or moves to another king.
    const checkedKing = isKingAttacked(boardData, st.sideToMove) && kingSquare(boardData, st.sideToMove);
    let mark = board.querySelector(':scope > [data-sfct="check"]');
    if (!checkedKing) {
      mark?.remove();
    } else {
      if (!mark) {
        mark = document.createElement('div');
        mark.setAttribute('data-sfct', 'check');
        mark.style.cssText = SQUARE_BOX + 'z-index:3';
        mark.appendChild(Object.assign(document.createElement('div'), { className: 'sfct-check-el' }));
        board.appendChild(mark);
        place(mark, checkedKing);
      } else if (mark.dataset.sq !== checkedKing) {
        place(mark, checkedKing);
        replayCheck();
      }
    }

    }

    // The square you picked up from, and where it can go. All three wear
    // Chess.com's own classes rather than anything drawn here, so they ARE
    // Chess.com's markers - the same borrowing the pieces do with `.piece` for
    // the sprite, and it follows their restyles for free:
    //
    //   .hint          12.5% square, border-radius 50%, 4.2% padding clipped to
    //                  the content box - the small dot on an empty square
    //   .capture-hint  the same square with a 5px ring - drawn AROUND the piece
    //                  standing on it, which is why a dot was invisible there
    //   .highlight     the square you have selected
    //
    // Geometry stays ours, paint is theirs. Their rules size these too, but
    // leaning on that for LAYOUT means a rename silently stacks every marker
    // at a1 instead of just leaving them unpainted — and the percentages in
    // place() resolve against the element's own size, so it has to have one.
    // The values are theirs, so nothing here fights their rule.
    board.querySelectorAll(':scope > [data-sfct="sel"], :scope > [data-sfct="dot"]').forEach(el => el.remove());
    if (selectedSq) {
      const sel = document.createElement('div');
      sel.setAttribute('data-sfct', 'sel');
      sel.className = 'highlight';
      // Their own last-move highlight is on the board while you play, so its
      // computed paint is copied off it. The `.highlight` base rule is a solid
      // rgb(255,255,51) that nobody ever sees on a real board — the theme
      // overrides it to a translucent green, the same way it overrides the
      // capture ring's declared 5px. Taking the class alone gave us the raw
      // yellow, opaque, which is not their colour and hides what it marks.
      const paint = SELECTED_PAINT;
      // FIRST child, not last: Chess.com's highlights sit under the pieces and
      // ours has to as well. Appended at the end it painted OVER the piece and
      // the piece you had just picked up vanished until the move was made.
      sel.style.cssText = SQUARE_BOX +
        `background:${paint.background};opacity:${paint.opacity}`;
      place(sel, selectedSq);
      board.insertBefore(sel, board.firstChild);
    }
    const squarePx = board.getBoundingClientRect().width / 8;
    for (const dest of dests || []) {
      const dot = document.createElement('div');
      dot.setAttribute('data-sfct', 'dot');
      const capture = !!boardData[dest];
      dot.className = capture ? 'capture-hint' : 'hint';
      dot.style.cssText = SQUARE_BOX + 'z-index:6' +
        (capture && squarePx ? `;border-width:${(squarePx * RING_RATIO).toFixed(1)}px` : '');
      place(dot, dest);
      board.appendChild(dot);
    }
    // An invisible record of what this render actually did. The decision that
    // matters — are we drawing, or is Chess.com — lives in the isolated world
    // where a page console cannot see it, and not being able to read it is what
    // made a blank board impossible to diagnose from the outside.
    board.setAttribute('data-sfct-debug', JSON.stringify({
      native: !!st.native,
      men: Object.keys(boardData).length,
      drawn: board.querySelectorAll(':scope > [data-sfct="piece"]').length,
      hiding: !!document.getElementById('sfct-board-style')?.textContent.includes('display:none'),
      bridge: !!pageState,
    }));
  } finally { _sfSyncing = false; }
}

// ── Pointer handling ─────────────────────────────────────────────────────────
function attachPointerHandlers() {
  let dragStart = null;
  const currentBoard = () => {
    if (!chesscomState) return null;
    const b = chesscomState.board;
    if (b && document.body.contains(b)) return b;
    const nb = findActiveBoard();
    if (nb) chesscomState.board = nb;
    return nb;
  };
  const inside = (b, e) => {
    const r = b.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  // Only the primary button is ours. Right-click is how Chess.com draws arrows
  // and colours squares, and capturing every button ate those before their
  // board ever saw them — the annotation tools simply stopped existing while a
  // continuation was on.
  const notOurs = (e) => e.button !== undefined && e.button !== 0;
  const onDown = (e) => {
    if (notOurs(e)) return;
    if (e.target?.closest?.('#sfct-badge, #sfctplay-banner, #sfctplay-btn, #sfct-result, #sfct-ask')) return;
    if (e.target?.closest?.('[data-sfct="promo"]')) return; // the picker handles its own clicks
    if (cancelPromotion()) { e.preventDefault(); e.stopPropagation(); return; }
    const b = currentBoard();
    if (!b || !inside(b, e)) return;
    const sq = computeSquareFromClick(b, e.clientX, e.clientY);
    if (!sq) return;
    dragStart = sq;
    e.preventDefault(); e.stopPropagation();
  };
  const onUp = (e) => {
    if (notOurs(e)) return;
    if (!dragStart) return;
    const b = currentBoard();
    if (!b || !inside(b, e)) { dragStart = null; return; }
    const endSq = computeSquareFromClick(b, e.clientX, e.clientY);
    if (!endSq) { dragStart = null; return; }
    e.preventDefault(); e.stopPropagation();
    if (endSq === dragStart) handleSquareClick(endSq);
    else handleDragMove(dragStart, endSq);
    dragStart = null;
  };
  const onCancel = () => { dragStart = null; };
  document.body.addEventListener('pointerdown', onDown, { capture: true });
  document.body.addEventListener('pointerup', onUp, { capture: true });
  document.body.addEventListener('pointercancel', onCancel, { capture: true });
  chesscomState._ptrCleanup = () => {
    document.body.removeEventListener('pointerdown', onDown, { capture: true });
    document.body.removeEventListener('pointerup', onUp, { capture: true });
    document.body.removeEventListener('pointercancel', onCancel, { capture: true });
  };
}

// Keep the board reference alive across Chess.com re-renders and strip its pieces.
function startRefreshTimer() {
  chesscomState._refreshTimer = setInterval(() => {
    if (!chesscomState || _sfSyncing) return;
    const cur = chesscomState.board;
    if (!cur || !document.body.contains(cur)) {
      const nb = findActiveBoard();
      if (nb) { chesscomState.board = nb; nb.style.touchAction = 'none'; syncBoardToState(); }
      return;
    }
    // A Chess.com re-render can wipe our overlay children without replacing the
    // board node — put them back. Not in native mode: there are never any of
    // our pieces there, so this test is always true and would rebuild the
    // markers once a second for nothing.
    //
    // There used to be more here: if redrawing still left no pieces, it dropped
    // the style hiding Chess.com's and switched to native. That was meant to
    // rescue a blank board, and it made things worse — native sends the move to
    // the bridge, the bridge refuses it, the refusal falls back to overlay,
    // overlay finds no pieces, and round it goes, adding and removing the
    // hiding style once a second. The pieces you moved never appeared. A rescue
    // that flips the mode it is running in cannot be a rescue; whatever leaves
    // the board empty has to be found and fixed, not papered over.
    if (!chesscomState.native && !cur.querySelector(':scope > [data-sfct="piece"]')) syncBoardToState();
  }, REFRESH_INTERVAL_MS);
}

// Chess.com answers an illegal move by shaking the king's red square. Same here:
// it is the fastest way to say "you are in check, deal with that first".
function refuseMove() {
  const st = chesscomState;
  const inCheck = st && isKingAttacked(st.boardData, st.sideToMove);
  updateStatus(inCheck ? 'You are in check' : 'Illegal move');
  if (!inCheck) return;
  replayCheck();
}

// The four-piece column Chess.com pops over the promotion square. Queen first,
// then knight, rook, bishop — its order, since that is the order people expect.
function askPromotion(to, side, onPick) {
  const st = chesscomState;
  // No board to hang the picker off: refuse the move rather than choose a
  // piece on the player's behalf. A queen nobody asked for is worse than a
  // move that did not happen, which they can simply play again.
  if (!st?.board) { updateStatus('Cannot show the promotion picker'); return; }
  document.querySelectorAll('[data-sfct="promo"]').forEach(el => el.remove());
  const flipped = isFlipped(st.board);
  const f = to.charCodeAt(0) - 97;
  const r = parseInt(to[1], 10);
  const col = document.createElement('div');
  col.setAttribute('data-sfct', 'promo');
  const fromTop = flipped ? r === 1 : r === 8; // the column hangs off the promotion edge
  // Four squares tall, one square wide, in board units — a piece is 12.5% of the
  // board, so the column is exactly 50%. No aspect-ratio: Chess.com's own .piece
  // rule is absolutely positioned, and the cells would collapse to zero height.
  col.style.cssText = `position:absolute;left:${(flipped ? 7 - f : f) * 12.5}%;width:12.5%;height:50%;` +
    `z-index:9;background:#f8f8f8;border-radius:6px;box-shadow:0 10px 28px rgba(0,0,0,.5);` +
    `overflow:hidden;` + (fromTop ? 'top:0;' : 'bottom:0;');
  for (const p of ['q', 'n', 'r', 'b']) {
    const cell = document.createElement('div');
    // Marked as ours: the style that hides Chess.com's pieces keys off the
    // absence of data-sfct, and these carry Chess.com's own `piece` class to
    // borrow its sprite.
    cell.setAttribute('data-sfct', 'promo-piece');
    cell.className = `piece ${side}${p}`;
    cell.style.cssText = 'position:relative;width:100%;height:25%;left:auto;top:auto;' +
      'transform:none;background-size:100% 100%;cursor:pointer';
    // backgroundColor, never the `background` shorthand: the shorthand resets
    // background-image too, and the piece these cells show comes from Chess.com's
    // sprite through the `piece` class — so hovering one made the piece you were
    // about to choose disappear.
    cell.onmouseenter = () => { cell.style.backgroundColor = 'rgba(0,0,0,.08)'; };
    cell.onmouseleave = () => { cell.style.backgroundColor = ''; };
    cell.onclick = (e) => { e.preventDefault(); e.stopPropagation(); col.remove(); onPick(p); };
    col.appendChild(cell);
  }
  st.board.appendChild(col);
}

function cancelPromotion() {
  const open = document.querySelector('[data-sfct="promo"]');
  if (!open) return false;
  open.remove();
  if (chesscomState) { chesscomState.selectedSq = null; syncBoardToState(); updateStatus('Your move'); }
  return true;
}

// Every player move goes through here: promotions ask first, everything else
// goes straight to the board.
function beginMove(from, to) {
  const st = chesscomState;
  if (!st) return;
  if (!isPromotion(st.boardData, from, to)) { makePlayerMove(from, to); return; }
  updateStatus('Choose a piece');
  askPromotion(to, st.playerSide, (piece) => makePlayerMove(from, to, piece));
}

function ownsPiece(piece) {
  if (!piece || !chesscomState) return false;
  return chesscomState.playerSide === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase();
}

function handleSquareClick(sq) {
  const st = chesscomState;
  if (!st || st.finished || st.sideToMove !== st.playerSide) return;
  if (!_legalMoves) { updateStatus('Calculating…'); return; }

  const piece = st.boardData[sq];
  const sel = st.selectedSq;

  if (!sel) {
    if (!ownsPiece(piece)) return;
    if (_legalMoves && !legalDestsFrom(_legalMoves, sq)?.size) { refuseMove(); return; }
    st.selectedSq = sq; syncBoardToState(); updateStatus('Select destination'); return;
  }
  if (sel === sq) { st.selectedSq = null; syncBoardToState(); updateStatus('Your move'); return; }
  if (ownsPiece(piece)) {
    // King onto your own rook is how Chess.com castles.
    const castle = castleDestination(st.boardData, _legalMoves, sel, sq);
    if (castle) { st.selectedSq = null; beginMove(sel, castle); return; }
    st.selectedSq = sq; syncBoardToState(); updateStatus('Select destination'); return;
  }
  if (!isLegalMove(_legalMoves, sel, sq)) { st.selectedSq = null; syncBoardToState(); refuseMove(); return; }
  beginMove(sel, sq);
}

function handleDragMove(from, to) {
  const st = chesscomState;
  if (!st || st.finished || st.sideToMove !== st.playerSide) return;
  if (!_legalMoves) { updateStatus('Calculating…'); return; }
  if (!ownsPiece(st.boardData[from])) return;
  const castle = castleDestination(st.boardData, _legalMoves, from, to);
  if (castle) { st.selectedSq = null; beginMove(from, castle); return; }
  if (!isLegalMove(_legalMoves, from, to)) { refuseMove(); return; }
  st.selectedSq = null;
  beginMove(from, to);
}

// Everything a draw claim needs, taken from the move that was just applied.
// Called after boardData and sideToMove have been updated, so the key it builds
// describes the position now on the board.
function recordMove(st, moved) {
  st.castling = castlingAfter(st.castling, moved);
  st.enPassant = enPassantAfter(moved);
  // The fifty-move count restarts on a capture or a pawn move, and only then.
  const pawn = moved.piece === 'P' || moved.piece === 'p';
  st.halfmove = (moved.capture || pawn) ? 0 : st.halfmove + 1;
  const key = positionKey(st.boardData, st.sideToMove, st.castling, st.enPassant);
  st.repeats = (st.seen.get(key) || 0) + 1;
  st.seen.set(key, st.repeats);
}

// Why this position is drawn, or null. Only ever consulted where the side to
// move is KNOWN to have a legal move: mate and stalemate outrank all of these,
// and a game that ends in mate on the hundredth quiet move is mate, not a draw.
function drawReason(st) {
  if (!st) return null;
  if (isInsufficientMaterial(st.boardData)) return 'neither side can force mate';
  if (st.repeats >= 3) return 'by threefold repetition';
  if (st.halfmove >= 100) return 'by the fifty-move rule';
  return null;
}

// A position that was already drawn when it was picked gets the same treatment
// as one that was already mate: say so, and do not offer to replay it.
function declareDraw(st, reason) {
  if (!st.moves.length) { endGame('Already a draw', reason, { rematch: false }); return; }
  endGame('Draw', reason);
}

function makePlayerMove(from, to, promo) {
  const st = chesscomState;
  if (!st) return;
  if (st.turnStart) { // your own pace, in case the finished game showed no clocks
    st.yourPaces.push(Date.now() - st.turnStart);
    if (st.yourPaces.length > PACE_SAMPLES) st.yourPaces.shift();
  }
  const uci = toUci(st.boardData, from, to, promo);
  if (!uci) { updateStatus('Choose a piece'); return; } // a promotion with nothing chosen
  const res = applyUciMove(st.boardData, uci);
  if (!res.moved) return;
  st.boardData = res.board;
  st.moves.push(uci);
  st.selectedSq = null;
  st.sideToMove = st.engineSide;
  recordMove(st, res.moved);
  if (st.native) {
    pageCmd('move', { from, to, promotion: promo || undefined })
      .then(r => { if (!r.ok) fallBackToOverlay(r.value); });
  }
  syncBoardToState();
  postCmd(enginePosition());
  engineThink();
}

function onEngineMove(uci) {
  const st = chesscomState;
  if (!st) return;
  if (!uci) { probeMate(st.engineSide); return; } // mate or stalemate — find out which
  const res = applyUciMove(st.boardData, uci);
  // Our board map and the engine's position disagree — the game can only freeze
  // from here, so stop cleanly instead of leaving the badge stuck on "thinking".
  if (!res.moved) { warn('engine move on empty square', uci); endGame('Game stopped', 'the board and the engine went out of sync'); return; }
  st.boardData = res.board;
  st.moves.push(uci);
  st.sideToMove = st.playerSide;
  recordMove(st, res.moved);
  if (st.native) {
    pageCmd('move', { from: uci.slice(0, 2), to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined })
      .then(r => { if (!r.ok) fallBackToOverlay(r.value); });
  }
  st.turnStart = Date.now();
  syncBoardToState();
  updateStatus('Your move');
  postCmd(enginePosition());
  requestLegalMoves();
}

// ── Status badge & banner ────────────────────────────────────────────────────
// No badge, no pill, no strip. Who you are playing is on the opponent's own
// player card, which reads Stockfish for as long as the game runs; the state
// itself is kept as an attribute on the board rather than drawn anywhere.
// Every version of this we painted got in the way of something: it sat on the
// clock, it docked over their controls, it floated in a corner.
function showStatusBadge(text) {
  document.getElementById('sfct-badge')?.remove();
  document.getElementById('sfct-result')?.remove();
  updateStatus(text);
}

// An attribute on their board, not an element of ours: nothing to overlap, and
// still readable by anything that wants to know what the extension is doing.
// Cleared on teardown with the rest.
function updateStatus(text) {
  chesscomState?.board?.setAttribute('data-sfct-state', text);
}

function ensureAnimStyle() {
  if (document.getElementById('sfctplay-style')) return;
  const s = document.createElement('style');
  s.id = 'sfctplay-style';
  s.textContent = '@keyframes _sfctin{from{opacity:0;top:4px}to{opacity:1;top:16px}}' +
    '@keyframes _sfctpop{from{opacity:0;transform:translate(-50%,-50%) scale(.92)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
  document.head.appendChild(s);
}

function showBanner(text, ms) {
  document.getElementById('sfctplay-banner')?.remove();
  ensureAnimStyle();
  const el = document.createElement('div');
  el.id = 'sfctplay-banner';
  Object.assign(el.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '999999', background: '#1e2124', color: '#fff', padding: '14px 28px',
    borderRadius: '10px', borderLeft: '5px solid #769656',
    fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', fontSize: '18px',
    fontWeight: '600', boxShadow: '0 8px 32px rgba(0,0,0,.7)', cursor: 'pointer',
    animation: '_sfctin .28s ease',
    // Never intercepts a click. This banner sat over the top of the page and
    // our pointer handlers skip anything inside it, so until it was dismissed
    // it swallowed every click that landed under it — the first move of a
    // continuation simply did not register.
    pointerEvents: 'none',
  });
  const msg = document.createElement('span');
  msg.textContent = text;
  el.append(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms || BANNER_TIMEOUT_MS);
}

// ── Result modal ─────────────────────────────────────────────────────────────
// Chess.com announces a result with a card over the board, so this one looks
// like that: same dark card, same green primary button, centred on the board.
// It lives in <body>, never inside Chess.com's own DOM — inserting nodes into
// their Vue-rendered modal made Vue throw "insertBefore … not a child".
function centreOnBoard(el) {
  const b = chesscomState?.board;
  const r = b ? b.getBoundingClientRect() : null;
  if (!r || !r.width) { el.style.left = '50%'; el.style.top = '40%'; el.style.transform = 'translate(-50%,-50%)'; return; }
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top = (r.top + r.height / 2) + 'px';
  el.style.transform = 'translate(-50%,-50%)';
}

// Chess.com's own button, not a copy of one. Their classes carry the shape, the
// colour, the type and the states, and they follow the theme you have chosen.
function cardButton(text, primary) {
  const b = document.createElement('button');
  b.setAttribute('data-sfct', 'card');
  b.className = 'cc-button-component cc-button-xx-large ' +
    (primary ? 'cc-button-primary cc-bg-primary' : 'cc-button-secondary');
  b.textContent = text;
  b.style.width = '100%';
  b.style.boxSizing = 'border-box';
  b.style.minWidth = '0';
  // cc-button-primary brings its own green gradient. The secondary paints
  // nothing outside their own containers, so it gets their input surface token
  // rather than a colour invented here.
  if (!primary) b.style.backgroundColor = 'var(--color-bg-input, rgba(255,255,255,.09))';
  return b;
}

// The card Chess.com announces a result with, assembled from its own parts:
//
//   board-modal-component            the panel, its radius and its theme colours
//     game-over-modal-shell-container
//       game-over-modal-shell-content
//         game-over-modal-header-component [ -whiteWon | -blackWon ]
//           game-over-modal-header-inner > -header
//         game-over-modal-shell-buttons
//
// Every node is tagged data-sfct: it keeps our card out of the rule that hides
// theirs, and it lets teardown collect the whole thing in one sweep.
function makeCard(id, title, subtitle, opts) {
  const old = document.getElementById(id);
  if (old) { old._sfctCleanup?.(); old.remove(); }
  ensureAnimStyle();
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.setAttribute('data-sfct', 'card');
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const card = el('div', 'board-modal-component');
  card.id = id;
  // Painted from Chess.com's own theme variables, not from colours written
  // down here. --color-bg-gradient-modal IS their modal surface, so this card
  // follows whatever theme you are on — the hardcoded #262421 it used before is
  // literally their --color-bg-opaque, which was right in dark mode by accident
  // and wrong in light mode. The old values stay as fallbacks for a page that
  // defines neither.
  Object.assign(card.style, {
    position: 'fixed', zIndex: '999998', width: 'min(340px,86vw)',
    overflow: 'hidden', boxSizing: 'border-box', animation: '_sfctpop .18s ease-out',
    // BOTH: their modal gradient runs from #312E2B to almost transparent,
    // because it is meant to sit ON a solid surface rather than be one. Set
    // as `background` alone it made the card see-through.
    backgroundColor: 'var(--color-bg-opaque, #262421)',
    backgroundImage: 'var(--color-bg-gradient-modal, none)',
    color: 'var(--color-text-default, #fff)',
    borderRadius: 'var(--radius-4, 10px)',
    boxShadow: '0 12px 40px var(--color-bg-overlay-subtle, rgba(0,0,0,.5))',
    fontFamily: 'inherit',
  });

  const header = el('div', 'game-over-modal-header-component' +
    (opts?.winner ? ` game-over-modal-header-${opts.winner === 'w' ? 'white' : 'black'}Won` : ''));
  header.style.position = 'relative';
  const inner = el('div', 'game-over-modal-header-inner');
  Object.assign(inner.style, { padding: '22px 20px 14px', textAlign: 'center',
    boxSizing: 'border-box' });
  const h = el('div', 'game-over-modal-header-header', title);
  Object.assign(h.style, { fontSize: '26px', fontWeight: '800', lineHeight: '1.15',
    minWidth: '0', whiteSpace: 'normal', overflowWrap: 'anywhere' });
  inner.appendChild(h);
  if (subtitle) {
    const sub = el('div', null, subtitle);
    Object.assign(sub.style, { opacity: '.62', fontSize: '14px', marginTop: '2px' });
    inner.appendChild(sub);
  }
  header.append(inner);

  const body = el('div', 'game-over-modal-shell-buttons');
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '0 20px 20px', boxSizing: 'border-box' });

  const content = el('div', 'game-over-modal-shell-content');
  content.append(header, body);
  const shell = el('div', 'game-over-modal-shell-container');
  shell.appendChild(content);
  card.appendChild(shell);
  // Their layout classes carry widths meant for their own containers. Ours
  // is a free-standing card, so every level is pinned to it: nothing can be
  // wider than the box that clips it.
  for (const n of [shell, content, header, inner, body]) {
    Object.assign(n.style, { width: '100%', maxWidth: '100%',
      boxSizing: 'border-box', minWidth: '0' });
  }
  return { card, body, header };
}

// Put a card on screen, centred on the board and staying there.
function showCard(card) {
  document.body.appendChild(card);
  centreOnBoard(card);
  const reposition = () => centreOnBoard(card);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { passive: true });
  card._sfctCleanup = () => {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition);
  };
}

function closeCard(card) { card._sfctCleanup?.(); card.remove(); }

// Asked only when the move list and the board cannot be reconciled on whose
// turn it is. One question beats silently starting a game with the wrong player
// up, which you would only notice once the engine moved a piece it should not
// have been able to touch.
function askSideToMove(onPick) {
  const { card, body } = makeCard('sfct-ask', 'Who is to move?',
    'this position does not say, so pick the side');
  card.style.zIndex = '1000000'; // above the floating trigger, which stays up
  const pick = (side) => () => { closeCard(card); onPick(side); };
  const white = cardButton('\u2654  White', false);
  const black = cardButton('\u265A  Black', false);
  white.onclick = pick('w');
  black.onclick = pick('b');
  // A question you cannot back out of is a trap: the answer starts a game.
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, {
    background: 'none', border: 'none', color: 'rgba(255,255,255,.45)',
    fontSize: '11px', cursor: 'pointer', marginTop: '2px',
  });
  cancel.onclick = () => closeCard(card);
  body.append(white, black, cancel);
  showCard(card);
}

// ── Result modal ─────────────────────────────────────────────────
// `opts.rematch === false` drops the "play again" button: a position that was
// already over when you picked it would lead straight back to this card.
function showResultModal(title, subtitle, opts) {
  const { card, body } = makeCard('sfct-result', title, subtitle || '', opts);
  const replayable = opts?.rematch !== false;
  if (replayable) {
    const again = cardButton('Play again vs Stockfish', true);
    again.onclick = rematch;
    body.appendChild(again);
  }
  const back = cardButton('Back to Chess.com', false);
  back.onclick = dismissResult;
  const note = document.createElement('div');
  note.setAttribute('data-sfct', 'card');
  note.textContent = replayable
    ? 'The final position stays on the board until you leave.'
    : 'Go back, pick an earlier move, then Continue again.';
  // minWidth:0 and a wrap: a flex child keeps min-width:auto, so this one line
  // refused to shrink and spilled past a card that clips its overflow.
  Object.assign(note.style, { fontSize: '12px', opacity: '.5', textAlign: 'center', marginTop: '2px',
    color: 'var(--color-text-subtle, inherit)', lineHeight: '1.3',
    minWidth: '0', whiteSpace: 'normal', overflowWrap: 'anywhere' });
  body.append(back, note);
  showCard(card);
}

// ── Inject the "Continue vs Computer" button ─────────────────────────────────
// The button must appear even when Chess.com renames its game-over modal classes.
// Strategy: try a native, in-modal placement that matches Chess.com's styling; if
// the known anchor is gone, append into the modal; if no modal container is found
// at all, fall back to a floating fixed-position button so it ALWAYS shows.

function onContinueClick(e) {
  e.preventDefault(); e.stopPropagation();
  chrome.storage.local.get(['active', 'strength'], ({ active, strength }) => {
    if (active === false) return;
    // The same board the game will be played on, not just the first one in the
    // document — a review page can carry more than one.
    const board = findActiveBoard();
    // Chess.com's own answer when we can reach it: one call in place of
    // scraping the piece divs, estimating castling rights from home squares,
    // deducing en passant from the last-move highlight and parsing the ply out
    // of the query string. Their FEN carries all of it, correctly, by
    // construction — and it is the position being SHOWN, which is the whole
    // point of this feature.
    if (pageState?.fen) { startContinuation(board, null, strength, pageState.fen); return; }
    const side = readSideToMove(board);
    if (side) { startContinuation(board, side, strength); return; }
    // Re-check the gate when the question is ANSWERED, not only when it was
    // asked: the click that starts a game is this one, and the page may have
    // moved on while the card sat open.
    askSideToMove((picked) => {
      if (chesscomState || !isGameOver()) return;
      startContinuation(findActiveBoard(), picked, strength);
    });
  });
}

// Capture the position on the board — whichever move in the list you are
// looking at — and hand it to the engine.
function startContinuation(board, side, strength, fenFromPage) {
  const fen = fenFromPage || getFEN(board, side);
  if (!fen) { showBanner('Position not found.'); return; }
  removeTrigger(); // the trigger goes away while you play
  showChesscomBoard(fen, bridgePlayerColor() || getPlayerColor(), strength);
}

// The trigger IS a Chess.com button: their classes, their shape, their states,
// their theme. Copying a neighbour's className and stuffing our own spans into
// it is what squashed this - their buttons are inline-grid today, and a flex
// wrapper from an older generation of their markup collapses inside that grid.
function makeNativeButton() {
  const btn = cardButton('\u265F Continue vs Computer', false);
  // NOT data-sfct: that marks the overlay, which teardown sweeps away. The
  // trigger is not part of a game and is managed by removeTrigger().
  btn.removeAttribute('data-sfct');
  btn.id = 'sfctplay-btn';
  btn.onclick = onContinueClick;
  return btn;
}

// Last-resort floating button — independent of Chess.com's modal DOM.
function injectFloatingButton() {
  if (document.getElementById('sfctplay-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'sfctplay-btn';
  btn.dataset.sfctFloating = '1';
  btn.textContent = '♟ Continue vs Computer';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '999999', background: '#769656', color: '#fff', border: 'none',
    padding: '12px 22px', borderRadius: '8px', fontSize: '15px', fontWeight: '700',
    cursor: 'pointer', boxShadow: '0 6px 24px rgba(0,0,0,.5)',
    fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
  });
  btn.onclick = onContinueClick;
  document.body.appendChild(btn);
  log('button injected (floating fallback)');
}

function injectButtons() {
  if (document.getElementById('sfctplay-btn')) return;

  // Chess.com's result card when it is on screen, otherwise the column holding
  // the move list. Coming back to a finished game later — which is when you
  // actually sit and walk the moves — there is no modal to dock under, and a
  // button floating over the board reads as something stuck to the window
  // rather than something belonging to the game.
  const modal = findGameOverModal();
  const anchor = modal || sidebarPanel();
  if (!anchor) { injectFloatingButton(); return; }

  // Line the trigger up under the anchor but keep the node in <body>: Chess.com
  // renders both surfaces with Vue, and inserting into them made Vue throw
  // "insertBefore … not a child of this node" on its next patch.
  const btn = makeNativeButton();

  // A strip that continues the surface above it: same width, same background,
  // rounded off at the bottom, sitting flush against it, so the two read as one
  // panel instead of as a button someone dropped on the page.
  const dock = document.createElement('div');
  dock.id = 'sfctplay-dock';
  dock.dataset.anchor = modal ? 'modal' : 'panel';
  const underCard = !!modal;
  Object.assign(dock.style, {
    position: 'fixed', zIndex: '999997', boxSizing: 'border-box',
    background: solidBackground(anchor),
    padding: underCard ? '0 20px 16px' : '10px 12px 12px',
    borderRadius: underCard ? '0 0 12px 12px' : '12px 12px 0 0',
    boxShadow: underCard ? '0 12px 32px rgba(0,0,0,.45)' : '0 -8px 24px rgba(0,0,0,.35)',
    borderTop: underCard ? 'none' : '1px solid rgba(255,255,255,.08)',
  });
  dock.appendChild(btn);
  document.body.appendChild(dock);
  alignTrigger();
  log('button injected (docked under the ' + dock.dataset.anchor + ')');
}

// A reloaded/updated extension orphans this content script: every chrome.* call
// then throws "Extension context invalidated".
function extensionAlive() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// Align a docked strip to whatever it was anchored to — Chess.com's result card
// or the move-list column — at that anchor's exact width, so the two read as one
// panel through scrolls and resizes.
//
// The two anchors need opposite treatment. A result card is a floating box with
// empty page under it, so the strip hangs BELOW it. The move-list column runs
// the full height of the window, so there is no "below": the strip sits at the
// bottom of the column as seen, inside its own width, and the column is asked to
// be that much shorter so nothing is covered.
function alignDock(dock) {
  if (!dock) return;
  const panel = dock.dataset.anchor === 'panel';
  const anchor = panel ? sidebarPanel() : findGameOverModal();
  if (!anchor) { if (!panel) removeTrigger(); return; }
  const r = anchor.getBoundingClientRect();
  if (!r.width) return;
  dock.style.left = r.left + 'px';
  dock.style.width = r.width + 'px';
  if (!panel) { dock.style.top = (r.bottom - 1) + 'px'; return; }
  const h = dock.getBoundingClientRect().height || 64;
  reserveColumnFoot(anchor, h);
  dock.style.top = Math.max(0, Math.min(r.bottom, window.innerHeight) - h) + 'px';
}

function alignTrigger() { alignDock(document.getElementById('sfctplay-dock')); }

// The modal container itself is often transparent — walk up until something
// actually paints, so the dock matches the card instead of flashing white.
function solidBackground(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
  }
  return '#262421';
}

function removeTrigger() {
  releaseColumnFoot();
  document.getElementById('sfctplay-btn')?.remove();
  document.getElementById('sfctplay-dock')?.remove();
}

function tryInject() {
  if (!extensionAlive()) { clearInterval(pollTimer); clearInterval(navTimer); return; }
  // While playing, the game-over modal is only CSS-hidden, so isGameOver() stays
  // true — without this guard the trigger button reappears over the live board.
  if (chesscomState) return;
  const existing = document.getElementById('sfctplay-btn');
  if (!isGameOver()) {
    // The game-over surface is gone (rematch, new game) — so is our trigger.
    if (existing) removeTrigger();
    return;
  }
  if (existing) { alignTrigger(); return; } // the modal moves with the layout
  log('game over detected — injecting button');
  // Re-check chesscomState inside the callback: a tick that fired just before
  // the user clicked Continue would otherwise land after the game started and
  // put the trigger back over the live board.
  chrome.storage.local.get(['active'], ({ active }) => {
    if (active !== false && !chesscomState) injectButtons();
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
// ponytail: a 200 ms poll, not a MutationObserver — Chess.com mutates the DOM
// ~10×/s (clocks, move list) and re-running tryInject on each one cost CPU for
// at most 200 ms of extra latency on a modal that the user is reading anyway.
const pollTimer = setInterval(tryInject, POLL_INTERVAL_MS);

// SPA navigation: Chess.com swaps pages without a reload.
const navTimer = setInterval(() => {
  const now = pageKey();
  if (now === lastPage) return;
  lastPage = now;
  removeTrigger();
  document.getElementById('sfctplay-banner')?.remove();
  hideChesscomBoard();
  tryInject();
}, NAV_POLL_INTERVAL_MS);

// React to the popup on/off toggle while a tab is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.active) return;
  if (changes.active.newValue === false) {
    removeTrigger();
    hideChesscomBoard();
  } else {
    tryInject();
  }
});

window.addEventListener('pagehide', () => {
  clearInterval(pollTimer);
  clearInterval(navTimer);
  hideChesscomBoard();
});
