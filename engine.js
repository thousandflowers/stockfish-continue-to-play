// engine.js - Shared Stockfish engine helper
// Loaded by content scripts via chrome.runtime.getURL

class StockfishEngine {
  constructor() {
    this.worker = null;
    this.onBestMove = null;
  }

  start() {
    if (this.worker) return;
    const url = chrome.runtime.getURL('stockfish.js');
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => {
      const line = e.data;
      if (typeof line === 'string' && line.startsWith('bestmove')) {
        const move = line.split(' ')[1];
        if (this.onBestMove && move && move !== '(none)') {
          this.onBestMove(move);
        }
      }
    };
    this.worker.onerror = (err) => console.error('[Stockfish+]', err);
    this.send('uci');
  }

  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  analyze(fen, elo = 1500) {
    const skill = this.eloToSkill(elo);
    this.send('ucinewgame');
    this.send(`setoption name Skill Level value ${skill}`);
    this.send(`setoption name UCI_LimitStrength value true`);
    this.send(`setoption name UCI_Elo value ${Math.min(Math.max(elo, 1320), 3190)}`);
    this.send(`position fen ${fen}`);
    this.send('go movetime 3000');
  }

  eloToSkill(elo) {
    if (elo < 800)  return 0;
    if (elo < 1000) return 3;
    if (elo < 1200) return 6;
    if (elo < 1400) return 9;
    if (elo < 1600) return 12;
    if (elo < 1800) return 15;
    if (elo < 2000) return 18;
    return 20;
  }
}
