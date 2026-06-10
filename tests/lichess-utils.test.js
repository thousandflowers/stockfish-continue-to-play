import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';

let utils;

beforeAll(async () => {
  const mod = await import(path.resolve('lib/lichess-utils.js'));
  utils = mod;
});

// ── isGameOver ────────────────────────────────────────────────────────────

describe('isGameOver (Lichess)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('false by default', () => {
    expect(utils.isGameOver()).toBe(false);
  });

  it('detects .result-wrap', () => {
    const e = document.createElement('div');
    e.className = 'result-wrap';
    document.body.appendChild(e);
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .game__result', () => {
    const e = document.createElement('div');
    e.className = 'game__result';
    document.body.appendChild(e);
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .crosstable__score', () => {
    const e = document.createElement('div');
    e.className = 'crosstable__score';
    document.body.appendChild(e);
    expect(utils.isGameOver()).toBe(true);
  });
});

// ── findEditorButton ─────────────────────────────────────────────────────

describe('findEditorButton', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('finds a[href*="/setup/ai"]', () => {
    const a = document.createElement('a');
    a.href = '/setup/ai';
    a.textContent = 'Play with AI';
    document.body.appendChild(a);
    expect(utils.findEditorButton(document)).toBe(a);
  });

  it('finds link containing "computer"', () => {
    const a = document.createElement('a');
    a.textContent = 'vs Computer';
    document.body.appendChild(a);
    expect(utils.findEditorButton(document)).toBe(a);
  });

  it('finds button containing "stockfish"', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Stockfish Level';
    document.body.appendChild(btn);
    expect(utils.findEditorButton(document)).toBe(btn);
  });

  it('returns null when no match', () => {
    const d = document.createElement('div');
    d.textContent = 'irrelevant';
    document.body.appendChild(d);
    expect(utils.findEditorButton(document)).toBeNull();
  });
});

// ── findLevelInput ───────────────────────────────────────────────────────

describe('findLevelInput', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('finds input[name="level"]', () => {
    const inp = document.createElement('input');
    inp.name = 'level';
    document.body.appendChild(inp);
    expect(utils.findLevelInput(document, 4)).toBe(inp);
  });

  it('finds select[name="level"]', () => {
    const sel = document.createElement('select');
    sel.name = 'level';
    document.body.appendChild(sel);
    expect(utils.findLevelInput(document, 4)).toBe(sel);
  });

  it('finds [data-level="N"]', () => {
    const e = document.createElement('div');
    e.setAttribute('data-level', '6');
    document.body.appendChild(e);
    expect(utils.findLevelInput(document, 6)).toBe(e);
  });

  it('finds .level-N', () => {
    const e = document.createElement('div');
    e.className = 'level-3';
    document.body.appendChild(e);
    expect(utils.findLevelInput(document, 3)).toBe(e);
  });

  it('finds .level-choice input', () => {
    const inp = document.createElement('input');
    const parent = document.createElement('div');
    parent.className = 'level-choice';
    parent.appendChild(inp);
    document.body.appendChild(parent);
    expect(utils.findLevelInput(document, 4)).toBe(inp);
  });

  it('returns null when no match', () => {
    document.body.appendChild(document.createElement('div'));
    expect(utils.findLevelInput(document, 8)).toBeNull();
  });
});

// ── findSubmitButton ─────────────────────────────────────────────────────

describe('findSubmitButton', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('finds button[type="submit"]', () => {
    const btn = document.createElement('button');
    btn.type = 'submit';
    document.body.appendChild(btn);
    expect(utils.findSubmitButton(document)).toBe(btn);
  });

  it('finds input[type="submit"]', () => {
    const inp = document.createElement('input');
    inp.type = 'submit';
    document.body.appendChild(inp);
    expect(utils.findSubmitButton(document)).toBe(inp);
  });

  it('finds .submit', () => {
    const btn = document.createElement('button');
    btn.className = 'submit';
    document.body.appendChild(btn);
    expect(utils.findSubmitButton(document)).toBe(btn);
  });

  it('finds form button:last-child', () => {
    const form = document.createElement('form');
    const btn = document.createElement('button');
    form.appendChild(btn);
    document.body.appendChild(form);
    expect(utils.findSubmitButton(document)).toBe(btn);
  });

  it('returns null when no match', () => {
    expect(utils.findSubmitButton(document)).toBeNull();
  });
});

// ── buildAIForm ──────────────────────────────────────────────────────────

describe('buildAIForm', () => {
  it('POST to /setup/ai', () => {
    const f = utils.buildAIForm(4, 'white', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(f.method).toBe('post');
    expect(f.getAttribute('action')).toBe('/setup/ai');
  });

  it('includes all expected hidden fields', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const f = utils.buildAIForm(6, 'black', fen);
    const inputs = f.querySelectorAll('input[type="hidden"]');
    const data = {};
    inputs.forEach(inp => { data[inp.name] = inp.value; });
    expect(data).toEqual({
      variant: '1',
      fenVariant: fen,
      level: '6',
      color: 'black',
      time: '10',
      increment: '5',
    });
  });

  it('empty fenVariant when fen omitted', () => {
    const f = utils.buildAIForm(1, 'random');
    expect(f.querySelector('input[name="fenVariant"]').value).toBe('');
  });
});
