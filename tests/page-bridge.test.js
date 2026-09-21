// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// The page-world bridge, driven for real: a fake board with a fake game, and the
// same postMessage conversation the content script has with it. What is being
// tested is the fair-play gate — the bridge must refuse to touch a board while
// Chess.com's own game says a game is being played, whatever it is asked.
const SRC = fs.readFileSync(path.resolve('page-bridge.js'), 'utf-8');

const send = (op, args) => {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve) => {
    const h = (e) => {
      if (e.data?.__sfct !== 'cmd-reply' || e.data.id !== id) return;
      window.removeEventListener('message', h);
      resolve(e.data);
    };
    window.addEventListener('message', h);
    // Dispatched by hand rather than through postMessage: jsdom leaves
    // MessageEvent.source null for a same-window post, and the bridge rightly
    // refuses anything that did not come from this window.
    window.dispatchEvent(new MessageEvent('message', {
      data: { __sfct: 'cmd', id, op, args }, source: window, origin: window.location.origin }));
    setTimeout(() => { window.removeEventListener('message', h); resolve({ ok: null, value: 'timeout' }); }, 120);
  });
};

let called;
const mountBoard = (result) => {
  called = [];
  const game = {
    getFEN: () => 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    getResult: () => result,
    getTurn: () => 1, getPlayingAs: () => 1, isGameOver: () => result !== '*', isCheck: () => false,
    createContinuation: () => { called.push('continuation'); return {}; },
    move: (a) => { called.push('move:' + JSON.stringify(a)); return {}; },
    resetToMainLine: () => { called.push('reset'); return {}; },
    getLegalMoves: () => { called.push('legal'); return ['e2e4', 'd2d4']; },
    getLegalMovesForSquare: () => { called.push('legalSquare'); return ['e2e4']; },
  };
  const el = document.createElement('wc-chess-board');
  el.game = game;
  document.body.appendChild(el);
};

describe('page-bridge fair-play gate', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; });

  // Loaded once: the bridge looks the board up on every command, so one
  // instance serves every case. Loading it per test would leave the earlier
  // instances listening and each would answer the same command.
  beforeAll(() => { (0, eval)(SRC); });

  it('refuses to move a piece while a game is being played', async () => {
    mountBoard('*');
    const r = await send('move', { from: 'e2', to: 'e4' });
    expect(r.ok).toBe(false);
    expect(called).toEqual([]); // the board was never touched
  });
  it('refuses to branch a continuation while a game is being played', async () => {
    mountBoard('*');
    expect((await send('continuation')).ok).toBe(false);
    expect(called).toEqual([]);
  });
  it('refuses to reset the line while a game is being played', async () => {
    mountBoard('*');
    expect((await send('reset')).ok).toBe(false);
    expect(called).toEqual([]);
  });
  it('an empty result is not a finished game either', async () => {
    mountBoard('');
    expect((await send('move', { from: 'e2', to: 'e4' })).ok).toBe(false);
    expect(called).toEqual([]);
  });
  it('a result that is not a string is not a finished game', async () => {
    mountBoard(undefined);
    expect((await send('move', { from: 'e2', to: 'e4' })).ok).toBe(false);
    expect(called).toEqual([]);
  });

  it('plays the move once the game has a result', async () => {
    mountBoard('0-1');
    const r = await send('move', { from: 'e2', to: 'e4' });
    expect(r.ok).toBe(true);
    expect(called).toEqual(['move:{"from":"e2","to":"e4"}']);
  });
  it('carries the promotion piece through', async () => {
    mountBoard('1-0');
    await send('move', { from: 'a7', to: 'a8', promotion: 'n' });
    expect(called[0]).toContain('"promotion":"n"');
  });
  it('branches and resets once the game has a result', async () => {
    mountBoard('1-0');
    expect((await send('continuation')).ok).toBe(true);
    expect((await send('reset')).ok).toBe(true);
    expect(called).toEqual(['continuation', 'reset']);
  });

  it('reading legal moves is allowed even mid-game - it changes nothing', async () => {
    mountBoard('*');
    const r = await send('legal');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(['e2e4', 'd2d4']);
  });
  it('an unknown command is ignored rather than guessed at', async () => {
    mountBoard('1-0');
    expect((await send('resign')).ok).toBeNull(); // no reply at all
    expect(called).toEqual([]);
  });
  it('says so when there is no board rather than failing silently', async () => {
    called = [];
    const r = await send('move', { from: 'e2', to: 'e4' });
    expect(r.ok).toBe(false);
  });
});
