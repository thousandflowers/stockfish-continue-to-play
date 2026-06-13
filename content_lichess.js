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
        autoStartAttempted = false; // allow retry
        return;
      }

      const level = data.sfct_level || 4;
      const color = data.sfct_color || 'white';
      const fen = data.sfct_fen;
      
      // Clean up all auto-start storage keys
      chrome.storage.local.remove([
        'sfct_autoStart', 'sfct_timestamp', 'sfct_fen',
        'sfct_level', 'sfct_color', 'sfct_uciElo'
      ]);
      
      log('Auto-starting vs computer:', { level, color, fen: fen ? fen.slice(0, 30) + '…' : null });

      if (fen) {
        // PRIMARY PATH: Direct form POST to /setup/ai — reliable, no DOM dependency
        submitAIForm(level, color, fen);
      } else {
        // FALLBACK: click-through UI for cases without FEN
        log('No FEN in storage, falling back to click-through UI.');
        clickThroughEditorUI(level, color);
      }
    }
  );
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

function submitAIForm(level, color, fen) {
  const resolveFen = (fenVal) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/setup/ai';
    const fields = {
      'variant': '1',
      'fenVariant': fenVal || '',
      'level': String(level),
      'color': color,
      'timeMode': '1',
      'time': '10',
      'increment': '5',
      'days': '2',
    };
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    log('Submitting /setup/ai form:', fields);
    form.submit();
  };

  if (fen !== undefined) {
    resolveFen(fen);
  } else {
    chrome.storage.local.get(['sfct_fen'], ({ sfct_fen }) => {
      resolveFen(sfct_fen);
    });
  }
}



// ── Standard game end detection (when playing on Lichess) ──────────────────
let buttonInjected = false;
let debounce = null;

// isGameOver() defined in lib/lichess-utils.js

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
    const fenInput = document.querySelector('input[value*="/"]');
    const fen = fenInput?.value || null;
    const color = document.querySelector('.cg-wrap').classList.contains('orientation-black') ? 'black' : 'white';
    log('Button clicked, preparing redirection...', { fen, color });
    if (fen) {
      chrome.storage.local.set({
        sfct_autoStart: true,
        sfct_level: 4,
        sfct_fen: fen,
        sfct_color: color,
        sfct_timestamp: Date.now()
      }, () => {
        window.location.href = `/editor/${encodeURIComponent(fen)}?color=${color}`;
      });
    }
  };

  (container || document.body).appendChild(btn);
  log('Button injected successfully on Lichess.');
  buttonInjected = true;
}

let tryAutoStartDebounce = null; // New debounce variable for tryAutoStart

const observer = new MutationObserver((mutations) => {
  log('MutationObserver triggered on Lichess. Checking auto-start conditions...');
  log('Current Lichess URL:', location.href);
    const isEditorPage = (location.pathname.startsWith('/editor') || location.href.includes('/?fen=')) || document.querySelector('.setup__main') !== null;
  const isLichessHomepage = location.href === 'https://lichess.org/' || location.href === 'https://lichess.org';

  log('isEditorPage condition result:', isEditorPage);
  log('isLichessHomepage condition result:', isLichessHomepage);

  // --- Handle Lichess Homepage redirect first ---
  // If we land on the Lichess homepage and have auto-start data, redirect to the editor page
  if (isLichessHomepage && !autoStartAttempted) { // Only attempt redirect once
    chrome.storage.local.get(['sfct_autoStart', 'sfct_fen', 'sfct_color'], (data) => {
      if (data.sfct_autoStart && data.sfct_fen) {
        log('Lichess homepage detected with auto-start data. Redirecting to editor page...');
        // Construct the correct editor URL
        const editorUrl = `https://lichess.org/editor/${encodeURIComponent(data.sfct_fen)}?color=${data.sfct_color}`;
        // Clear auto-start flag immediately before redirect
        chrome.storage.local.remove(['sfct_autoStart', 'sfct_timestamp']); // Also remove timestamp here
        window.location.href = editorUrl; // Redirect
        autoStartAttempted = true; // Mark as attempted to prevent loop
        return; // Stop further processing for this mutation
      }
    });
  }

  // --- Handle Auto-start on the actual Editor Page ---
  if (isEditorPage) {
    if (!autoStartAttempted) { // Only schedule if not already attempted
      log('Lichess editor page detected via MutationObserver, scheduling tryAutoStart...');
      // Clear any existing debounce for injectButton, as auto-start is primary
      clearTimeout(debounce); // debounce is still used for injectButton logic

      // We need a separate debounce for tryAutoStart to prevent rapid re-scheduling
      if (!tryAutoStartDebounce) {
          tryAutoStartDebounce = setTimeout(() => {
              tryAutoStart();
              tryAutoStartDebounce = null; // Reset after execution
          }, 1500);
      } else {
          log('tryAutoStart already scheduled, skipping re-scheduling.');
      }
    } else {
      log('tryAutoStart already attempted and completed. Skipping re-check.');
    }
  }

  // Existing logic for injectButton (Lichess game-over)
  // This part should only run if the auto-start isn't active or fails
  // and we are NOT on the editor page
  if (buttonInjected || isEditorPage) return; // Don't inject "Continue vs Computer" on editor page
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!isGameOver()) return;
    log('Game Over detected on Lichess, checking storage...');
    chrome.storage.local.get(['active'], ({ active }) => {
      if (active !== false) injectButton();
    });
  }, 100);
});

log('Starting MutationObserver on Lichess');
observer.observe(document.body, { childList: true, subtree: true });

