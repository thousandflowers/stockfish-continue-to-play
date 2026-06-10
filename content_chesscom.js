// Chess.com content script for Stockfish Continue to Play.
// After a game ends, extracts the final position (FEN) and opens a
// Lichess analysis tab to continue playing against Stockfish.
//
// Pure chess functions live in lib/chess-utils.js (loaded first via manifest).

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

// ── Open Lichess + trigger auto-start via content_lichess.js ─────────────
function openLichessAnalysis() {
  const color = getPlayerColor();
  const elo = getOpponentElo();
  const lvl = eloToLichessLevel(elo);
  const uciElo = eloToUCIElo(elo);
  const fen = getFEN();

  if (!fen) {
    showBanner('Position not found. Try again.', '#c0392b');
    return;
  }

  chrome.storage.local.set({
    sfct_autoStart: true,
    sfct_level: lvl,
    sfct_uciElo: uciElo,
    sfct_fen: fen,
    sfct_color: color,
    sfct_timestamp: Date.now()
  }, () => {
    const url = `https://lichess.org/editor/${encodeURIComponent(fen)}?color=${color}`;
    window.open(url, '_blank');
    showBanner(`Lichess opened — game starting automatically (Level ${lvl}, UCI_Elo ${uciElo})`, '#3d85c8');
    log(`Stored sfct data: level=${lvl}, uciElo=${uciElo}`);
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
