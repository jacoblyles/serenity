// Darkside background service worker
// Handles messaging between popup/content scripts and LLM providers

import { completeLlmRequest, listSupportedProviders } from './llm-client.js';

const STYLE_STORAGE_KEY = 'darkModeStyles';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: false });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'get-status': handleGetStatus,
    'set-status': handleSetStatus,
    'llm-complete': handleLlmComplete,
    'llm-providers': handleLlmProviders,
    'get-stored-style': handleGetStoredStyle,
    'save-stored-style': handleSaveStoredStyle,
    'delete-stored-style': handleDeleteStoredStyle,
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

async function handleGetStoredStyle(message, sender) {
  const rawUrl = message.url || sender?.tab?.url;
  const parsed = parseURL(rawUrl);
  if (!parsed) return { css: null, scope: null, found: false };

  const styles = await loadStyleStorage();
  const domainEntry = styles[parsed.domain];
  if (!domainEntry) return { css: null, scope: null, found: false };

  const pageCss = domainEntry.pages?.[parsed.page];
  if (typeof pageCss === 'string') {
    return { css: pageCss, scope: 'page', found: true };
  }

  if (typeof domainEntry.css === 'string') {
    return { css: domainEntry.css, scope: 'domain', found: true };
  }

  return { css: null, scope: null, found: false };
}

async function handleSaveStoredStyle(message, sender) {
  const rawUrl = message.url || sender?.tab?.url;
  const parsed = parseURL(rawUrl);
  if (!parsed || typeof message.css !== 'string') {
    return { ok: false, error: 'Invalid url or css' };
  }

  const scope = message.scope === 'page' ? 'page' : 'domain';
  const styles = await loadStyleStorage();
  const existingDomainEntry = styles[parsed.domain];
  const domainEntry = {
    css: typeof existingDomainEntry?.css === 'string' ? existingDomainEntry.css : null,
    pages: isObject(existingDomainEntry?.pages) ? existingDomainEntry.pages : {},
  };

  if (scope === 'page') {
    domainEntry.pages[parsed.page] = message.css;
  } else {
    domainEntry.css = message.css;
  }

  styles[parsed.domain] = domainEntry;
  await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: styles });

  return { ok: true, domain: parsed.domain, page: parsed.page, scope };
}

async function handleDeleteStoredStyle(message, sender) {
  const rawUrl = message.url || sender?.tab?.url;
  const parsed = parseURL(rawUrl);
  if (!parsed) return { ok: false, error: 'Invalid url' };

  const scope = message.scope === 'page' ? 'page' : 'domain';
  const styles = await loadStyleStorage();
  const domainEntry = styles[parsed.domain];
  if (!domainEntry) return { ok: true, deleted: false };

  let deleted = false;
  if (scope === 'page') {
    if (isObject(domainEntry.pages) && parsed.page in domainEntry.pages) {
      delete domainEntry.pages[parsed.page];
      deleted = true;
    }
  } else if ('css' in domainEntry) {
    domainEntry.css = null;
    deleted = true;
  }

  const hasPages = isObject(domainEntry.pages) && Object.keys(domainEntry.pages).length > 0;
  const hasDomainCss = typeof domainEntry.css === 'string';
  if (!hasPages && !hasDomainCss) {
    delete styles[parsed.domain];
  } else {
    styles[parsed.domain] = domainEntry;
  }

  await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: styles });
  return { ok: true, deleted, scope };
}

async function handleGenerateDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.4
  return { css: null, error: 'Not yet implemented' };
}

async function handleRefineDarkMode(message, sender) {
  // Placeholder: will be implemented in darkside2-b53.8
  return { css: null, error: 'Not yet implemented' };
}

async function handleLlmComplete(message) {
  try {
    const result = await completeLlmRequest(message.request || {});
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function handleLlmProviders() {
  return { providers: listSupportedProviders() };
}

async function loadStyleStorage() {
  const data = await chrome.storage.local.get(STYLE_STORAGE_KEY);
  if (!isObject(data[STYLE_STORAGE_KEY])) return {};
  return data[STYLE_STORAGE_KEY];
}

function parseURL(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;

    const domain = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const query = url.search || '';
    const page = `${path}${query}`;
    return { domain, page };
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
