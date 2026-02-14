const toggle = document.getElementById('toggle-dark-mode');
const autoToggle = document.getElementById('toggle-auto-mode');
const label = document.getElementById('toggle-label');
const autoLabel = document.getElementById('auto-toggle-label');
const modelSelector = document.getElementById('model-selector');
const feedbackText = document.getElementById('feedback-text');
const status = document.getElementById('status');
let feedbackSaveTimer = null;

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-popup-state' });
    toggle.checked = Boolean(response.enabled);
    autoToggle.checked = Boolean(response.autoMode);
    label.textContent = response.enabled ? 'On' : 'Off';
    autoLabel.textContent = response.autoMode ? 'On' : 'Off';
    if (response.selectedModel) {
      modelSelector.value = response.selectedModel;
    }
    feedbackText.value = response.feedbackText || '';
    status.textContent = '';
  } catch (error) {
    status.textContent = 'Unable to load popup state';
  }
}

async function saveState(partialState) {
  try {
    await chrome.runtime.sendMessage({ type: 'set-popup-state', ...partialState });
    status.textContent = 'Saved';
    setTimeout(() => {
      status.textContent = '';
    }, 900);
  } catch (error) {
    status.textContent = 'Failed to save changes';
  }
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  label.textContent = enabled ? 'On' : 'Off';
  await saveState({ enabled });
});

autoToggle.addEventListener('change', async () => {
  const autoMode = autoToggle.checked;
  autoLabel.textContent = autoMode ? 'On' : 'Off';
  await saveState({ autoMode });
});

modelSelector.addEventListener('change', async () => {
  await saveState({ selectedModel: modelSelector.value });
});

feedbackText.addEventListener('input', async () => {
  clearTimeout(feedbackSaveTimer);
  feedbackSaveTimer = setTimeout(() => {
    saveState({ feedbackText: feedbackText.value });
  }, 250);
});

init();
