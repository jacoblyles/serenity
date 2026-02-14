// Darkside background service worker
// Handles messaging between popup/content scripts and LLM providers

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'get-status': handleGetStatus,
    'set-status': handleSetStatus,
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

async function handleGenerateDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.4
  return { css: null, error: 'Not yet implemented' };
}

async function handleRefineDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.8
  return { css: null, error: 'Not yet implemented' };
}
