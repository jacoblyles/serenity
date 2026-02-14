const toggle = document.getElementById('toggle-dark-mode');
const autoToggle = document.getElementById('toggle-auto-mode');
const label = document.getElementById('toggle-label');
const autoLabel = document.getElementById('auto-toggle-label');
const modelSelector = document.getElementById('model-selector');
const modelStrongerBtn = document.getElementById('model-stronger-btn');
const modelResetBtn = document.getElementById('model-reset-btn');
const modelHint = document.getElementById('model-hint');
const feedbackText = document.getElementById('feedback-text');
const status = document.getElementById('status');
let feedbackSaveTimer = null;

const DEFAULT_MODEL = 'gpt-4.1-mini';
const MODEL_STRENGTH_ORDER = [
  'gpt-4.1-mini',
  'gemini-2.0-flash',
  'gpt-4.1',
  'claude-3-5-sonnet-latest',
];
const MODEL_ALIASES = {
  'claude-3-5-sonnet': 'claude-3-5-sonnet-latest',
};

function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

function getSelectedModelLabel() {
  return modelSelector.options[modelSelector.selectedIndex]?.text || modelSelector.value;
}

function updateModelHint() {
  modelHint.textContent = `Current: ${getSelectedModelLabel()}`;
}

function setSelectedModel(model) {
  const normalizedModel = normalizeModel(model);
  modelSelector.value = normalizedModel;
  updateModelHint();
}

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-popup-state' });
    toggle.checked = Boolean(response.enabled);
    autoToggle.checked = Boolean(response.autoMode);
    label.textContent = response.enabled ? 'On' : 'Off';
    autoLabel.textContent = response.autoMode ? 'On' : 'Off';
    setSelectedModel(response.selectedModel);
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
  setSelectedModel(modelSelector.value);
  await saveState({ selectedModel: normalizeModel(modelSelector.value) });
});

feedbackText.addEventListener('input', async () => {
  clearTimeout(feedbackSaveTimer);
  feedbackSaveTimer = setTimeout(() => {
    saveState({ feedbackText: feedbackText.value });
  }, 250);
});

modelStrongerBtn.addEventListener('click', async () => {
  const currentModel = normalizeModel(modelSelector.value);
  const currentIndex = MODEL_STRENGTH_ORDER.indexOf(currentModel);
  const nextModel =
    currentIndex === -1
      ? MODEL_STRENGTH_ORDER[MODEL_STRENGTH_ORDER.length - 1]
      : MODEL_STRENGTH_ORDER[Math.min(currentIndex + 1, MODEL_STRENGTH_ORDER.length - 1)];

  if (nextModel === currentModel) {
    status.textContent = 'Already using strongest quick-switch model';
    return;
  }

  setSelectedModel(nextModel);
  await saveState({ selectedModel: nextModel });
});

modelResetBtn.addEventListener('click', async () => {
  const currentModel = normalizeModel(modelSelector.value);
  if (currentModel === DEFAULT_MODEL) {
    status.textContent = 'Already using default model';
    return;
  }

  setSelectedModel(DEFAULT_MODEL);
  await saveState({ selectedModel: DEFAULT_MODEL });
});

init();
