// service-worker.js
// Minimal service worker required by MV3.
// Stockfish runs as a Web Worker directly in the content scripts.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ active: true });
  console.log('[Stockfish+] Installato e pronto.');
});
