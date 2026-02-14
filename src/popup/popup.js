const toggle = document.getElementById('toggle-dark-mode');
const label = document.getElementById('toggle-label');
const status = document.getElementById('status');

async function init() {
  const response = await chrome.runtime.sendMessage({ type: 'get-status' });
  toggle.checked = response.enabled;
  label.textContent = response.enabled ? 'On' : 'Off';
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.runtime.sendMessage({ type: 'set-status', enabled });
  label.textContent = enabled ? 'On' : 'Off';
});

init();
