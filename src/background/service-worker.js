// Darkside background service worker
// Handles messaging between popup/content scripts and LLM providers

import { completeLlmRequest, listSupportedProviders } from './llm-client.js';

const STYLE_STORAGE_KEY = 'darkModeStyles';
const inFlightAutoGeneration = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    autoMode: false,
    selectedModel: 'gpt-4.1-mini',
    feedbackText: '',
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (typeof tab?.url !== 'string') return;
  void syncTabRememberedStyle(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab?.url !== 'string') return;
    await syncTabRememberedStyle(tabId, tab.url);
  } catch {
    // Ignore tabs that cannot be queried.
  }
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
  if (!message.enabled) {
    try {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map((tab) => removeCssFromTab(tab.id)));
    } catch {
      // Ignore tab query/send failures.
    }
  }
  return { enabled: message.enabled };
}

async function handleGetStoredStyle(message, sender) {
  const rawUrl = message.url || sender?.tab?.url;
  return getStoredStyleForUrl(rawUrl);
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
  const tabId = resolveTabId(message, sender);
  if (tabId === null) {
    return { css: null, error: 'No active tab available for generation' };
  }
  return generateAndApplyDarkMode(tabId, message);
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

async function getStoredStyleForUrl(rawUrl) {
  const parsed = parseURL(rawUrl);
  if (!parsed) return { css: null, scope: null, found: false };

  const styles = await loadStyleStorage();
  return getStoredStyleForParsedUrl(parsed, styles);
}

async function syncTabRememberedStyle(tabId, url) {
  if (typeof tabId !== 'number') return;

  const { enabled, autoMode, selectedModel } = await chrome.storage.local.get([
    'enabled',
    'autoMode',
    'selectedModel',
  ]);
  if (!enabled) {
    await removeCssFromTab(tabId);
    return;
  }

  const parsed = parseURL(url);
  if (!parsed) {
    await removeCssFromTab(tabId);
    return;
  }

  const styles = await loadStyleStorage();
  const stored = getStoredStyleForParsedUrl(parsed, styles);
  if (stored.found && typeof stored.css === 'string') {
    await sendMessageToTab(tabId, { type: 'apply-css', css: stored.css });
    return;
  }

  if (autoMode && shouldAutoGenerateForDomain(parsed.domain, styles)) {
    await maybeAutoGenerateForTab(tabId, url, selectedModel);
    return;
  }

  await removeCssFromTab(tabId);
}

async function maybeAutoGenerateForTab(tabId, url, selectedModel) {
  const dedupeKey = `${tabId}:${url}`;
  if (inFlightAutoGeneration.has(dedupeKey)) return;

  inFlightAutoGeneration.add(dedupeKey);
  try {
    const result = await generateAndApplyDarkMode(tabId, {
      model: typeof selectedModel === 'string' ? selectedModel : undefined,
    });
    if (!result?.css || result.error) return;

    const saved = await handleSaveStoredStyle({ url, css: result.css, scope: 'domain' });
    if (!saved?.ok) {
      console.warn('Darkside auto-mode: failed to store generated CSS', saved?.error || 'Unknown error');
    }
  } finally {
    inFlightAutoGeneration.delete(dedupeKey);
  }
}

async function removeCssFromTab(tabId) {
  if (typeof tabId !== 'number') return;
  await sendMessageToTab(tabId, { type: 'remove-css' });
}

async function sendMessageToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Ignore tabs without our content script (e.g. chrome:// pages).
  }
}

function shouldAutoGenerateForDomain(domain, styles) {
  if (typeof domain !== 'string' || !domain) return false;
  if (!isObject(styles)) return true;
  return !Object.hasOwn(styles, domain);
}

function parseURL(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
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

function getStoredStyleForParsedUrl(parsed, styles) {
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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveTabId(message, sender) {
  if (Number.isInteger(message?.tabId)) return message.tabId;
  if (Number.isInteger(sender?.tab?.id)) return sender.tab.id;
  return null;
}

async function generateAndApplyDarkMode(tabId, options = {}) {
  let pageContext;
  try {
    pageContext = await chrome.tabs.sendMessage(tabId, { type: 'extract-dom' });
  } catch (_error) {
    return { css: null, error: 'Unable to extract page context from content script' };
  }

  const request = {
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    model: typeof options.model === 'string' ? options.model : undefined,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1500,
    systemPrompt: buildDarkModeSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildDarkModeUserPrompt(pageContext),
      },
    ],
  };

  let llmResult;
  try {
    llmResult = await completeLlmRequest(request);
  } catch (error) {
    return { css: null, error: error instanceof Error ? error.message : 'Failed to generate CSS' };
  }

  const css = extractCssFromModelText(llmResult.text || '');
  if (!css) {
    return { css: null, error: 'Provider response did not contain valid CSS' };
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'apply-css', css });
  } catch (_error) {
    return { css: null, error: 'Generated CSS, but failed to apply it to the page' };
  }

  return {
    css,
    applied: true,
    provider: llmResult.provider,
    model: llmResult.model,
    truncatedContext: Boolean(pageContext?.truncated),
    nodeCount: pageContext?.nodeCount || 0,
  };
}

function buildDarkModeSystemPrompt() {
  return [
    'You are a CSS-only assistant.',
    'Generate dark mode CSS for the provided webpage context.',
    'Return CSS only. Do not include Markdown or explanations.',
    'Preserve readability and contrast while minimizing layout changes.',
    'Prefer scoped overrides on common selectors and avoid !important unless necessary.',
  ].join(' ');
}

function buildDarkModeUserPrompt(pageContext) {
  const safeContext = sanitizePageContext(pageContext);
  const contextJson = JSON.stringify(safeContext);

  return [
    'Create CSS that applies a visually pleasing dark theme to this page context.',
    'Goals:',
    '- Darken page backgrounds while preserving hierarchy.',
    '- Use light text with sufficient contrast.',
    '- Keep links/buttons distinguishable and accessible.',
    '- Handle forms, tables, cards, and code blocks when present.',
    '- Do not hide content or change spacing/layout dramatically.',
    'Page context JSON:',
    contextJson,
  ].join('\n');
}

function sanitizePageContext(pageContext) {
  if (!isObject(pageContext)) {
    return {
      url: '',
      title: '',
      nodeCount: 0,
      truncated: true,
      dom: null,
    };
  }

  return {
    url: typeof pageContext.url === 'string' ? pageContext.url : '',
    hostname: typeof pageContext.hostname === 'string' ? pageContext.hostname : '',
    title: typeof pageContext.title === 'string' ? pageContext.title : '',
    viewport: isObject(pageContext.viewport)
      ? {
          width: Number.isFinite(pageContext.viewport.width) ? pageContext.viewport.width : null,
          height: Number.isFinite(pageContext.viewport.height) ? pageContext.viewport.height : null,
        }
      : null,
    nodeCount: Number.isFinite(pageContext.nodeCount) ? pageContext.nodeCount : 0,
    truncated: Boolean(pageContext.truncated),
    dom: pageContext.dom || null,
  };
}

function extractCssFromModelText(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:css)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (!candidate) return '';

  const normalized = candidate
    .replace(/^\s*<style[^>]*>/i, '')
    .replace(/<\/style>\s*$/i, '')
    .trim();

  if (!looksLikeCss(normalized)) return '';
  return normalized;
}

function looksLikeCss(text) {
  return /[.#:]?[a-zA-Z][a-zA-Z0-9_:\-#.*\s>,+~[\]="'()]*\{[^{}]*\}/.test(text);
}
