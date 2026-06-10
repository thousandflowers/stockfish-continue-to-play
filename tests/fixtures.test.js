import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

let chessUtils, lichessUtils;

function loadFixture(name) {
  return fs.readFileSync(
    path.resolve('tests/fixtures', name),
    'utf-8'
  );
}

beforeAll(async () => {
  const chessMod = await import(path.resolve('lib/chess-utils.js'));
  chessUtils = chessMod;
  const lichessMod = await import(path.resolve('lib/lichess-utils.js'));
  lichessUtils = lichessMod;
});

describe('Fixture: chesscom-gameover-attr', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('chesscom-gameover-attr.html');
  });

  it('extracts FEN from game-fen attribute (method 1)', () => {
    expect(chessUtils.getFEN()).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    );
  });

  it('extracts opponent Elo from user-tagline-rating (strategy 1)', () => {
    expect(chessUtils.getOpponentElo()).toBe(1850);
  });

  it('detects white orientation (default)', () => {
    expect(chessUtils.getPlayerColor()).toBe('white');
  });

  it('detects game over via game-over-modal-content', () => {
    expect(chessUtils.isGameOver()).toBe(true);
  });
});

describe('Fixture: chesscom-gameover-react', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('chesscom-gameover-react.html');
  });

  it('rejects invalid rating 42 and falls through to default 1500', () => {
    expect(chessUtils.getOpponentElo()).toBe(1500);
  });

  it('no FEN when no attribute and no pieces (empty board)', () => {
    expect(chessUtils.getFEN()).toBeNull();
  });
});

describe('Fixture: chesscom-gameover-pieces', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('chesscom-gameover-pieces.html');
  });

  it('extracts FEN from light DOM pieces (method 3)', () => {
    const fen = chessUtils.getFEN();
    expect(fen).toMatch(/^rnbqkbnr\/pppppppp\//);
    expect(fen).toContain(' b ');
  });

  it('extracts Elo from data-opponent-rating (strategy 3)', () => {
    expect(chessUtils.getOpponentElo()).toBe(1740);
  });

  it('detects game over via game-over-modal-component', () => {
    expect(chessUtils.isGameOver()).toBe(true);
  });
});

describe('Fixture: chesscom-elo-strategies', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('chesscom-elo-strategies.html');
  });

  it('strategy 1 (user-tagline-rating=1850) beats strategy 2 (1920)', () => {
    expect(chessUtils.getOpponentElo()).toBe(1850);
  });

  it('no FEN (no board element)', () => {
    expect(chessUtils.getFEN()).toBeNull();
  });

  it('no game over detected', () => {
    expect(chessUtils.isGameOver()).toBe(false);
  });
});

describe('Fixture: chesscom-flipped-board', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('chesscom-flipped-board.html');
  });

  it('extracts FEN from attribute', () => {
    expect(chessUtils.getFEN()).toBe(
      'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
    );
  });

  it('detects black as player color (flipped)', () => {
    expect(chessUtils.getPlayerColor()).toBe('black');
  });

  it('extracts opponent Elo', () => {
    expect(chessUtils.getOpponentElo()).toBe(2030);
  });
});

describe('Fixture: lichess-editor', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('lichess-editor.html');
  });

  it('finds editor button via a[href*="/setup/ai"]', () => {
    const btn = lichessUtils.findEditorButton(document);
    expect(btn).not.toBeNull();
    expect(btn.href).toContain('/setup/ai');
  });

  it('finds level input via select[name="level"]', () => {
    const inp = lichessUtils.findLevelInput(document, 4);
    expect(inp).not.toBeNull();
    expect(inp.name).toBe('level');
  });

  it('finds submit button via .submit', () => {
    const btn = lichessUtils.findSubmitButton(document);
    expect(btn).not.toBeNull();
    expect(btn.className).toBe('submit');
  });
});

describe('Fixture: lichess-gameover', () => {
  beforeAll(() => {
    document.body.innerHTML = loadFixture('lichess-gameover.html');
  });

  it('detects game over via result-wrap', () => {
    expect(lichessUtils.isGameOver()).toBe(true);
  });
});
