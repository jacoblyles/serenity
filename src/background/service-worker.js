// Darkside background service worker
// Handles messaging between popup/content scripts and LLM providers

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    autoMode: false,
    selectedModel: 'gpt-4.1-mini',
    feedbackText: '',
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'get-status': handleGetStatus,
    'set-status': handleSetStatus,
    'get-popup-state': handleGetPopupState,
    'set-popup-state': handleSetPopupState,
    'generate-dark-mode': handleGenerateDarkMode,
    'refine-dark-mode': handleRefineDarkMode,
  };

  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender).then(sendResponse);
    return true; // keep channel open for async response
  }
});

async function handleGetStatus() {
  const { enabled } = await chrome.storage.local.get('enabled');
  return { enabled };
}

async function handleSetStatus(message) {
  await chrome.storage.local.set({ enabled: message.enabled });
  return { enabled: message.enabled };
}

async function handleGetPopupState() {
  const state = await chrome.storage.local.get([
    'enabled',
    'autoMode',
    'selectedModel',
    'feedbackText',
  ]);

  return {
    enabled: Boolean(state.enabled),
    autoMode: Boolean(state.autoMode),
    selectedModel: state.selectedModel || 'gpt-4.1-mini',
    feedbackText: state.feedbackText || '',
  };
}

async function handleSetPopupState(message) {
  const update = {};
  if (typeof message.enabled === 'boolean') {
    update.enabled = message.enabled;
  }
  if (typeof message.autoMode === 'boolean') {
    update.autoMode = message.autoMode;
  }
  if (typeof message.selectedModel === 'string') {
    update.selectedModel = message.selectedModel;
  }
  if (typeof message.feedbackText === 'string') {
    update.feedbackText = message.feedbackText.slice(0, 500);
  }

  if (Object.keys(update).length > 0) {
    await chrome.storage.local.set(update);
  }

  return handleGetPopupState();
}

async function handleGenerateDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.4
  return { css: null, error: 'Not yet implemented' };
}

async function handleRefineDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.8
  return { css: null, error: 'Not yet implemented' };
}
