document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle');
  const statusText = document.getElementById('status-text');
  const dot = document.getElementById('dot');

  function update(active) {
    toggle.textContent = active ? 'Disable' : 'Enable';
    toggle.className = active ? 'on' : 'off';
    statusText.textContent = active ? 'Active' : 'Disabled';
    dot.className = active ? 'dot' : 'dot off';
  }

  chrome.storage.local.get(['active'], (res) => {
    update(res.active !== false);
  });

  const strength = document.getElementById('strength');
  chrome.storage.local.get(['strength'], (res) => { strength.value = res.strength || 'auto'; });
  strength.addEventListener('change', () => {
    chrome.storage.local.set({ strength: strength.value });
  });

  toggle.addEventListener('click', () => {
    chrome.storage.local.get(['active'], (res) => {
      const next = !(res.active !== false);
      chrome.storage.local.set({ active: next }, () => update(next));
    });
  });
});
