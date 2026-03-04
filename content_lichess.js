// content_lichess.js — Lichess content script
// Two roles:
// 1. When landing on /editor (from Chess.com extension), auto-start a computer game
// 2. Normal game end detection for continuing with Stockfish

console.log('[Stockfish+] Lichess script loaded on', location.pathname);

// ── Auto-start computer game from /editor page ────────────────────────────────
function tryAutoStart() {
  chrome.storage.local.get(['sfct_autoStart', 'sfct_level', 'sfct_color', 'sfct_timestamp'], (data) => {
    if (!data.sfct_autoStart) return;
    // Only act if the flag was set recently (within 30 seconds)
    if (Date.now() - (data.sfct_timestamp || 0) > 30000) {
      chrome.storage.local.remove(['sfct_autoStart']);
      return;
    }

    const level = data.sfct_level || 4;
    const color = data.sfct_color || 'white';

    // Clear flag so it doesn't retrigger on next visit
    chrome.storage.local.remove(['sfct_autoStart', 'sfct_timestamp']);

    console.log(`[Stockfish+] Auto-starting vs computer: level=${level} color=${color}`);

    // Try to click through the editor UI to start vs computer
    clickThroughEditorUI(level, color);
  });
}

// Clicks through Lichess editor UI to start a game vs computer
function clickThroughEditorUI(level, color) {
  // Lichess editor bottom buttons — look for "vs Computer" / "Gioca contro il computer"
  // Lichess uses <a> tags and buttons with data-action attributes
  const clickTargets = [
    // Link to /setup/ai on the editor page
    'a[href*="/setup/ai"]',
    'a[href*="computer"]',
    '[data-action="ai"]',
    // Button texts (multilingual)
    'button, a',
  ];

  function findAndClick(selector, textMatch) {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      if (!textMatch || el.textContent.toLowerCase().includes(textMatch.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // Step 1: look for "Play vs computer" / "vs computer" link in the editor action menu
  const step1 = () => {
    // Try direct link first
    if (findAndClick('a[href*="/setup/ai"]')) return step2();
    // Try by text
    const keywords = ['computer', 'macchina', 'machine', 'stockfish', 'engine'];
    for (const kw of keywords) {
      if (findAndClick('a, button', kw)) return step2();
    }
    console.warn('[Stockfish+] Could not find "vs computer" button in editor');
    // Fallback: submit a form directly
    submitAIForm(level, color);
  };

  // Step 2: after clicking "vs computer", the setup form appears — set level and submit
  const step2 = () => {
    setTimeout(() => {
      // Look for the level selector (1–8 range input or select)
      const levelInput = document.querySelector(
        'input[name="level"], select[name="level"], ' +
        '.level-choice input, .sf-level input, ' +
        `[data-level="${level}"], .level-${level}`
      );
      if (levelInput) {
        if (levelInput.tagName === 'INPUT' && levelInput.type === 'range') {
          // Range slider: set value and dispatch events
          levelInput.value = level;
          levelInput.dispatchEvent(new Event('input', { bubbles: true }));
          levelInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          levelInput.value = level;
          levelInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Click level-N button if it exists
      const levelBtn = document.querySelector(`[data-level="${level}"], .level-choice .level-${level}`);
      if (levelBtn) levelBtn.click();

      // Submit the form
      setTimeout(() => {
        const submitBtn = document.querySelector(
          'button[type="submit"], input[type="submit"], ' +
          '.submit, form button:last-child'
        );
        if (submitBtn) {
          submitBtn.click();
        } else {
          // If no submit button found, try submitting the form directly
          const form = document.querySelector('form');
          if (form) form.submit();
        }
      }, 500);
    }, 800);
  };

  // Wait for the page to be ready, then start the sequence
  setTimeout(step1, 1200);
}

// Direct form POST to /setup/ai — bypasses UI clicks entirely
function submitAIForm(level, color) {
  chrome.storage.local.get(['sfct_fen'], ({ sfct_fen }) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/setup/ai';

    const fields = {
      'variant':    '1',           // standard
      'fenVariant': sfct_fen || '', // final position FEN
      'level':      String(level),
      'color':      color,
      'time':       '10',
      'increment':  '5',
    };

    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type  = 'hidden';
      input.name  = name;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    console.log('[Stockfish+] Submitting /setup/ai form:', fields);
    form.submit();
  });
}

// ── Trigger auto-start on editor pages ───────────────────────────────────────
if (location.pathname.startsWith('/editor') || location.pathname === '/editor') {
  // Wait a moment for Lichess React app to render
  setTimeout(tryAutoStart, 1500);
}

// ── Standard game end detection (when playing on Lichess) ────────────────────
let buttonInjected = false;
let debounce = null;

function isGameOver() {
  return !!(
    document.querySelector('.result-wrap') ||
    document.querySelector('.game__result') ||
    document.querySelector('.crosstable__score')
  );
}

function injectButton() {
  if (document.getElementById('sfctplay-btn') || buttonInjected) return;
  const targets = ['.result-wrap', '.game__result', 'section.game__meta'];
  let container = null;
  for (const s of targets) { container = document.querySelector(s); if (container) break; }

  const btn = document.createElement('button');
  btn.id = 'sfctplay-btn';
  btn.innerHTML = '🔗 Continua su Lichess (vs Computer)';
  btn.style.cssText = `
    display:block;width:100%;margin-top:10px;padding:12px;
    background:#759900;color:#fff;border:none;border-radius:5px;
    font-size:14px;font-weight:700;cursor:pointer;transition:background .18s;
  `;
  btn.onmouseover = () => btn.style.background = '#8aab00';
  btn.onmouseout  = () => btn.style.background = '#759900';
  btn.onclick     = () => {
    // Get current FEN from Lichess board for a fresh continue
    const fenInput = document.querySelector('input[value*="/"]');
    const fen = fenInput?.value || null;
    if (fen) {
      chrome.storage.local.set({ sfct_autoStart: true, sfct_level: 4, sfct_fen: fen, sfct_color: 'white', sfct_timestamp: Date.now() });
      window.location.href = `/editor/${encodeURIComponent(fen)}`;
    }
  };

  (container || document.body).appendChild(btn);
  buttonInjected = true;
}

const observer = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!isGameOver()) return;
    chrome.storage.local.get(['active'], ({ active }) => {
      if (active !== false) injectButton();
    });
  }, 200);
});
observer.observe(document.body, { childList: true, subtree: true });
