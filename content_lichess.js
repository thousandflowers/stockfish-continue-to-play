// Lichess content script for Stockfish Continue to Play.
// Two roles:
// 1. When landing on /editor (from Chess.com extension), auto-start a computer game
// 2. Normal game end detection for continuing with Stockfish

console.error('Stockfish+ Lichess: Content script started!'); // Added for debugging

const DEBUG = true;
function log(...args) { if (DEBUG) console.log('[Stockfish+]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[Stockfish+]', ...args); }

// ── Auto-start computer game from /editor page ──────────────────────────────
let autoStartAttempted = false;

function tryAutoStart() {
  if (autoStartAttempted) {
    log('tryAutoStart already attempted, skipping second run.');
    return;
  }
  autoStartAttempted = true;

  log('Checking for auto-start data in storage...');
  chrome.storage.local.get(
    ['sfct_autoStart', 'sfct_level', 'sfct_color', 'sfct_fen', 'sfct_timestamp'],
    (data) => {
      if (!data.sfct_autoStart) {
        log('No auto-start flag found.');
        autoStartAttempted = false;
        return;
      }

      const level = data.sfct_level || 4;
      const color = data.sfct_color || 'white';
      const fen = data.sfct_fen;

      chrome.storage.local.remove([
        'sfct_autoStart', 'sfct_timestamp', 'sfct_fen',
        'sfct_level', 'sfct_color', 'sfct_uciElo'
      ]);

      log('Auto-start: navigating to /setup/ai', { level, color, fen: fen ? fen.slice(0, 30) + '…' : null });

      if (fen) {
        window.location.href = `/setup/ai?fen=${encodeURIComponent(fen)}&color=${color}`;
      } else {
        log('No FEN, falling back to click-through UI.');
        clickThroughEditorUI(level, color);
      }
    }
  );
}

let setupFormSubmitted = false;

function autoSubmitSetupForm() {
  if (setupFormSubmitted) return;
  const params = new URLSearchParams(location.search);
  const fen = params.get('fen');
  if (!fen) { log('autoSubmitSetupForm: no fen param, skipping'); return; }
  setupFormSubmitted = true;

  log('Auto-submitting /setup/ai form (native, CSRF included)');

  const waitAndSubmit = (attempt = 0) => {
    const form = document.querySelector('form[action="/setup/ai"]');
    if (!form) {
      if (attempt < 15) { setTimeout(() => waitAndSubmit(attempt + 1), 300); return; }
      warn('autoSubmitSetupForm: form not found after retries');
      return;
    }

    const level = params.get('level') || '4';
    const color = params.get('color') || 'white';

    const levelInput = form.querySelector('input[name="level"]');
    if (levelInput) {
      levelInput.value = level;
      levelInput.dispatchEvent(new Event('input', { bubbles: true }));
      levelInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const colorInput = form.querySelector('select[name="color"], input[name="color"]');
    if (colorInput) {
      colorInput.value = color;
      colorInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.click(); log('autoSubmitSetupForm: clicked Play'); }
    else { form.submit(); log('autoSubmitSetupForm: called form.submit()'); }
  };

  waitAndSubmit();
}

function clickThroughEditorUI(level, color) {
  log('Starting Lichess click-through UI automation for level:', level, 'color:', color);

  const findAndClick = (selector, textMatch) => {
    log(`Attempting to find and click: ${selector} with text "${textMatch || 'any'}"`);
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      if (!textMatch || el.textContent.toLowerCase().includes(textMatch.toLowerCase())) {
        log(`Found and clicking element: ${selector} ("${el.textContent.trim()}")`);
        el.click();
        return true;
      }
    }
    log(`Element not found: ${selector} with text "${textMatch || 'any'}"`);
    return false;
  };

  const step1 = () => {
    // Try to find the "Play with the computer" button on /editor
    // Use standard selectors first, then text content check for specific cases

    // 1. Precise selector for "Play with the computer" link
    if (findAndClick('a.button.button-primary[href="/setup/ai"]')) {
      log('Successfully clicked "Play with the computer" via href selector.');
      return step2();
    }

    // 2. Fallback: Search for primary buttons with "computer" related text
    warn('Could not find explicit "Play with the computer" button via href. Trying text match on primary buttons.');
    const primaryButtonSelectors = 'button.button-primary, a.button-primary';
    const primaryButtons = document.querySelectorAll(primaryButtonSelectors);
    
    for (const el of primaryButtons) {
      const textContent = el.textContent.toLowerCase();
      if (textContent.includes('computer') || textContent.includes('stockfish') || textContent.includes('ai') || textContent.includes('gioca con il computer')) {
        log(`Found and clicking primary button with text: "${el.textContent.trim()}"`);
        el.click();
        return step2();
      }
    }
    
    // 3. Fallback: Search any button/link with "computer" related text
    warn('Could not find primary "Play with the computer" button. Trying generic button/link text match.');
    const genericSelectors = 'a, button';
    const genericButtons = document.querySelectorAll(genericSelectors);
    
    for (const el of genericButtons) {
      const textContent = el.textContent.toLowerCase();
      if (textContent.includes('computer') || textContent.includes('stockfish') || textContent.includes('ai') || textContent.includes('gioca con il computer')) {
        log(`Found and clicking generic button with text: "${el.textContent.trim()}"`);
        el.click();
        return step2();
      }
    }

    warn('Could not find "vs computer" button in editor after all attempts, falling back to form submit');
    submitAIForm(level, color);
  };

  const step2 = () => {
    log('Step 2: Selecting level and submitting form on Lichess...');
    setTimeout(() => {
      // Find the level input/slider
      const levelInputSelectors = [
        `input[name="level"][type="range"]`, // Primary: the slider itself
        `input[name="level"]`,
        `select[name="level"]`,
        `.level-choice input`,
        `.sf-level input`,
      ];
      let levelInput = null;
      for (const s of levelInputSelectors) {
        levelInput = document.querySelector(s);
        if (levelInput) {
          log('Found level input element:', s);
          break;
        }
      }

      if (levelInput) {
        log('Setting level input value to:', level);
        levelInput.value = level;
        // Trigger events to ensure Lichess UI reacts to the change
        levelInput.dispatchEvent(new Event('input', { bubbles: true }));
        levelInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        warn('Could not find level input element.');
      }

      // Also try clicking the level button if it's a discrete choice (e.g. 1-8 buttons)
      const levelBtnSelectors = [
        `button[data-level="${level}"]`,
        `.level-choice .level-${level}`,
      ];
      let levelBtn = null;
      for (const s of levelBtnSelectors) {
        levelBtn = document.querySelector(s);
        if (levelBtn) {
          log('Found and clicking level button:', s);
          levelBtn.click();
          break;
        }
      }
      // Fallback for label matching if standard selectors fail
      if (!levelBtn) {
        const labels = document.querySelectorAll('label');
        for (const labelEl of labels) {
            if (labelEl.textContent.trim() === String(level)) {
                log('Found and clicking level label:', labelEl.textContent.trim());
                labelEl.click();
                break;
            }
        }
      }


      if (!levelInput && !levelBtn) {
        warn('No level input or button found for level selection.');
      }

      setTimeout(() => {
        const submitBtnSelectors = [
          'button[type="submit"]', // General submit buttons
          'input[type="submit"]',
          '.submit.button', // Specific Lichess submit button class
          'form button.button-primary:last-child', // Last primary button in form
        ];
        let submitBtn = null;
        for (const s of submitBtnSelectors) {
          // Check for text content "Gioca" or "Play" on submit buttons
          const potentialSubmitButtons = document.querySelectorAll(s);
          for(const el of potentialSubmitButtons) {
            const textContent = el.textContent.toLowerCase();
            if (textContent.includes('gioca') || textContent.includes('play')) {
              submitBtn = el;
              log('Found and clicking submit button:', s, `("${el.textContent.trim()}")`);
              submitBtn.click();
              break;
            }
          }
          if (submitBtn) break;
        }
        
        if (!submitBtn) {
          const form = document.querySelector('form');
          if (form) {
            log('No specific submit button found, calling form.submit()');
            form.submit();
          } else {
            warn('No form or submit button found to initiate game.');
          }
        }
      }, 500); // Short delay for level setting to propagate
    }, 800); // Delay for page to render AI setup options
  };

  setTimeout(step1, 1200); // Initial delay for page to load
}

async function submitAIForm(level, color, fen) {
  if (fen) {
    window.location.href = `/setup/ai?fen=${encodeURIComponent(fen)}&color=${color}&level=${level}`;
  } else {
    window.location.href = `/setup/ai?color=${color}&level=${level}`;
  }
}



// ── Standard game end detection (when playing on Lichess) ──────────────────
let buttonInjected = false;
let gameOverDetected = false;

// isGameOver() defined in lib/lichess-utils.js

function extractFENfromLichessBoard() {
  const wrap = document.querySelector('.cg-wrap');
  if (wrap) {
    const state = wrap.getAttribute('data-state');
    if (state && state.includes('/')) return state.split(' ')[0] + ' w - - 0 1';
  }

  const input = document.querySelector('input[value*="/"]');
  if (input) return input.value;

  const round = document.querySelector('.round, .round__app, main.round');
  if (round) {
    const fen = round.getAttribute('data-fen');
    if (fen) return fen;
  }

  for (const sel of ['.pgn', '[data-pgn]', '.game__pgn', '.analyse__pgn']) {
    const el = document.querySelector(sel);
    if (el) {
      const m = el.textContent.match(/((?:[rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+ [bw] (?:K?Q?k?q?|-) (?:[a-h][1-8]|-) \d+ \d+)/);
      if (m) return m[1];
    }
  }

  if (wrap) {
    const pieces = wrap.querySelectorAll('piece');
    if (pieces.length > 0) {
      const board = Array.from({ length: 8 }, () => Array(8).fill(''));
      pieces.forEach(p => {
        const sq = p.getAttribute('data-square') || '';
        if (!sq || sq.length < 2) return;
        const col = sq.charCodeAt(0) - 97;
        const row = 8 - parseInt(sq[1]);
        if (col < 0 || col > 7 || row < 0 || row > 7) return;
        const type = p.getAttribute('data-role') || '';
        if (!type) return;
        const isW = p.getAttribute('data-color') === 'white' || p.classList.contains('white');
        const pieceChar = isW ? type[0].toUpperCase() : type[0].toLowerCase();
        board[row][col] = pieceChar;
      });
      let fen = '';
      for (let r = 0; r < 8; r++) {
        let empty = 0;
        for (let c = 0; c < 8; c++) {
          if (board[r][c]) { if (empty) { fen += empty; empty = 0; } fen += board[r][c]; }
          else empty++;
        }
        if (empty) fen += empty;
        if (r < 7) fen += '/';
      }
      return fen + ' w - - 0 1';
    }
  }

  return null;
}

function injectButton() {
  if (document.getElementById('sfctplay-btn') || buttonInjected) return;
  log('Attempting button injection on Lichess...');

  const targets = ['.result-wrap', '.game__result', 'section.game__meta'];
  let container = null;
  for (const s of targets) {
    container = document.querySelector(s);
    if (container) {
      log('Found container:', s);
      break;
    }
  }

  const btn = document.createElement('button');
  btn.id = 'sfctplay-btn';
  btn.innerHTML = '🔗 Continue vs Computer';
  btn.style.cssText = `
    display:block;width:100%;margin-top:10px;padding:12px;
    background:#759900;color:#fff;border:none;border-radius:5px;
    font-size:14px;font-weight:700;cursor:pointer;transition:background .18s;
  `;
  btn.onmouseover = () => btn.style.background = '#8aab00';
  btn.onmouseout = () => btn.style.background = '#759900';
  btn.onclick = () => {
    const fen = extractFENfromLichessBoard();
    const color = document.querySelector('.cg-wrap')?.classList.contains('orientation-black') ? 'black' : 'white';
    log('Button clicked', { fen, color });
    const url = fen
      ? `/setup/ai?fen=${encodeURIComponent(fen)}&color=${color}&level=4`
      : `/setup/ai?color=${color}&level=4`;
    window.location.href = url;
  };

  (container || document.body).appendChild(btn);
  log('Button injected successfully on Lichess.');
  buttonInjected = true;
}

let tryAutoStartDebounce = null;

const observer = new MutationObserver((mutations) => {
  log('MutationObserver triggered. URL:', location.pathname);

  // ── /setup/ai page: auto-submit the native form (CSRF included) ──────────
  if (location.pathname === '/setup/ai') {
    autoSubmitSetupForm();
    return;
  }

  // ── Editor page: read storage and redirect to /setup/ai ──────────────────
  const isEditorPage = location.pathname.startsWith('/editor')
    || location.href.includes('/?fen=')
    || !!document.querySelector('.setup__main');

  if (isEditorPage) {
    if (!autoStartAttempted) {
      if (!tryAutoStartDebounce) {
        tryAutoStartDebounce = setTimeout(() => { tryAutoStart(); tryAutoStartDebounce = null; }, 500);
      }
    }
    return;
  }

  // ── Game-over detection on standard Lichess pages ─────────────────────────
  if (buttonInjected || gameOverDetected) return;
  if (isGameOver()) {
    gameOverDetected = true;
    log('Game Over detected');
    chrome.storage.local.get(['active'], ({ active }) => {
      if (active !== false) injectButton();
    });
  }
});

log('Starting MutationObserver on Lichess');
observer.observe(document.body, { childList: true, subtree: true });

