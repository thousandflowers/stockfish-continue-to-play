// Chess.com content script for Stockfish Continue to Play.
// After a game ends, extracts the final position (FEN) and opens a
// Lichess analysis tab to continue playing against Stockfish.

const DEBUG = false;
function log(...args) { if (DEBUG) console.log('[Stockfish+]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[Stockfish+]', ...args); }

let buttonInjected = false;
let lastUrl = location.href;
let debounce = null;

// ── Stockfish Engine (Blob Worker) ──────────────────────────────────────────
let sfWorker = null;
let workerReady = false;
let cmdQueue = [];
let analyzing = false;

async function initEngine() {
  if (sfWorker) return;
  try {
    const url = chrome.runtime.getURL('stockfish.js');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const src = await resp.text();
    const blob = new Blob([src], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    sfWorker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    sfWorker.onmessage = ({ data }) => {
      if (typeof data !== 'string') return;
      if (data === 'uciok') { sfWorker.postMessage('isready'); return; }
      if (data === 'readyok') { workerReady = true; while (cmdQueue.length) sfWorker.postMessage(cmdQueue.shift()); return; }
      if (data.startsWith('bestmove')) {
        analyzing = false;
        const move = data.split(' ')[1];
        handleBestMove((move && move !== '(none)') ? move : null);
      }
    };
    sfWorker.onerror = () => { analyzing = false; handleBestMove(null); };
    sfWorker.postMessage('uci');
    log('Engine initializing…');
  } catch (e) {
    warn('initEngine failed:', e);
  }
}

// ── Elo Extraction ──────────────────────────────────────────────────────────
function getOpponentElo() {
  const topSection = document.querySelector('.board-player-component:first-child, .player-component.player-top');
  let opponentEl = topSection;

  if (opponentEl) {
    const ratingEl = opponentEl.querySelector('.user-tagline-rating');
    if (ratingEl) {
      const v = parseInt(ratingEl.textContent.replace(/[^0-9]/g, ''));
      if (v > 100 && v < 4000) return v;
    }
  }

  const all = [...document.querySelectorAll('.user-tagline-rating')];
  const vals = all.map(el => parseInt(el.textContent.replace(/[^0-9]/g, ''))).filter(v => v > 100 && v < 4000);
  return vals.length ? Math.max(...vals) : 1500;
}

// Maps opponent Elo to Lichess computer level (1–8)
function eloToLichessLevel(elo) {
  if (elo < 1000) return 1;
  if (elo < 1200) return 2;
  if (elo < 1400) return 3;
  if (elo < 1600) return 4;
  if (elo < 1800) return 5;
  if (elo < 2000) return 6;
  if (elo < 2300) return 7;
  return 8;
}

// ── FEN Extraction ──────────────────────────────────────────────────────────
const PIECE_MAP = {
  'wk':'K','wq':'Q','wr':'R','wb':'B','wn':'N','wp':'P',
  'bk':'k','bq':'q','br':'r','bb':'b','bn':'n','bp':'p'
};

function buildFENFromPieces(root) {
  const pieceDivs = root.querySelectorAll('[class*="piece"][class*="square-"]');
  if (!pieceDivs.length) return null;
  const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
  let found = 0;
  pieceDivs.forEach(el => {
    let piece = null, file = -1, rank = -1;
    (el.className || '').split(/\s+/).forEach(c => {
      if (PIECE_MAP[c]) piece = PIECE_MAP[c];
      const m = c.match(/^square-(\d)(\d)$/);
      if (m) { file = parseInt(m[1]) - 1; rank = parseInt(m[2]) - 1; }
    });
    if (piece && file >= 0 && rank >= 0) {
      grid[7 - rank][file] = piece;
      found++;
    }
  });
  if (found < 3) return null;
  return grid.map(row => {
    let s = '', e = 0;
    row.forEach(sq => { if (sq) { if (e) { s += e; e = 0; } s += sq; } else e++; });
    if (e) s += e;
    return s;
  }).join('/');
}

function getTurnFromMoveList() {
  const selectors = [
    '[data-whole-move-number]',
    '.node.selected',
    '[data-node-ply]',
  ];
  for (const s of selectors) {
    const nodes = document.querySelectorAll(s);
    if (nodes.length) return (nodes.length % 2 === 0) ? 'w' : 'b';
  }
  return 'w';
}

function getFEN() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return null;

  // 1. Direct attribute (fastest, most reliable)
  const attr = board.getAttribute('game-fen') || board.getAttribute('fen');
  if (attr && attr.split('/').length >= 7) {
    console.log('[Stockfish+][fen:1] attribute');
    log('FEN from attribute:', attr.substring(0, 30));
    return attr;
  }

  // 2. Internal component state (React internals)
  try {
    const key = Object.keys(board).find(k => k.startsWith('__'));
    if (key) {
      const s = board[key];
      const f = s?.setupFen || s?.game?.fen || s?.fen || s?.currentFen || s?.game?.setupFen;
      if (f && f.split('/').length >= 7) {
        console.log('[Stockfish+][fen:2] internal state');
        log('FEN from internal state:', f.substring(0, 30));
        return f;
      }
    }
  } catch (_) {}

  // 3. Reconstructed from pieces in light DOM
  const lightPos = buildFENFromPieces(board);
  if (lightPos) {
    const fen = `${lightPos} ${getTurnFromMoveList()} - - 0 1`;
    console.log('[Stockfish+][fen:3] light DOM pieces');
    log('FEN from light DOM pieces:', fen.substring(0, 30));
    return fen;
  }

  // 4. Shadow DOM (wc-chess-board may render pieces in shadow root)
  try {
    const shadow = board.shadowRoot;
    if (shadow) {
      const shadowPos = buildFENFromPieces(shadow);
      if (shadowPos) {
        const fen = `${shadowPos} ${getTurnFromMoveList()} - - 0 1`;
        console.log('[Stockfish+][fen:4] shadow DOM');
        log('FEN from shadow DOM pieces:', fen.substring(0, 30));
        return fen;
      }
    }
  } catch (_) {}

  // 5. Look for window-level game state
  try {
    const state = window.chessground?.state?.fen
                || window.board?.game?.fen
                || window.game?.fen;
    if (state && state.split('/').length >= 7) {
      console.log('[Stockfish+][fen:5] window state');
      log('FEN from window state:', state.substring(0, 30));
      return state;
    }
  } catch (_) {}

  console.warn('[Stockfish+][fen:0] ALL METHODS FAILED');
  return null;
}

// ── Detect player color from board orientation ────────────────────────────
function getPlayerColor() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return 'white';
  const flipped = board.hasAttribute('flipped') ||
                  board.getAttribute('orientation') === 'black' ||
                  board.classList.contains('flipped');
  return flipped ? 'black' : 'white';
}

// ── Skill Level for Stockfish UCI ─────────────────────────────────────────
function eloToSkill(elo) {
  const levels = [800, 1000, 1200, 1400, 1600, 1800, 2000];
  const skills = [0, 3, 6, 9, 12, 15, 18, 20];
  for (let i = 0; i < levels.length; i++) if (elo < levels[i]) return skills[i];
  return 20;
}

// ── Open Lichess + trigger auto-start via content_lichess.js ─────────────
function openLichessAnalysis() {
  const color = getPlayerColor();
  const elo = getOpponentElo();
  const lvl = eloToLichessLevel(elo);
  const fen = getFEN();

  if (!fen) {
    showBanner('Position not found. Try again.', '#c0392b');
    return;
  }

  chrome.storage.local.set({
    sfct_autoStart: true,
    sfct_level: lvl,
    sfct_fen: fen,
    sfct_color: color,
    sfct_timestamp: Date.now()
  }, () => {
    const url = `https://lichess.org/editor/${encodeURIComponent(fen)}?color=${color}`;
    window.open(url, '_blank');
    showBanner(`Lichess opened — game starting automatically (Level ${lvl}, ~${elo} Elo)`, '#3d85c8');
    log(`Stored sfct data: level=${lvl}`);
  });
}

// ── Banner ──────────────────────────────────────────────────────────────────
function showBanner(html, borderColor = '#769656') {
  const old = document.getElementById('sfctplay-banner');
  if (old) old.remove();
  if (!document.getElementById('sfctplay-style')) {
    const s = document.createElement('style');
    s.id = 'sfctplay-style';
    s.textContent = '@keyframes _sfctin{from{opacity:0;top:4px}to{opacity:1;top:16px}}';
    document.head.appendChild(s);
  }
  const el = document.createElement('div');
  el.id = 'sfctplay-banner';
  Object.assign(el.style, {
    position: 'fixed', top: '16px', left: '50%',
    transform: 'translateX(-50%)', zIndex: '99999',
    background: '#1e2124', color: '#fff',
    padding: '14px 28px', borderRadius: '10px',
    borderLeft: `5px solid ${borderColor}`,
    fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
    fontSize: '18px', fontWeight: '600',
    boxShadow: '0 8px 32px rgba(0,0,0,.7)',
    cursor: 'pointer', animation: '_sfctin .28s ease',
  });
  el.innerHTML = `♟ <span style="color:#a4cb8f">${html}</span> <small style="opacity:.5;font-size:11px">(click to close)</small>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.parentNode && el.remove(), 15000);
}

// ── Detect Game Over ────────────────────────────────────────────────────────
function isGameOver() {
  return !!(
    document.querySelector('.game-over-modal-content') ||
    document.querySelector('.game-over-modal-component') ||
    document.querySelector('.game-over-buttons-component')
  );
}

// ── Inject Button into End-Game Menu (idempotent) ──────────────────────────
function injectButtons() {
  if (buttonInjected) return;
  if (document.getElementById('sfctplay-btn')) return;

  const containerSelectors = [
    '.game-over-buttons-component',
    '.game-over-modal-buttons',
    '.game-over-modal-content',
    '.board-modal-container',
  ];
  let container = null;
  for (const s of containerSelectors) {
    container = document.querySelector(s);
    if (container) break;
  }

  const btn = makeButton('🔗 Continue on Lichess', '#2b2d42', () => openLichessAnalysis());
  (container || document.body).appendChild(btn);

  buttonInjected = true;
  observer.disconnect();
}

function makeButton(label, bg, onClick) {
  const btn = document.createElement('button');
  btn.innerHTML = label;
  btn.style.cssText = [
    'display:block', 'width:100%', 'margin-top:10px', 'padding:13px 16px',
    `background:${bg}`, 'color:#fff', 'border:none', 'border-radius:6px',
    'font-size:14px', 'font-weight:700', 'cursor:pointer',
    'transition:background 0.18s',
  ].join(';');
  btn.onmouseover = () => btn.style.filter = 'brightness(1.15)';
  btn.onmouseout = () => btn.style.filter = '';
  btn.onclick = onClick;
  return btn;
}

// ── MutationObserver ─────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  if (buttonInjected) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!isGameOver()) return;
    chrome.storage.local.get(['active'], ({ active }) => {
      if (active === false) return;
      injectButtons();
    });
  }, 300);
});

function startObserver() {
  observer.observe(document.body, { childList: true, subtree: true });
}
startObserver();

// ── SPA Navigation Reset ─────────────────────────────────────────────────────
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  ['sfctplay-btn', 'sfctplay-banner'].forEach(id => document.getElementById(id)?.remove());
  buttonInjected = false;
  analyzing = false;
  startObserver();
}, 1000);
