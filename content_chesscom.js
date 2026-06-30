// Chess.com content script for Stockfish Continue to Play.
// After a game ends, injects a "Continue vs Computer" button. Clicking it hides
// the game-over modal and lets you keep playing the final position vs Stockfish
// on the original Chess.com board. The engine runs in a Web Worker; correctness
// (castling, en-passant, 50-move, repetition) is delegated to Stockfish by
// replaying the move history with `position fen <start> moves …`.
//
// Pure helpers live in lib/chess-core.js (logic) and lib/chess-dom.js (scraping),
// loaded before this file by the manifest. They are referenced here as globals.

const DEBUG = true; // diagnostic build — set back to false once injection is confirmed
function log(...args) { if (DEBUG) console.log('[SF+]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[SF+]', ...args); }

// One-line load banner (always on): confirms the content script injected and
// reveals the URL it matched — the fastest way to tell "script not running" from
// "DOM selectors stale". Quieted together with DEBUG once things work.
console.log('[SF+] content script loaded — v3.0.0 —', location.href);

const ENGINE_DEPTH = 12;
const ENGINE_INIT_TIMEOUT_MS = 15000;
const REFRESH_INTERVAL_MS = 1000;
const POLL_INTERVAL_MS = 200;
const NAV_POLL_INTERVAL_MS = 1000;
const BANNER_TIMEOUT_MS = 15000;

let lastUrl = location.href;

// ── State ───────────────────────────────────────────────────────────────────
// chesscomState = { startFen, moves[], boardData, selectedSq, playerSide,
//                   engineSide, sideToMove, board, _ptrCleanup, _refreshTimer }
let chesscomState = null;
let _perftMoves = null; // null = idle, [] = collecting `go perft 1` output
let _legalMoves = null; // UCI legal moves for the side to move, or null

// ── Stockfish engine (Web Worker) ───────────────────────────────────────────
let sfWorker = null;
let workerReady = false;
let cmdQueue = [];
let initPromise = null;

// Terminate the worker and reset all engine state so the next init starts clean.
function teardownEngine() {
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
        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        sfWorker = new Worker(blobUrl);
        URL.revokeObjectURL(blobUrl);
        sfWorker.onmessage = onEngineMessage;
        sfWorker.onerror = (e) => {
          warn('worker error', e);
          if (!settled) { fail(e); return; }
          // Crashed mid-game — full teardown so overlays/handlers don't linger.
          if (chesscomState) endGame('Engine crashed — click Continue to retry');
          else teardownEngine();
        };
        sfWorker.postMessage('uci');
        setTimeout(() => { if (!workerReady) fail(new Error('Engine init timeout')); }, ENGINE_INIT_TIMEOUT_MS);
        // resolve happens in onEngineMessage on 'readyok'
        initEngine._resolve = () => { if (!settled) { settled = true; resolve(); } };
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
  if (data.startsWith('bestmove')) {
    const move = data.split(' ')[1];
    onEngineMove(move && move !== '(none)' ? move : null);
    return;
  }
  // Perft output: legal-move lines, then a "Nodes searched:" terminator.
  if (_perftMoves !== null) {
    const pm = parsePerftMove(data);
    if (pm) { _perftMoves.push(pm); return; }
    if (data.startsWith('Nodes searched:')) {
      _legalMoves = _perftMoves || [];
      _perftMoves = null;
      if (_legalMoves.length === 0) { endGame('Game over — no legal moves (checkmate or stalemate)'); return; }
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

function engineThink() {
  updateStatus('Stockfish thinking…');
  postCmd('go depth ' + ENGINE_DEPTH);
}

function requestLegalMoves() {
  _legalMoves = null;
  _perftMoves = [];
  postCmd('go perft 1');
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
  s.textContent = [
    '.game-over-modal-shell', '.game-over-modal-component', '.game-over-modal-content',
    '.game-over-buttons-component', '.game-over-container', '[data-cy="game-over-dialog"]',
    '.game-result-component', '[class*="game-over-modal"]', '.board-modal-overlay',
  ].join(',') + '{display:none!important}';
  document.head.appendChild(s);
}

// ── Show / hide the inline board ─────────────────────────────────────────────
function injectBoardStyle() {
  if (document.getElementById('sfct-board-style')) return;
  const bs = document.createElement('style');
  bs.id = 'sfct-board-style';
  bs.textContent = [
    '.sfct-sel{box-shadow:inset 0 0 0 3px #ffd700,0 0 12px rgba(255,215,0,.5);border-radius:4px}',
    '.sfct-dot::after{content:"";position:absolute;width:28%;height:28%;border-radius:50%;background:rgba(0,0,0,.18);top:36%;left:36%}',
  ].join('');
  document.head.appendChild(bs);
}

function showChesscomBoard(fen, color) {
  try {
    hideChesscomBoard();
    removeGameOverModal();

    const sideToMove = fen.split(' ')[1] || 'w';
    const playerSide = color === 'white' ? 'w' : 'b';
    const engineSide = playerSide === 'w' ? 'b' : 'w';
    const uciElo = eloToUCIElo(getOpponentElo());

    const board = findActiveBoard();
    if (!board) { showBanner('Board not found.'); return; }
    board.style.touchAction = 'none';

    chesscomState = {
      startFen: fen, moves: [], boardData: fenToBoard(fen),
      selectedSq: null, playerSide, engineSide, sideToMove, board,
    };

    injectBoardStyle();
    syncBoardToState();
    attachPointerHandlers();
    startRefreshTimer();
    showStatusBadge(sideToMove === 'w' ? 'White to move' : 'Black to move');

    initEngine().then(() => {
      postCmd('setoption name UCI_LimitStrength value true');
      postCmd(`setoption name UCI_Elo value ${uciElo}`);
      postCmd(enginePosition());
      if (sideToMove === engineSide) engineThink();
      else { updateStatus('Your move'); requestLegalMoves(); }
    }).catch(e => { warn('engine init failed', e); hideChesscomBoard(); showBanner('Engine failed to load.'); });
  } catch (e) {
    warn('showChesscomBoard error', e);
    showBanner('Error: ' + (e?.message || e));
  }
}

function hideChesscomBoard() {
  if (chesscomState?._ptrCleanup) chesscomState._ptrCleanup();
  if (chesscomState?._refreshTimer) clearInterval(chesscomState._refreshTimer);
  document.getElementById('sfct-modal-blocker')?.remove();
  document.getElementById('sfct-badge')?.remove();
  teardownEngine();
  _perftMoves = null;
  _legalMoves = null;
  chesscomState = null;
}

function endGame(msg) {
  hideChesscomBoard();
  showBanner('♟ ' + msg);
}

// ── Rendering ────────────────────────────────────────────────────────────────
let _sfSyncing = false;

function syncBoardToState() {
  if (!chesscomState?.board || _sfSyncing) return;
  _sfSyncing = true;
  try {
    const { board, boardData, selectedSq } = chesscomState;
    const rect = board.getBoundingClientRect();
    const flipped = isFlipped(board);
    const sqSize = rect.width / 8;
    const dests = (selectedSq && _legalMoves) ? legalDestsFrom(_legalMoves, selectedSq) : null;

    // Remove our previous overlays + any Chess.com pieces that crept back in.
    board.querySelectorAll(':scope > [data-sfct]').forEach(el => el.remove());
    board.querySelectorAll(':scope > .piece, :scope > [class*="piece"]').forEach(el => {
      if (!el.hasAttribute('data-sfct')) el.remove();
    });

    const xy = (f, r) => {
      const x = flipped ? (7 - f) * sqSize : f * sqSize;
      const y = flipped ? (r - 1) * sqSize : (8 - r) * sqSize;
      return `translate(${x}px,${y}px)`;
    };

    for (const sq in boardData) {
      const f = sq.charCodeAt(0) - 97;
      const r = parseInt(sq[1], 10);
      const pc = boardData[sq];
      const colorPrefix = pc === pc.toUpperCase() ? 'w' : 'b';
      const d = document.createElement('div');
      d.setAttribute('data-sfct', '1');
      d.className = `piece ${colorPrefix}${pc.toLowerCase()} square-${f + 1}${r}${selectedSq === sq ? ' sfct-sel' : ''}`;
      d.style.cssText = `position:absolute;top:0;left:0;width:12.5%;height:12.5%;transform:${xy(f, r)};z-index:5;transition:none!important`;
      board.appendChild(d);
    }

    if (dests) {
      for (const dest of dests) {
        const f = dest.charCodeAt(0) - 97;
        const r = parseInt(dest[1], 10);
        if (f < 0 || f > 7 || r < 1 || r > 8) continue;
        const dot = document.createElement('div');
        dot.setAttribute('data-sfct', '1');
        dot.className = 'sfct-dot';
        dot.style.cssText = `position:absolute;top:0;left:0;width:12.5%;height:12.5%;transform:${xy(f, r)};z-index:4;pointer-events:none`;
        board.appendChild(dot);
      }
    }
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
  const onDown = (e) => {
    if (e.target?.closest?.('#sfct-badge, #sfctplay-banner, #sfctplay-btn')) return;
    const b = currentBoard();
    if (!b || !inside(b, e)) return;
    const sq = computeSquareFromClick(b, e.clientX, e.clientY);
    if (!sq) return;
    dragStart = sq;
    e.preventDefault(); e.stopPropagation();
  };
  const onUp = (e) => {
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
    const dirty = cur.querySelector(':scope > .piece:not([data-sfct]), :scope > [class*="piece"]:not([data-sfct])');
    if (dirty) syncBoardToState();
  }, REFRESH_INTERVAL_MS);
}

function ownsPiece(piece) {
  if (!piece || !chesscomState) return false;
  return chesscomState.playerSide === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase();
}

function handleSquareClick(sq) {
  const st = chesscomState;
  if (!st || st.sideToMove !== st.playerSide) return;
  if (!_legalMoves) { updateStatus('Calculating…'); return; }

  const piece = st.boardData[sq];
  const sel = st.selectedSq;

  if (!sel) {
    if (!ownsPiece(piece)) return;
    st.selectedSq = sq; syncBoardToState(); updateStatus('Select destination'); return;
  }
  if (sel === sq) { st.selectedSq = null; syncBoardToState(); updateStatus('Your move'); return; }
  if (ownsPiece(piece)) { st.selectedSq = sq; syncBoardToState(); updateStatus('Select destination'); return; }
  if (!isLegalMove(_legalMoves, sel, sq)) { st.selectedSq = null; syncBoardToState(); updateStatus('Illegal move'); return; }
  makePlayerMove(sel, sq);
}

function handleDragMove(from, to) {
  const st = chesscomState;
  if (!st || st.sideToMove !== st.playerSide) return;
  if (!_legalMoves) { updateStatus('Calculating…'); return; }
  if (!ownsPiece(st.boardData[from])) return;
  if (!isLegalMove(_legalMoves, from, to)) { updateStatus('Illegal move'); return; }
  st.selectedSq = null;
  makePlayerMove(from, to);
}

function makePlayerMove(from, to) {
  const st = chesscomState;
  if (!st) return;
  const uci = toUci(st.boardData, from, to);
  const res = applyUciMove(st.boardData, uci);
  if (!res.moved) return;
  st.boardData = res.board;
  st.moves.push(uci);
  st.selectedSq = null;
  st.sideToMove = st.engineSide;
  syncBoardToState();
  postCmd(enginePosition());
  engineThink();
}

function onEngineMove(uci) {
  const st = chesscomState;
  if (!st) return;
  if (!uci) { endGame('Stockfish has no legal moves — game over'); return; }
  const res = applyUciMove(st.boardData, uci);
  if (!res.moved) { warn('engine move on empty square', uci); return; }
  st.boardData = res.board;
  st.moves.push(uci);
  st.sideToMove = st.playerSide;
  syncBoardToState();
  updateStatus('Your move');
  postCmd(enginePosition());
  requestLegalMoves();
}

// ── Status badge & banner ────────────────────────────────────────────────────
function showStatusBadge(text) {
  document.getElementById('sfct-badge')?.remove();
  const badge = document.createElement('div');
  badge.id = 'sfct-badge';
  Object.assign(badge.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '999999',
    background: 'rgba(0,0,0,.7)', color: '#ddd', padding: '5px 10px',
    borderRadius: '6px', fontSize: '12px', fontFamily: '-apple-system,sans-serif',
    backdropFilter: 'blur(4px)', cursor: 'pointer',
  });
  badge.title = 'Click to stop playing vs Stockfish';
  const span = document.createElement('span');
  span.id = 'sfct-badge-text';
  span.textContent = '♟ ' + text;
  badge.appendChild(span);
  badge.onclick = hideChesscomBoard;
  document.body.appendChild(badge);
}

function updateStatus(text) {
  const el = document.getElementById('sfct-badge-text');
  if (el) el.textContent = '♟ ' + text;
}

function showBanner(text) {
  document.getElementById('sfctplay-banner')?.remove();
  if (!document.getElementById('sfctplay-style')) {
    const s = document.createElement('style');
    s.id = 'sfctplay-style';
    s.textContent = '@keyframes _sfctin{from{opacity:0;top:4px}to{opacity:1;top:16px}}';
    document.head.appendChild(s);
  }
  const el = document.createElement('div');
  el.id = 'sfctplay-banner';
  Object.assign(el.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '999999', background: '#1e2124', color: '#fff', padding: '14px 28px',
    borderRadius: '10px', borderLeft: '5px solid #769656',
    fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', fontSize: '18px',
    fontWeight: '600', boxShadow: '0 8px 32px rgba(0,0,0,.7)', cursor: 'pointer',
    animation: '_sfctin .28s ease',
  });
  const msg = document.createElement('span');
  msg.textContent = text;
  const hint = document.createElement('small');
  hint.style.cssText = 'opacity:.5;font-size:11px;margin-left:6px';
  hint.textContent = '(click to close)';
  el.append(msg, hint);
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.remove(), BANNER_TIMEOUT_MS);
}

// ── Inject the "Continue vs Computer" button ─────────────────────────────────
// The button must appear even when Chess.com renames its game-over modal classes.
// Strategy: try a native, in-modal placement that matches Chess.com's styling; if
// the known anchor is gone, append into the modal; if no modal container is found
// at all, fall back to a floating fixed-position button so it ALWAYS shows.

function onContinueClick(e) {
  e.preventDefault(); e.stopPropagation();
  chrome.storage.local.get(['active'], ({ active }) => {
    if (active === false) return;
    const fen = getFEN();
    if (!fen) { showBanner('Position not found.'); return; }
    document.getElementById('sfctplay-btn')?.remove(); // hide the trigger while playing
    showChesscomBoard(fen, getPlayerColor());
  });
}

// Build a button that mimics a Chess.com modal button when given a template.
function makeNativeButton(template) {
  const btn = document.createElement('button');
  btn.id = 'sfctplay-btn';
  if (template?.className) {
    btn.className = template.className;
    btn.classList.remove('ui_v5-button-primary', 'cc-button-primary');
    btn.classList.add('ui_v5-button-secondary', 'cc-button-secondary');
  }
  const wrap = document.createElement('span');
  wrap.className = 'ui_v5-button-content-wrapper';
  const label = document.createElement('span');
  label.className = 'ui_v5-button-text';
  label.textContent = '♟ Continue vs Computer';
  wrap.appendChild(label);
  btn.appendChild(wrap);
  Object.assign(btn.style, {
    display: 'inline-flex', justifyContent: 'center', alignItems: 'center',
    minHeight: '48px', cursor: 'pointer', marginTop: '8px',
  });
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

  const modal = document.querySelector(
    '.game-over-buttons-component, .game-over-modal-content, .game-over-modal-component, ' +
    '[data-cy="game-over-dialog"], [class*="game-over-modal"], .game-over-container'
  );
  if (!modal) { injectFloatingButton(); return; }

  const sibling = modal.querySelector(
    'a[data-cy="game-over-modal-game-review-button"], ' +
    'button[data-cy="game-over-modal-new-game-button"], ' +
    'button[data-cy="game-over-modal-rematch-button"], ' +
    '.game-over-buttons-buttons button, .game-over-buttons-buttons a'
  );

  if (sibling?.parentElement) {
    const btn = makeNativeButton(sibling);
    sibling.parentElement.insertBefore(btn, sibling);
    log('button injected (before sibling)');
    return;
  }

  // Known anchor gone — append into the modal's button area so it still shows.
  const container = modal.querySelector('.game-over-buttons-buttons') || modal;
  const btn = makeNativeButton(container.querySelector('button, a'));
  btn.style.width = '100%';
  container.appendChild(btn);
  log('button injected (appended to modal)');
}

function tryInject() {
  const existing = document.getElementById('sfctplay-btn');
  if (!isGameOver()) {
    // Remove a lingering floating fallback once the game-over surface is gone and
    // we are not actively playing (e.g. after the user starts a rematch).
    if (existing?.dataset.sfctFloating && !chesscomState) existing.remove();
    return;
  }
  if (existing) return;
  log('game over detected — injecting button');
  chrome.storage.local.get(['active'], ({ active }) => { if (active !== false) injectButtons(); });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
const observer = new MutationObserver(() => tryInject());
function startObserver() { observer.observe(document.body, { childList: true, subtree: true }); }
startObserver();

const pollTimer = setInterval(tryInject, POLL_INTERVAL_MS);

// SPA navigation: Chess.com swaps pages without a reload.
const navTimer = setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  document.getElementById('sfctplay-btn')?.remove();
  document.getElementById('sfctplay-banner')?.remove();
  hideChesscomBoard();
  tryInject();
}, NAV_POLL_INTERVAL_MS);

// React to the popup on/off toggle while a tab is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.active) return;
  if (changes.active.newValue === false) {
    document.getElementById('sfctplay-btn')?.remove();
    hideChesscomBoard();
  } else {
    tryInject();
  }
});

window.addEventListener('unload', () => {
  clearInterval(pollTimer);
  clearInterval(navTimer);
  observer.disconnect();
  hideChesscomBoard();
});
