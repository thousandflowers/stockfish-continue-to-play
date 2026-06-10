// Lichess content script for Stockfish Continue to Play.
// Two roles:
// 1. When landing on /editor (from Chess.com extension), auto-start a computer game
// 2. Normal game end detection for continuing with Stockfish

const DEBUG = false;
function log(...args) { if (DEBUG) console.log('[Stockfish+]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[Stockfish+]', ...args); }

// ── Auto-start computer game from /editor page ──────────────────────────────
function tryAutoStart() {
  chrome.storage.local.get(['sfct_autoStart', 'sfct_level', 'sfct_color', 'sfct_timestamp'], (data) => {
    if (!data.sfct_autoStart) return;
    if (Date.now() - (data.sfct_timestamp || 0) > 30000) {
      chrome.storage.local.remove(['sfct_autoStart']);
      return;
    }

    const level = data.sfct_level || 4;
    const color = data.sfct_color || 'white';
    chrome.storage.local.remove(['sfct_autoStart', 'sfct_timestamp']);
    log('Auto-starting vs computer:', { level, color });
    clickThroughEditorUI(level, color);
  });
}

function clickThroughEditorUI(level, color) {
  const findAndClick = (selector, textMatch) => {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      if (!textMatch || el.textContent.toLowerCase().includes(textMatch.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  };

  const step1 = () => {
    if (findAndClick('a[href*="/setup/ai"]')) return step2();
    const keywords = ['computer', 'stockfish', 'engine'];
    for (const kw of keywords) {
      if (findAndClick('a, button', kw)) return step2();
    }
    warn('Could not find "vs computer" button in editor, falling back to form submit');
    submitAIForm(level, color);
  };

  const step2 = () => {
    setTimeout(() => {
      const levelInput = document.querySelector(
        'input[name="level"], select[name="level"], ' +
        '.level-choice input, .sf-level input, ' +
        `[data-level="${level}"], .level-${level}`
      );
      if (levelInput) {
        if (levelInput.tagName === 'INPUT' && levelInput.type === 'range') {
          levelInput.value = level;
          levelInput.dispatchEvent(new Event('input', { bubbles: true }));
          levelInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          levelInput.value = level;
          levelInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const levelBtn = document.querySelector(`[data-level="${level}"], .level-choice .level-${level}`);
      if (levelBtn) levelBtn.click();

      setTimeout(() => {
        const submitBtn = document.querySelector(
          'button[type="submit"], input[type="submit"], ' +
          '.submit, form button:last-child'
        );
        if (submitBtn) {
          submitBtn.click();
        } else {
          const form = document.querySelector('form');
          if (form) form.submit();
        }
      }, 500);
    }, 800);
  };

  setTimeout(step1, 1200);
}

function submitAIForm(level, color) {
  chrome.storage.local.get(['sfct_fen'], ({ sfct_fen }) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/setup/ai';
    const fields = {
      'variant': '1',
      'fenVariant': sfct_fen || '',
      'level': String(level),
      'color': color,
      'time': '10',
      'increment': '5',
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
  });
}

if (location.pathname.startsWith('/editor')) {
  setTimeout(tryAutoStart, 1500);
}

// ── Standard game end detection (when playing on Lichess) ──────────────────
let buttonInjected = false;
let debounce = null;

// isGameOver() defined in lib/lichess-utils.js

function injectButton() {
  if (document.getElementById('sfctplay-btn') || buttonInjected) return;
  const targets = ['.result-wrap', '.game__result', 'section.game__meta'];
  let container = null;
  for (const s of targets) { container = document.querySelector(s); if (container) break; }

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
    if (fen) {
      chrome.storage.local.set({
        sfct_autoStart: true, sfct_level: 4, sfct_fen: fen,
        sfct_color: 'white', sfct_timestamp: Date.now()
      });
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
