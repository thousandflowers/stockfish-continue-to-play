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
const ENGINE_INIT_TIMEOUT_MS = 15000;
const REFRESH_INTERVAL_MS = 1000;
const POLL_INTERVAL_MS = 200;

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

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__sfct !== 'page-state') return;
  pageState = d.state || null;
});

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
  if (score === 'mate') { endGame(youLost ? 'Stockfish won' : 'You won!', 'by checkmate'); return; }
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
// Their game-over surfaces, hidden while a continuation plays. Every one is
// narrowed to THEIR nodes: our result card wears their modal classes on purpose,
// and the wildcard here once hid it - caught by the e2e run before a person ever
// had to. Same guard as the piece rule: ours carry data-sfct, theirs never do.
const THEIR_GAME_OVER = [
  '.game-over-modal-shell', '.game-over-modal-component', '.game-over-modal-content',
  '.game-over-buttons-component', '.game-over-container', '[data-cy="game-over-dialog"]',
  '.game-result-component', '[class*="game-over-modal"]', '.board-modal-overlay',
].map(sel => sel + ':not([data-sfct])').join(',');

function injectBoardStyle() {
  if (document.getElementById('sfct-board-style')) return;
  const bs = document.createElement('style');
  bs.id = 'sfct-board-style';
  bs.textContent = [
    // Chess.com's own pieces are hidden, never removed: dropping this style tag on
    // stop hands the board straight back instead of leaving it blank.
    'wc-chess-board [class*="piece"]:not([data-sfct]),chess-board [class*="piece"]:not([data-sfct]){display:none!important}',
    '[data-sfct="piece"]{transition:transform var(--move-animation-duration,180ms) ease-out;cursor:grab}',
    // A piece under the finger must not be animated towards where it already is:
    // the transition that makes a played move slide is exactly what makes a
    // dragged piece lag behind the cursor. It is also the only moment the hand
    // should close.
    '[data-sfct="piece"][data-sfct-drag]{transition:none;cursor:grabbing}',
    // Their end-of-game artwork sits on the board as its own children, not as
    // pieces, so hiding their pieces left it painted over OUR game for the whole
    // of it - the halves on both kings after a draw being the one you cannot
    // miss. Measured on a live drawn game: div.animated-effect.drawwhite.square-51
    // and .drawblack.square-58, matching getMarkings().effect
    // { e1: DrawWhite, e8: DrawBlack }. Hidden, never removed, like their pieces:
    // dropping this style tag on stop gives the finished game back intact.
    'wc-chess-board [class*="animated-effect"]:not([data-sfct]),chess-board [class*="animated-effect"]:not([data-sfct]){display:none!important}',
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
    THEIR_GAME_OVER + '{display:none!important}',
    // The result card's entrance.
    '@keyframes _sfctpop{from{opacity:0;transform:translate(-50%,-50%) scale(.92)}' +
      'to{opacity:1;transform:translate(-50%,-50%) scale(1)}}',
  ].join('');
  document.head.appendChild(bs);
}

// Engine strength: 'auto' matches the opponent you just played, anything else is
// a fixed rating ('max' = no limit at all).
//
// On 'auto' the bridge answers first: their headers name both ratings, so the
// opponent's is read rather than worked out from which row sits at the top of
// the page. The scraper stays underneath for the pages the bridge cannot reach,
// and its own 1500 stays the last word - calibrating on the wrong player is the
// failure both paths exist to avoid.
function engineStrength(setting, playerSide) {
  if (setting === 'max') return { label: 'full strength', uciElo: null };
  const rating = setting && setting !== 'auto'
    ? parseInt(setting, 10)
    : (eloFromHeaders(pageState?.headers, playerSide) ?? getOpponentElo());
  return { label: String(rating), uciElo: eloToUCIElo(rating) };
}

// Rename the opponent on the board so it is obvious who you are now playing.
// Returns a function that puts the original name back.
// A real opponent lives in Chess.com's player row, so this one lives there too:
// name, rating and face, all three saying the same thing.
//
// Only the TEXT of leaf nodes they own and the `src` of their avatar image are
// touched. Never an inserted node - that is what took the board down on
// 2026-09-22 - and never a class, which Vue diffs away and fights us over.
// opponentTextSlot() refuses any node with element children, because writing
// textContent on one of those deletes those children and hands Vue the same
// crash by another door.
// Text written into a node of theirs goes into the text node already there,
// never through textContent. textContent throws their text node away and puts
// a new one in; Vue keeps patching the one it made, now detached, so when it
// reuses that element for something else - a navigation that does not reload is
// enough - the real words land in the detached node and the page shows ours, or
// nothing. A leaf with no text node yet (never the case for the ones picked,
// which are chosen for having text) falls back to textContent.
function setPageText(el, text) {
  const node = el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE ? el.firstChild : null;
  if (node) node.nodeValue = text;
  else el.textContent = text;
}

function labelOpponentAsEngine(label, rating) {
  const undo = [];
  const write = (el, text) => {
    if (!el) return false;
    const was = el.textContent;
    setPageText(el, text);
    undo.push(() => { setPageText(el, was); });
    return true;
  };
  write(opponentTextSlot(), label);
  // Their row keeps the rating in its own box, so the name must not carry it too
  // - "Stockfish (1450)(1450)" is nobody's opponent. When there is no rating box
  //   to write, the name carries it instead, and engineLine() decides which.
  const ratingShown = !!rating && write(opponentRatingSlot(), `(${rating})`);
  if (chesscomState) chesscomState._ratingShown = ratingShown;

  const img = opponentRow()?.querySelector('img[class*="avatar"], [class*="avatar"] img');
  if (img) {
    const was = img.getAttribute('src');
    try {
      img.src = chrome.runtime.getURL('icons/icon128.png');
      undo.push(() => { if (was) img.setAttribute('src', was); });
    } catch (_) { /* no icon to serve: their face stays, which is only cosmetic */ }
  }
  return undo.length ? () => undo.forEach(f => { try { f(); } catch (_) {} }) : null;
}

function showChesscomBoard(fen, color, strengthSetting) {
  try {
    hideChesscomBoard();

    const [, fenSide, fenCastling = '-', fenEp = '-', fenHalf = '0'] = fen.split(' ');
    const sideToMove = fenSide || 'w';
    const playerSide = color === 'white' ? 'w' : 'b';
    const engineSide = playerSide === 'w' ? 'b' : 'w';
    const strength = engineStrength(strengthSetting, playerSide);

    const session = ++sessionId;
    const board = findActiveBoard();
    if (!board) { showNotice('Board not found.'); return; }
    board.style.touchAction = 'none';

    chesscomState = {
      startFen: fen, moves: [], boardData: fenToBoard(fen),
      // Plies shown while walking back with the arrow keys; null = the live position.
      viewPly: null,
      selectedSq: null, playerSide, engineSide, sideToMove, board,
      strengthSetting, finished: false,
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

    injectBoardStyle();
    syncBoardToState();
    attachPointerHandlers();
    attachKeyHandler();
    startRefreshTimer();
    chesscomState.engineLabel = strength.label;
    chesscomState._restoreOpponentName = labelOpponentAsEngine('Stockfish', strength.label);
    chesscomState._nameSlot = opponentTextSlot();
    updateStatus('');

    initEngine().then(() => {
      if (session !== sessionId || !chesscomState) return; // stopped or restarted while loading
      if (strength.uciElo) {
        postCmd('setoption name UCI_LimitStrength value true');
        postCmd(`setoption name UCI_Elo value ${strength.uciElo}`);
      }
      postCmd(enginePosition());
      chesscomState.engineLabel = strength.label;
      if (sideToMove === engineSide) engineThink();
      else { updateStatus('Your move'); requestLegalMoves(); }
    }).catch(e => {
      warn('engine init failed', e);
      if (session !== sessionId) return; // belongs to a game the user already stopped
      hideChesscomBoard();
      showNotice('Engine failed to load.');
    });
  } catch (e) {
    warn('showChesscomBoard error', e);
    showNotice('Error: ' + (e?.message || e));
  }
}

// Esc gives the finished game back. It is the only way out of a continuation now
// that the badge is gone, so it is kept apart from the pointer handlers: endGame
// runs _ptrCleanup and nulls it, and Esc has to keep working on the result card
// after that.
// The arrows walk the continuation the way Chess.com's own move list does: one
// ply back or forward, or straight to either end. Only this continuation -
// the game it started from belongs to their move list.
const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -Infinity, ArrowDown: Infinity };

function stepView(step) {
  const st = chesscomState;
  const at = st.viewPly ?? st.moves.length;
  const next = Math.max(0, Math.min(st.moves.length, at + step));
  st.viewPly = next === st.moves.length ? null : next;
  st.selectedSq = null; // a selection belongs to the live position only
  syncBoardToState();
}

// The position being shown: the live one, or a replay of the first viewPly moves.
function shownPosition(st) {
  if (st.viewPly === null) return { board: st.boardData, side: st.sideToMove };
  let board = fenToBoard(st.startFen);
  for (const uci of st.moves.slice(0, st.viewPly)) board = applyUciMove(board, uci).board;
  const first = st.startFen.split(' ')[1] === 'b' ? 'b' : 'w';
  const other = first === 'w' ? 'b' : 'w';
  return { board, side: st.viewPly % 2 === 0 ? first : other };
}

function attachKeyHandler() {
  const onKey = (e) => {
    if (e.target?.closest?.('input,textarea,[contenteditable]')) return; // their chat
    if (e.key in ARROW_STEPS) {
      // Swallowed even when there is nowhere to go: left to them, the arrows walk
      // Chess.com's own board, which is hidden under ours - nothing visible moves.
      if (!chesscomState || document.querySelector('[data-sfct="promo"]')) return;
      e.preventDefault(); e.stopPropagation();
      stepView(ARROW_STEPS[e.key]);
      return;
    }
    if (e.key !== 'Escape') return;
    if (cancelPromotion()) { e.preventDefault(); e.stopPropagation(); return; }
    if (!chesscomState) return;           // nothing of ours is up: their Esc is theirs
    e.preventDefault(); e.stopPropagation();
    dismissResult();
  };
  window.addEventListener('keydown', onKey, { capture: true });
  chesscomState._keyCleanup = () => window.removeEventListener('keydown', onKey, { capture: true });
}

function hideChesscomBoard() {
  if (chesscomState?._ptrCleanup) chesscomState._ptrCleanup();
  if (chesscomState?._keyCleanup) chesscomState._keyCleanup();
  if (chesscomState?._refreshTimer) clearInterval(chesscomState._refreshTimer);
  releaseColumnFoot();
  // Dropping this un-hides Chess.com's own pieces again.
  document.getElementById('sfct-board-style')?.remove();
  chesscomState?._restoreOpponentName?.();
  if (chesscomState?.board) chesscomState.board.style.touchAction = '';
  // Drop our overlay pieces/dots so the board shows Chess.com's again.
  // _sfctCleanup first: a card removed without it leaves its resize/scroll
  // listeners on window, holding the detached node alive.
  document.querySelectorAll('[data-sfct]').forEach(el => { el._sfctCleanup?.(); el.remove(); });
  sessionId++;
  teardownEngine();
  _perftMoves = null;
  _legalMoves = null;
  chesscomState = null;
  publishPhase(); // the phase is a fact about a game that no longer exists
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
  hideChesscomBoard(); // its [data-sfct] sweep closes the card, listeners first
}

function rematch() {
  const st = chesscomState;
  if (!st) return;
  const { startFen, playerSide, strengthSetting } = st;
  hideChesscomBoard(); // its [data-sfct] sweep closes the card, listeners first
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

// Chess.com writes .highlight's paint INLINE on every square it marks - the class
// carries the geometry, none of the colour. Measured side by side on one live
// board: their marked square is background-color rgb(255,255,51) at opacity .5,
// and ours, wearing the class and nothing else, came out the same yellow at
// opacity 1 - the same colour at twice the strength, which is exactly what a
// selected piece looked like.
//
// Their own square is sampled when the board has one, so a board theme that
// changes the colour is followed rather than overridden; the fallback is their
// own value, for a board with nothing marked on it yet.
const HIGHLIGHT_OPACITY = '.5';

function highlightPaint(board) {
  const st = chesscomState;
  // Their own answer first: the board theme states its highlight colour and the
  // strength it is drawn at, so there is nothing to guess and nothing to sample.
  const theme = pageState?.theme;
  if (theme?.highlightHex) {
    return 'background-color:' + theme.highlightHex +
      ';opacity:' + (theme.highlightOpacity ?? HIGHLIGHT_OPACITY);
  }
  // Settled once and remembered. Sampling on every render looked fine until
  // their last-move highlight was not on the board at that instant - picking a
  // piece up and putting it straight back is enough - and then the class's own
  // default took over: a YELLOW square on a green board, which is not a colour
  // this extension is entitled to choose.
  if (st?._paint) return st._paint;
  const theirs = board.querySelector('.highlight:not([data-sfct])');
  if (!theirs) return 'opacity:' + HIGHLIGHT_OPACITY;
  const s = getComputedStyle(theirs);
  const paint = 'background-color:' + s.backgroundColor + ';opacity:' + (s.opacity || HIGHLIGHT_OPACITY);
  if (st) st._paint = paint;
  return paint;
}

// Our pieces stand above the selection (2) and the check mark (3), below the
// legal-move dots (6). Their `piece` class computes z-index auto on a live
// board, so this inline value is the only thing holding the piece up.
const PIECE_Z = '5';

function makePieceNode(pc) {
  const el = document.createElement('div');
  el.setAttribute('data-sfct', 'piece');
  el.dataset.pc = pc;
  el.className = `piece ${pc === pc.toUpperCase() ? 'w' : 'b'}${pc.toLowerCase()}`;
  el.style.cssText = 'position:absolute;top:0;left:0;width:12.5%;height:12.5%;z-index:' + PIECE_Z;
  return el;
}

// Restart Chess.com's grow / wiggle / shrink on the checked king.
function replayCheck() {
  const el = document.querySelector('[data-sfct="check"] .sfct-check-el');
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

function syncBoardToState() {
  if (!chesscomState?.board || _sfSyncing) return;
  _sfSyncing = true;
  try {
    const st = chesscomState;
    const { board, selectedSq } = st;
    const { board: boardData, side: shownSide } = shownPosition(st);

    // Cleared FIRST, before a single line below can throw. This function has one
    // try/finally and no catch, and it is the only place in the file that removes
    // these: an exception halfway down used to skip the removal and leave the
    // selected square and its dots up for the rest of the game.
    //
    // Cleared across the document rather than under this board, because the board
    // can be swapped out from under us - by the refresh watchdog, or by
    // currentBoard() - and nothing ever looks at the old node again.
    document.querySelectorAll('[data-sfct="sel"],[data-sfct="dot"]').forEach(el => el.remove());

    // And anything of ours still standing on a board we have stopped drawing on.
    // currentBoard() and the refresh watchdog both reassign chesscomState.board
    // when Chess.com replaces the node, and neither ever looks at the old one
    // again - so its pieces stay on screen while a fresh set is painted here.
    document.querySelectorAll('[data-sfct="piece"],[data-sfct="check"]')
      .forEach(el => { if (!board.contains(el)) el.remove(); });

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

    const nodes = new Map();
    ours(board, 'piece').forEach(el => nodes.set(el.dataset.sq, el));

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

    // A king in check keeps the red square while the check stands. The node is
    // REUSED, never rebuilt: recreating it restarts Chess.com's grow/wiggle, so
    // it replayed on every re-render — picking a piece up made the king twitch.
    // It only plays when the check first appears, or moves to another king.
    const checkedKing = isKingAttacked(boardData, shownSide) && kingSquare(boardData, shownSide);
    let mark = ours(board, 'check')[0] || null;
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
    if (selectedSq) {
      const sel = document.createElement('div');
      sel.setAttribute('data-sfct', 'sel');
      sel.className = 'highlight';
      sel.style.cssText = SQUARE_BOX + 'z-index:2;' + highlightPaint(board);
      place(sel, selectedSq);
      board.appendChild(sel);
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
  } catch (e) {
    // The markers were already cleared at the top, so a throw here leaves a
    // board that is MISSING what it should draw - which the next sync puts back
    // - instead of one still wearing the last move's selection. Swallowed on
    // purpose: this runs inside every move, and letting it escape aborted the
    // rest of the move sequence.
    warn('syncBoardToState', e);
  } finally { _sfSyncing = false; }
}

// ── Pointer handling ─────────────────────────────────────────────────────────
// Below this, a press is a click. Above it, the piece has been picked up.
const DRAG_THRESHOLD_PX = 4;

function attachPointerHandlers() {
  let dragStart = null;
  // The piece being carried, where the finger first touched it, and whether it
  // has travelled far enough to count as carried at all.
  let dragEl = null, dragFrom = null, dragMoved = false, selectedOnDown = false;
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
  const onDown = (e) => {
    if (e.target?.closest?.('#sfctplay-btn, #sfct-result')) return;
    if (e.target?.closest?.('[data-sfct="promo"]')) return; // the picker handles its own clicks
    if (cancelPromotion()) { e.preventDefault(); e.stopPropagation(); return; }
    const b = currentBoard();
    if (!b || !inside(b, e)) return;
    // Looking at an earlier position: this press only brings the board back to
    // the present. Moving from a past position is not a thing this game does.
    if (chesscomState.viewPly !== null) {
      e.preventDefault(); e.stopPropagation();
      stepView(Infinity);
      return;
    }
    const sq = computeSquareFromClick(b, e.clientX, e.clientY);
    if (!sq) return;
    dragStart = sq;
    // Pick the piece up, but only ever one of yours: lifting the engine's piece
    // would show a move nobody is allowed to make.
    const pc = chesscomState.boardData[sq];
    const mine = pc && (pc === pc.toUpperCase() ? 'w' : 'b') === chesscomState.playerSide;
    dragEl = mine ? [...ours(b, 'piece')].find(el => el.dataset.sq === sq) || null : null;
    dragFrom = { x: e.clientX, y: e.clientY };
    dragMoved = false;
    selectedOnDown = false;
    if (dragEl) {
      dragEl.dataset.sfctBase = dragEl.style.transform;
      try { b.setPointerCapture?.(e.pointerId); } catch (_) {}
      // Selected on the way DOWN, the way their board does it, so the legal
      // squares are lit while the piece is in the air rather than only after it
      // has landed. Carrying a piece with nowhere marked to put it is guesswork.
      if (chesscomState.selectedSq !== sq) { handleSquareClick(sq); selectedOnDown = true; }
    }
    e.preventDefault(); e.stopPropagation();
  };

  // The middle of the gesture, which did not exist: down, then nothing, then up.
  // The piece now travels with the finger by carrying a pixel offset on top of
  // the percentage transform place() gave it, so the square it belongs to is
  // never forgotten and the release can simply drop the offset.
  const onMove = (e) => {
    if (!dragStart || !dragEl) return;
    const dx = e.clientX - dragFrom.x, dy = e.clientY - dragFrom.y;
    if (!dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!dragMoved) {
      dragMoved = true;
      dragEl.dataset.sfctDrag = '1';
      // Above every other piece, and it has to be said this loudly. Every piece
      // of ours carries z-index 5 inline (PIECE_Z), which a stylesheet rule of
      // ours said 9 against and lost. With the z-index equal, DOM order decides,
      // and the piece being carried was the 50th of 64: the fourteen after it
      // painted straight over it.
      dragEl.style.setProperty('z-index', '20', 'important');
    }
    dragEl.style.transform = `${dragEl.dataset.sfctBase} translate(${dx}px,${dy}px)`;
    // No destination square is painted here on purpose. Chess.com's board does
    // carry a `div.hover-square` of its own, and reusing it was the plan - but
    // measured mid-drag on a live board it paints NOTHING: visibility goes to
    // visible and that is all, with a transparent background, `border: none` and
    // `box-shadow: none`. The ring you see under their dragged piece is drawn by
    // their WebGL renderer, not by that node, which is a hit area. (It also moves
    // in pixels, `matrix(1,0,0,1,344,344)`, where everything here moves in
    // percentages.) The legal-move dots already say where the piece may land.
  };

  // Put the carried piece back where the board says it is. Called on release and
  // on cancel, and it never decides anything about the move itself.
  const dropPiece = () => {
    if (dragEl) {
      dragEl.style.transform = dragEl.dataset.sfctBase || dragEl.style.transform;
      // Back to PIECE_Z, never removed: without it the piece computes auto and
      // the selected square's highlight paints over the piece standing on it.
      dragEl.style.setProperty('z-index', PIECE_Z);
      delete dragEl.dataset.sfctBase;
      delete dragEl.dataset.sfctDrag;
    }
    dragEl = null; dragMoved = false;
  };
  const onUp = (e) => {
    if (!dragStart) return;
    const b = currentBoard();
    const carried = dragMoved;
    dropPiece();
    if (!b || !inside(b, e)) { dragStart = null; syncBoardToState(); return; }
    const endSq = computeSquareFromClick(b, e.clientX, e.clientY);
    if (!endSq) { dragStart = null; syncBoardToState(); return; }
    e.preventDefault(); e.stopPropagation();
    // A press that never travelled is a click, whatever square it ended on -
    // a finger that slides three pixels off the square it started on was still
    // pointing at that square.
    // A press that selected on the way down has already done its work; letting
    // the click run again would toggle the selection straight back off.
    if (!carried || endSq === dragStart) { if (!selectedOnDown) handleSquareClick(dragStart); }
    else handleDragMove(dragStart, endSq);
    dragStart = null;
    syncBoardToState(); // a refused move leaves the piece under the finger otherwise
  };
  const onCancel = () => { dropPiece(); dragStart = null; syncBoardToState(); };
  document.body.addEventListener('pointerdown', onDown, { capture: true });
  document.body.addEventListener('pointermove', onMove, { capture: true });
  document.body.addEventListener('pointerup', onUp, { capture: true });
  document.body.addEventListener('pointercancel', onCancel, { capture: true });
  chesscomState._ptrCleanup = () => {
    document.body.removeEventListener('pointerdown', onDown, { capture: true });
    document.body.removeEventListener('pointermove', onMove, { capture: true });
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
    // board node — put them back.
    if (!ours(cur, 'piece').length) syncBoardToState();
    // Their row redraws itself - a clock tick is enough - and takes our text with
    // it. Written again here rather than watched for: no observer, no new timer,
    // and never a string we wrote ourselves treated as theirs.
    const slot = chesscomState._nameSlot;
    if (slot && chesscomState._nameWritten && slot.textContent !== chesscomState._nameWritten) {
      setPageText(slot, chesscomState._nameWritten);
    }
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
// Their promotion window, built the way their chessboard bundle builds it
// (read off chessboard-*.js on a live page): a div.promotion-window holding an
// <i class="close-button icon-font-chess x"> and four div.promotion-piece, q n r b,
// as direct children. It hangs off the promotion edge (.top), is shifted to the
// file with translateX, and opens through their own .dynamic clip-path animation
// by adding promotion-window--visible after a reflow. Every rule it wears is
// theirs - the white column, the 3px corners, the shadow, the scale(1.15) under
// the pointer, the piece sprites (scoped to the board host it sits inside).
function askPromotion(to, side, onPick) {
  const st = chesscomState;
  // No board to hang the picker off: refuse the move rather than choose a
  // piece on the player's behalf. A queen nobody asked for is worse than a
  // move that did not happen, which they can simply play again.
  if (!st?.board) { updateStatus('Cannot show the promotion picker'); return; }
  document.querySelectorAll('[data-sfct="promo"]').forEach(el => el.remove());
  const flipped = isFlipped(st.board);
  const file = (flipped ? 'hgfedcba' : 'abcdefgh').indexOf(to[0]) + 1;
  // Their rule: White promotes at the top unless the board is flipped.
  const top = flipped ? side === 'b' : side === 'w';
  const win = document.createElement('div');
  win.setAttribute('data-sfct', 'promo');
  win.className = 'promotion-window dynamic' + (top ? ' top' : '');
  win.style.transform = `translateX(${(file - 1) * 100}%)`;
  // Their window sits at z 2 among their own pieces; ours stand at PIECE_Z and
  // the dots at 6, so it has to be lifted above both.
  win.style.zIndex = '9';

  // Chosen on pointerdown, as theirs is - and stopped there, so the board's own
  // press handler never sees the press.
  const onPress = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
  const close = document.createElement('i');
  close.className = 'close-button icon-font-chess x';
  close.setAttribute('data-sfct', 'promo-close');
  close.addEventListener('pointerdown', onPress(cancelPromotion));
  win.appendChild(close);
  for (const p of ['q', 'n', 'r', 'b']) {
    const cell = document.createElement('div');
    // Marked as ours: the style that hides Chess.com's pieces keys off the
    // absence of data-sfct, and "promotion-piece" matches its [class*="piece"].
    cell.setAttribute('data-sfct', 'promo-piece');
    cell.className = `promotion-piece ${side}${p}`;
    cell.addEventListener('pointerdown', onPress(() => { win.remove(); onPick(p); }));
    win.appendChild(cell);
  }
  st.board.appendChild(win);
  void win.offsetHeight; // their reflow, so the clip-path opens rather than appears
  win.classList.add('promotion-window--visible');
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
  st.viewPly = null; // its reply is shown, wherever you were looking
  st.sideToMove = st.playerSide;
  recordMove(st, res.moved);
  st.turnStart = Date.now();
  syncBoardToState();
  updateStatus('Your move');
  postCmd(enginePosition());
  requestLegalMoves();
}

// ── What the opponent's row says ─────────────────────────────────────────────
// There is no status pill and no banner any more. A real game has neither, and
// the banner had a second sin: being `position:fixed` and ours, it swallowed the
// first click of every continuation, because our own pointer handlers skip our
// own UI on purpose.
const NOTICE_MS = 6000;

function engineLine(st) {
  const label = (st?.engineLabel && !st._ratingShown) ? `Stockfish (${st.engineLabel})` : 'Stockfish';
  return st?.status ? `${label} · ${st.status}` : label;
}

function updateStatus(text) {
  const st = chesscomState;
  publishPhase();
  if (!st) return;
  st.status = text || '';
  const el = st._nameSlot;
  if (!el) return; // their row has nothing safe to write: the game still plays
  const line = engineLine(st);
  if (el.textContent !== line) setPageText(el, line);
  st._nameWritten = line;
}

// The phase, on <html>, where a test can wait for it and nobody can see it.
// Derived from the game's own state rather than from the words on screen, so the
// two can never drift apart - and so there is something precise to wait for now
// that the visible text says as little as a real opponent's name does.
function publishPhase() {
  const el = document.documentElement;
  const st = chesscomState;
  if (!st) { delete el.dataset.sfctPhase; return; }
  el.dataset.sfctPhase = st.finished ? 'over'
    : !workerReady ? 'loading'
    : st.sideToMove === st.playerSide ? 'your-move' : 'thinking';
}

// The few things that are worth interrupting for - no board, no position, no
// engine - say themselves in the opponent's row and then get out of the way.
// Nothing of ours is added to the page to say them.
function showNotice(text) {
  warn(text);
  const el = chesscomState?._nameSlot || opponentTextSlot();
  if (!el) return;
  const was = el.textContent;
  setPageText(el, text);
  setTimeout(() => {
    try { if (el.textContent === text) setPageText(el, chesscomState ? engineLine(chesscomState) : was); }
    catch (_) {}
  }, NOTICE_MS);
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

// Chess.com's own glyphs, copied off their live pages (svg[data-glyph]) - the
// ↻ beside their New Game button, their back chevron, their play triangle, the
// modal's close cross.
const GLYPHS = {
  'arrow-spin-redo': 'm11 22.47c-6.07 0-10.5-4.87-10.5-10.47 0-5.93 4.8-10.5 10.5-10.5 2.7 0 5.37 1.03 7.43 3.07l1.47 1.47-2.13 2.13-1.47-1.47c-1.47-1.47-3.4-2.2-5.3-2.2-4.13 0-7.5 3.37-7.5 7.5s3.37 7.5 7.5 7.5c2.57 0 4.53-1.17 6.03-3 .6-.83 1.17-.93 2.03-.37l.1.1c.87.57.97 1.13.37 1.97-2.1 2.63-4.9 4.27-8.53 4.27zm11.43-17.44.63 5.13c.13 1.03-.23 1.4-1.27 1.27l-5.17-.63c-.9-.1-1.03-.57-.4-1.2l5-5c.63-.63 1.1-.5 1.2.43zm0 0',
  'arrow-chevron-left': 'm16.27 21.13-.07.07c-1.13 1.13-1.6 1.13-2.73 0l-6.4-6.37c-1.73-1.77-1.73-3.9 0-5.67l6.4-6.37c1.13-1.13 1.6-1.13 2.73 0l.07.07c1.13 1.13 1.13 1.6 0 2.73l-6.37 6.4 6.37 6.4c1.13 1.13 1.13 1.6 0 2.73zm0 0',
  'media-control-play': 'm20.5 12.8-12.73 8.73c-1.27.9-1.77.63-1.77-.93v-17.27c0-1.53.5-1.8 1.77-.9l12.73 8.77c.83.57.83 1.03 0 1.6zm0 0',
  'mark-cross': 'm6.1 20.77c-1.13 1.13-1.6 1.13-2.73 0l-.13-.13c-1.13-1.13-1.13-1.6 0-2.73l5.97-5.9-5.97-6c-1.13-1.13-1.13-1.6 0-2.73l.13-.1c1.13-1.13 1.6-1.13 2.73 0l5.93 6 5.93-5.97c1.13-1.13 1.6-1.13 2.73 0l.13.13c1.13 1.13 1.13 1.6 0 2.73l-5.97 5.93 5.8 5.9c1.13 1.13 1.13 1.6 0 2.73l-.1.13c-1.13 1.13-1.6 1.13-2.73 0l-5.8-5.93zm0 0',
};

function glyph(name, size) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.className = `cc-icon-glyph_57606db cc-icon-size-${size}_57606db`;
  span.innerHTML = '<svg data-glyph="' + name + '" aria-hidden="true" viewBox="0 0 24 24" ' +
    'xmlns="http://www.w3.org/2000/svg"><path d="' + GLYPHS[name] + '"></path></svg>';
  return span;
}

// Their button, not an imitation: the classes their v6 game-over modal uses,
// measured off a live page - cc-button-x-large for the one green call to action,
// with a 24px glyph in front of the words. Secondary buttons are the same shape
// in their dark secondary paint.
function cardButton(text, primary, glyphName) {
  const b = document.createElement('button');
  // game-over-primary-cta-… is where their modal's 16px side inset comes from.
  b.className = 'cc-button-component cc-button-x-large game-over-primary-cta-game-over-primary-cta ' +
    (primary ? 'cc-button-primary cc-bg-primary' : 'cc-button-secondary cc-bg-secondary');
  b.setAttribute('data-sfct', 'card-part');
  // Theirs is an <a>; a <button> alone keeps the system's appearance:auto, the
  // one computed property that differed from their Game Review button.
  b.style.appearance = 'none';
  if (glyphName) {
    const icon = glyph(glyphName, 24);
    icon.classList.add('cc-button-icon');
    b.appendChild(icon);
  }
  b.append(' ' + text);
  return b;
}

// A copy of their v6 game-over modal, node for node. Built rather than cloned off
// the live one (see showResultModal). Every class below was read off a live page:
//
//   div.game-over-modal-shell-container
//     div.game-over-modal-shell-content.game-over-modal-shell-v6
//       div.game-over-modal-header-component …-extraSpace …-is-v6-modal-enabled
//         div.game-over-modal-header-inner > div.game-over-modal-header-header
//           div.game-over-modal-title-component …-title-is-v6-modal-enabled
//           div.game-over-modal-subtitle-component …-subtitle-v6
//             div.game-over-modal-subtitle-first-line
//         button.cc-close-button-component … .game-over-modal-header-close
//       div.game-over-modal-shell-buttons
//
// It stays a child of <body> and never enters their component tree: inserting a
// node of ours into one of their Vue components took the whole board down once.
// Every node is marked as ours - the rule that hides their modal while we play
// narrows on that attribute, and marking only the root hid the card's insides.
function makeCard(title, subtitle) {
  const el = (cls, parent) => {
    const n = document.createElement('div');
    n.className = cls;
    n.setAttribute('data-sfct', 'card-part');
    parent?.appendChild(n);
    return n;
  };
  const card = el('game-over-modal-shell-container');
  card.id = 'sfct-result';
  card.setAttribute('data-sfct', 'result');
  Object.assign(card.style, {
    // 400px is their modal's width on a live desktop page; it gets it from the
    // layout around it, which a card parked in <body> does not have.
    position: 'fixed', zIndex: '999998', width: '400px', maxWidth: '92vw',
    animation: '_sfctpop .18s ease-out',
  });
  const content = el('game-over-modal-shell-content game-over-modal-shell-v6', card);
  const head = el('game-over-modal-header-component game-over-modal-header-extraSpace ' +
    'game-over-modal-header-is-v6-modal-enabled', content);
  const header = el('game-over-modal-header-header', el('game-over-modal-header-inner', head));
  el('game-over-modal-title-component game-over-modal-title-is-v6-modal-enabled', header).textContent = title;
  if (subtitle) {
    const sub = el('game-over-modal-subtitle-component game-over-modal-subtitle-v6', header);
    el('game-over-modal-subtitle-first-line', sub).textContent = subtitle;
  }
  const close = document.createElement('button');
  close.setAttribute('aria-label', 'Close');
  close.setAttribute('data-sfct', 'card-part');
  close.className = 'cc-close-button-component cc-close-button-medium cc-close-button-subtle ' +
    'cc-transition-color-hover game-over-modal-header-close';
  el('cc-close-button-bg', close);
  const x = glyph('mark-cross', 16);
  x.classList.add('cc-close-button-icon');
  close.appendChild(x);
  close.onclick = dismissResult;
  head.appendChild(close);
  const body = el('game-over-modal-shell-buttons', content);
  return { card, body };
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

function showResultModal(title, subtitle, opts) {
  const old = document.getElementById('sfct-result');
  old?._sfctCleanup?.(); // never orphan its resize/scroll listeners
  old?.remove();
  // Always the copy of their modal, never a clone of the live one: a clone
  // carried their Game Review star onto our button and their empty ad box
  // (game-over-ad-sidecar, 300x282) beside the card.
  const { card, body } = makeCard(title, subtitle || '');
  if (opts?.rematch !== false) {
    const again = cardButton('Play again vs Stockfish', true, 'arrow-spin-redo');
    again.onclick = rematch;
    body.appendChild(again);
  }
  const back = cardButton('Back to Chess.com', false, 'arrow-chevron-left');
  back.onclick = dismissResult;
  body.appendChild(back);
  showCard(card);
}

// ── Inject the "Continue vs Computer" button ─────────────────────────────────
// Docked under their result card, or at the foot of the move-list column when
// there is none. With neither on the page it is not offered at all.

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
    // No question is asked any more. A card of ours that stops the page to ask
    // whose move it is belongs to an extension, not to a game - and the trigger
    // is not offered at all on a page where the side to move cannot be settled,
    // so this branch is only reached if the page changed under the click.
    showNotice('Cannot tell whose move it is.');
  });
}

// Capture the position on the board — whichever move in the list you are
// looking at — and hand it to the engine.
function startContinuation(board, side, strength, fenFromPage) {
  const fen = fenFromPage || getFEN(board, side);
  if (!fen) { showNotice('Position not found.'); return; }
  removeTrigger(); // the trigger goes away while you play
  showChesscomBoard(fen, bridgePlayerColor() || getPlayerColor(), strength);
}

// The same button the result card uses - their secondary x-large, with their
// play glyph - so it sits under their Game Review as one more of their buttons.
function makeTriggerButton() {
  const btn = cardButton('Continue vs Computer', false, 'media-control-play');
  btn.id = 'sfctplay-btn';
  // Not part of a game: it outlives every stop, so it must not carry the mark
  // the teardown sweeps. And without that mark, a class with "game-over" in it
  // would make isGameOver() see the finished game in our own button - so the
  // 16px side inset their cta class gives is the dock's padding instead.
  btn.removeAttribute('data-sfct');
  btn.classList.remove('game-over-primary-cta-game-over-primary-cta');
  btn.style.width = '100%'; // their flex column stretches theirs; our dock is a block
  btn.onclick = onContinueClick;
  return btn;
}

// Their modal's card: the shell content carries the paint (background, 10px
// corners, a 1px inset edge) and the 16px under the last button.
const modalShell = (modal) => modal.querySelector('.game-over-modal-shell-content') || modal;

// A dock that reads as the bottom of THEIR card: it starts where their last
// button ends, covers their bottom padding and rounded corners, and redraws
// both below our button - their 8px button gap above it, their 16px under it,
// their radius, their inset edge on the three sides that are outside. Every
// value is read off their card as it computes, so a restyle carries over.
function dockUnderModal(dock, modal) {
  const shell = modalShell(modal);
  const cs = getComputedStyle(shell);
  const row = shell.querySelector('.game-over-modal-shell-buttons');
  const gap = row ? getComputedStyle(row).rowGap : '8px';
  const edge = (cs.boxShadow.match(/(rgba?\([^)]*\))[^,]*inset/) || [])[1];
  const radius = cs.borderBottomLeftRadius;
  Object.assign(dock.style, {
    background: cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)
      ? cs.backgroundColor : solidBackground(modal),
    padding: `${gap === 'normal' ? '8px' : gap} 16px ${cs.paddingBottom}`,
    borderRadius: `0 0 ${radius} ${radius}`,
    boxShadow: edge ? `inset 1px 0 0 ${edge}, inset -1px 0 0 ${edge}, inset 0 -1px 0 ${edge}` : 'none',
  });
}

// Can this page tell us whose move it is? If not, no trigger is offered: the
// alternative was a card of ours asking the question, and nothing of ours
// interrupts the page any more. Computed here, where it runs once per injection,
// and never on the 200 ms poll.
function sideIsKnown() {
  if (pageState?.fen) return true;
  const board = findActiveBoard();
  return !!(board && readSideToMove(board));
}

function injectButtons() {
  if (document.getElementById('sfctplay-btn')) return;
  if (!sideIsKnown()) return;

  // Chess.com's result card when it is on screen, otherwise the column holding
  // the move list. Coming back to a finished game later — which is when you
  // actually sit and walk the moves — there is no modal to dock under, and a
  // button floating over the board reads as something stuck to the window
  // rather than something belonging to the game.
  const modal = findGameOverModal();
  const anchor = modal || sidebarPanel();
  // Nothing of ours floats over the page any more. With neither their result
  // card nor their move-list column to belong to, there is nowhere this button
  // can sit that looks like part of the site - so it is not offered, the same
  // way it is not offered where the side to move cannot be settled. A green pill
  // stuck to the bottom of the window is exactly the kind of surface that was
  // just deleted everywhere else.
  if (!anchor) return;

  // Line the trigger up under the anchor but keep the node in <body>: Chess.com
  // renders both surfaces with Vue, and inserting into them made Vue throw
  // "insertBefore … not a child of this node" on its next patch.
  const btn = makeTriggerButton();

  // A strip that continues the surface above it: same width, same background,
  // rounded off at the bottom, sitting flush against it, so the two read as one
  // panel instead of as a button someone dropped on the page.
  const dock = document.createElement('div');
  dock.id = 'sfctplay-dock';
  dock.dataset.anchor = modal ? 'modal' : 'panel';
  Object.assign(dock.style, { position: 'fixed', zIndex: '999997', boxSizing: 'border-box' });
  if (modal) {
    dockUnderModal(dock, modal);
  } else {
    // The foot of their move-list column: the column's own paint, their 16px
    // around the button.
    Object.assign(dock.style, { background: solidBackground(anchor), padding: '16px' });
  }
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

// Keep the dock aligned to whatever it was anchored to — the result card or the
// move-list column — at that anchor's exact width, so the two keep reading as
// one panel through scrolls and resizes.
//
// The two anchors need opposite treatment. A result card is a floating box with
// empty page under it, so the dock hangs BELOW it. The move-list column runs the
// full height of the window, so there is no "below" to hang in: the dock sits at
// the bottom of the column as seen, inside the column's own width, reading as
// its last row. Handing over to a floating button when the column ran past the
// fold meant handing over every single time, since it always does.
function alignTrigger() {
  const dock = document.getElementById('sfctplay-dock');
  if (!dock) return;
  // Their result modal arrives AFTER the game reads as over, and the trigger is
  // placed on the first frame that reads that way. Timed on a live draw: the
  // game was over at 49 ms, we docked to the move-list column at 301 ms, and
  // their modal only rendered at 557 ms - so the button sat at the foot of the
  // column while the popup covering the board had none. It never moved, because
  // injectButtons() returns early once the button exists.
  //
  // So the anchor is a decision that gets revisited, not one taken once: the
  // moment a modal is there, the trigger moves into it. The opposite case was
  // always handled - a modal that goes away drops the trigger, and the next poll
  // re-docks it to the column.
  if (dock.dataset.anchor === 'panel' && findGameOverModal()) {
    removeTrigger();
    injectButtons();
    return;
  }
  const modal = dock.dataset.anchor === 'panel' ? null : findGameOverModal();
  const anchor = modal ? modalShell(modal) : sidebarPanel();
  if (!anchor) { removeTrigger(); return; }
  const r = anchor.getBoundingClientRect();
  if (!r.width) return;
  dock.style.left = r.left + 'px';
  dock.style.width = r.width + 'px';
  if (modal) {
    // Over their bottom padding, so their rounded corners are under ours.
    dock.style.top = (r.bottom - (parseFloat(getComputedStyle(anchor).paddingBottom) || 0)) + 'px';
    return;
  }
  const h = dock.getBoundingClientRect().height || 64;
  // Ask the column to be that much shorter, so the bar lands in free space
  // instead of over the icons at its foot. Falls back to covering them if the
  // column will not shrink.
  reserveColumnFoot(anchor, h);
  dock.style.top = Math.max(0, Math.min(r.bottom, window.innerHeight) - h) + 'px';
}

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
  if (!extensionAlive()) { clearInterval(pollTimer); return; }
  // SPA navigation: Chess.com swaps pages without a reload. Checked here, on the
  // same tick, rather than on a timer of its own.
  const now = pageKey();
  if (now !== lastPage) {
    lastPage = now;
    removeTrigger();
    hideChesscomBoard();
  }
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
  hideChesscomBoard();
});
