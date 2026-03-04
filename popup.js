// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle');
  const status = document.getElementById('status-text');
  const dot    = document.getElementById('dot');

  function update(active) {
    toggle.textContent = active ? 'Disattiva' : 'Attiva';
    toggle.className   = active ? 'on' : 'off';
    status.textContent = active ? 'Attivo' : 'Disattivato';
    dot.className      = active ? 'dot' : 'dot off';
  }

  chrome.storage.local.get(['active'], (res) => {
    update(res.active !== false);
  });

  toggle.addEventListener('click', () => {
    chrome.storage.local.get(['active'], (res) => {
      const next = !(res.active !== false);
      chrome.storage.local.set({ active: next }, () => update(next));
    });
  });
});
