// Lichess utility functions for Stockfish Continue to Play.
// Shared between content_lichess.js and automated tests.
// No chrome.* or Worker dependencies — pure DOM-only functions.

function isGameOver() {
  return !!(
    document.querySelector('.result-wrap') ||
    document.querySelector('.game__result') ||
    document.querySelector('.crosstable__score')
  );
}

function findEditorButton(root) {
  const el = root.querySelector('a[href*="/setup/ai"]');
  if (el) return el;
  const keywords = ['computer', 'stockfish', 'engine'];
  for (const kw of keywords) {
    const found = root.querySelector('a, button');
    if (found && found.textContent.toLowerCase().includes(kw)) return found;
  }
  return null;
}

function findLevelInput(root, level) {
  const selectors = [
    'input[name="level"]',
    'select[name="level"]',
    '.level-choice input',
    '.sf-level input',
    `[data-level="${level}"]`,
    `.level-${level}`,
  ];
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}

function findSubmitButton(root) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    '.submit',
    'form button:last-child',
  ];
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}

function buildAIForm(level, color, fen) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/setup/ai';
  const fields = {
    variant: '1',
    fenVariant: fen || '',
    level: String(level),
    color: color,
    time: '10',
    increment: '5',
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  return form;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isGameOver,
    findEditorButton,
    findLevelInput,
    findSubmitButton,
    buildAIForm,
  };
}
