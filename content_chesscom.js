// Chess.com content script for Stockfish Continue to Play.
// After a game ends, extracts the final position (FEN) and opens a
// Lichess analysis tab to continue playing against Stockfish.
//
// Pure chess functions live in lib/chess-utils.js (loaded first via manifest).

const DEBUG = true;
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

  log('Opening Lichess with:', { color, elo, lvl, uciElo, fen });

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

  log('Attempting native button injection, strictly avoiding ads, by first finding the main modal...');

  let mainModal = document.querySelector(
    '.game-over-modal-shell-buttons, ' + // Prioritize this as it contains the action buttons
    '.game-over-modal-content, ' + // Primary modal content
    'div[data-cy="game-over-dialog"], ' + // Specific data-cy for dialog
    '.game-over-buttons-component, ' + // Sometimes this is the top level wrapper
    '.game-over-container' // Another common game over container
  );

  if (!mainModal) {
    warn('Main game-over modal not found. Retrying on next mutation...');
    return;
  }

  // Now, *within this mainModal*, search for a suitable sibling button.
  // This is where we ensure the button is relevant to the game-over context.
  const knownButtonSelectors = [
    'a[data-cy="game-over-modal-game-review-button"]:not([class*="ad-upgrade"])',
    'button[data-cy="game-over-modal-new-game-button"]:not([class*="ad-upgrade"])',
    'button[data-cy="game-over-modal-rematch-button"]:not([class*="ad-upgrade"])',
    '.game-over-buttons-buttons button:not([class*="ad-upgrade"])',
    '.game-over-buttons-buttons a:not([class*="ad-upgrade"])',
    'button:contains("Nuova partita"):not([class*="ad-upgrade"])',
    'button:contains("New Game"):not([class*="ad-upgrade"])',
    'button:contains("Analizza"):not([class*="ad-upgrade"])',
    'button:contains("Analyze"):not([class*="ad-upgrade"])',
    'button:contains("Rivedi Partita"):not([class*="ad-upgrade"])',
    'button:contains("Review Game"):not([class*="ad-upgrade"])'
  ];

  let siblingButton = null;
  for (const s of knownButtonSelectors) {
    const tempButton = mainModal.querySelector(s); // Search ONLY within mainModal
    if (tempButton && !tempButton.closest('[class*="ad-sidecar"]') && !tempButton.closest('[id*="ad"]')) {
      siblingButton = tempButton;
      log('Found a suitable sibling button within main modal:', s, siblingButton);
      break;
    }
  }

  if (!siblingButton) {
    warn('No suitable sibling button found within main game-over modal. Retrying on next mutation...');
    return;
  }

  const container = siblingButton.parentElement;
  if (!container) {
    warn('Sibling button has no parentElement. This should not happen. Aborting injection.');
    return;
  }

  // Final check to ensure the parent container itself is not an ad container
  if (container.closest('[class*="ad-sidecar"]') || container.closest('[id*="ad"]')) {
    warn('Sibling button\'s parent is unexpectedly part of an ad container. Aborting injection.');
    return;
  }

  const btn = makeButton('🔗 Continue on Lichess', siblingButton);
  btn.id = 'sfctplay-btn';
  
  // Insert before the found sibling button
  container.insertBefore(btn, siblingButton);

  log('Button integrated into main menu successfully');
  buttonInjected = true;
}

// Updated makeButton to take siblingButton for cloning
function makeButton(label, siblingButton) {
  const btn = document.createElement('button');
  
  // CLONE classes from the provided sibling button for 100% identical styling
  if (siblingButton) {
    btn.className = siblingButton.className;
    // Ensure it's a secondary style (grey/blue) to avoid clashing with the primary green "New Game"
    btn.classList.remove('ui_v5-button-primary', 'cc-button-primary');
    btn.classList.add('ui_v5-button-secondary', 'cc-button-secondary'); // Add secondary if not present
  } else {
    // Fallback classes if no sibling was found (should be rare with this new approach)
    btn.className = 'ui_v5-button-component ui_v5-button-secondary ui_v5-button-full cc-button-component cc-button-secondary cc-button-full';
  }

  btn.innerHTML = `<span class="ui_v5-button-content-wrapper"><span class="ui_v5-button-text">${label}</span></span>`;
  
  // Minimal styles to ensure layout, relying on cloned classes for sizing where possible
  btn.style.cssText = `
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    min-height: 48px !important; /* Ensure it has a decent height */
    cursor: pointer !important;
    margin-top: 8px !important; /* Add some separation from previous button */
    /* No explicit width, background-color, color, or margin-bottom - rely on cloned classes */
  `;

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLichessAnalysis();
  };
  
  return btn;
}

// ── MutationObserver ─────────────────────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  if (buttonInjected) return;
  
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const gameOver = isGameOver();
    if (!gameOver) return;

    log('Game Over detected, checking storage status and attempting injection...');
    
    chrome.storage.local.get(['active'], ({ active }) => {
      if (active === false) {
        log('Extension is disabled in popup, skipping injection');
        return;
      }
      injectButtons();
    });
  }, 500);
});

function startObserver() {
  log('Starting MutationObserver');
  observer.observe(document.body, { childList: true, subtree: true });
}
startObserver();

// ── SPA Navigation Reset ─────────────────────────────────────────────────────
setInterval(() => {
  if (location.href === lastUrl) return;
  log('URL changed, resetting injection state', { from: lastUrl, to: location.href });
  lastUrl = location.href;
  ['sfctplay-btn', 'sfctplay-banner'].forEach(id => document.getElementById(id)?.remove());
  buttonInjected = false;
  analyzing = false;
  startObserver();
}, 1000);

