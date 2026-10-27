const enabled = document.getElementById('enabled');
const modifier = document.getElementById('modifier');
const hint = document.getElementById('hint');

const showHint = () => { hint.textContent = modifier.value === 'alt' ? '按住 Option' : '按住 Shift'; };

chrome.storage.sync.get({ enabled: true, modifier: 'shift' }).then((s) => {
  enabled.checked = s.enabled;
  modifier.value = s.modifier;
  showHint();
});

enabled.addEventListener('change', () => chrome.storage.sync.set({ enabled: enabled.checked }));
modifier.addEventListener('change', () => { chrome.storage.sync.set({ modifier: modifier.value }); showHint(); });
