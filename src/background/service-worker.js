// Serenity background service worker
// Handles messaging between popup/content scripts and LLM providers

import { completeLlmRequest, listSupportedProviders } from './llm-client.js';
import { mergeLlmSettings } from '../shared/llm-settings.js';
import { log } from '../shared/logger.js';

const STYLE_STORAGE_KEY = 'darkModeStyles';
const MAX_FEEDBACK_IMAGES = 3;
const MAX_FEEDBACK_IMAGE_BYTES = 1000000;
const MAX_FEEDBACK_IMAGE_NAME_LENGTH = 80;
const inFlightAutoGeneration = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    autoMode: false,
    selectedModel: 'gpt-5.2',
    feedbackText: '',
    feedbackImages: [],
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
    Promise.resolve()
      .then(() => handler(message, sender))
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
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
    'feedbackImages',
  ]);

  return {
    enabled: Boolean(state.enabled),
    autoMode: Boolean(state.autoMode),
    selectedModel: state.selectedModel || 'gpt-5.2',
    feedbackText: state.feedbackText || '',
    feedbackImages: sanitizeFeedbackImages(state.feedbackImages),
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
  if (Array.isArray(message.feedbackImages)) {
    update.feedbackImages = sanitizeFeedbackImages(message.feedbackImages);
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
      console.warn('Serenity auto-mode: failed to store generated CSS', saved?.error || 'Unknown error');
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
  log.info('generate', 'Starting dark mode generation', { tabId, options: { provider: options.provider, model: options.model } });

  // Detect if the page already has dark mode
  try {
    const detection = await chrome.tabs.sendMessage(tabId, { type: 'detect-dark-mode' });
    if (detection?.isDark) {
      log.info('generate', 'Page already has dark mode, skipping generation', { signals: detection.signals });
      return { css: null, skipped: true, reason: 'Page already has a dark mode', signals: detection.signals };
    }
    log.info('generate', 'Dark mode detection', { isDark: false, signals: detection?.signals });
  } catch (_error) {
    log.warn('generate', 'Dark mode detection failed, proceeding with generation');
  }

  let pageContext;
  try {
    pageContext = await chrome.tabs.sendMessage(tabId, { type: 'extract-dom' });
    log.info('generate', 'Extracted page context', { nodeCount: pageContext?.nodeCount, truncated: pageContext?.truncated, url: pageContext?.url });
  } catch (_error) {
    log.error('generate', 'Failed to extract page context', { tabId });
    return { css: null, error: 'Unable to extract page context from content script' };
  }

  const activePrompts = await getActivePrompts();
  log.info('generate', 'Using prompts', { custom: Boolean(activePrompts.system || activePrompts.user) });
  const contextJson = JSON.stringify(sanitizePageContext(pageContext));
  let userContent;
  if (activePrompts.user) {
    userContent = activePrompts.user.includes('{{context}}')
      ? activePrompts.user.replace('{{context}}', contextJson)
      : `${activePrompts.user}\n\nPage context JSON:\n${contextJson}`;
  } else {
    userContent = buildDarkModeUserPrompt(pageContext);
  }

  const request = {
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    model: typeof options.model === 'string' ? options.model : undefined,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 1500,
    systemPrompt: activePrompts.system || buildDarkModeSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  };

  log.info('generate', 'Sending LLM request', { provider: request.provider, model: request.model, messageLength: typeof userContent === 'string' ? userContent.length : 0 });

  let llmResult;
  try {
    llmResult = await completeLlmRequest(request);
    log.info('generate', 'LLM response received', { provider: llmResult.provider, model: llmResult.model, textLength: llmResult.text?.length || 0 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to generate CSS';
    log.error('generate', 'LLM request failed', { error: msg });
    return { css: null, error: msg };
  }

  const css = extractCssFromModelText(llmResult.text || '');
  if (!css) {
    log.warn('generate', 'Response did not contain valid CSS', { rawTextPreview: (llmResult.text || '').slice(0, 200) });
    return { css: null, error: 'Provider response did not contain valid CSS' };
  }

  log.info('generate', 'CSS extracted', { cssLength: css.length });

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'apply-css', css });
    log.info('generate', 'CSS applied to tab', { tabId });
  } catch (_error) {
    log.error('generate', 'Failed to apply CSS to tab', { tabId });
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

async function handleRefineDarkMode(message, sender) {
  log.info('refine', 'Starting dark mode refinement');

  const tabId = await resolveTabIdWithFallback(message, sender);
  if (tabId === null) {
    log.error('refine', 'No active tab available');
    return { css: null, error: 'No active tab available for refinement' };
  }

  const feedback = await resolveRefinementFeedback(message);
  const feedbackImages = await resolveRefinementImages(message);
  log.info('refine', 'Feedback resolved', { feedbackLength: feedback?.length || 0, imageCount: feedbackImages.length });
  if (!feedback && feedbackImages.length === 0) {
    return { css: null, error: 'Feedback text or screenshot is required for refinement' };
  }

  let pageContext;
  try {
    pageContext = await chrome.tabs.sendMessage(tabId, { type: 'extract-dom' });
  } catch (_error) {
    log.error('refine', 'Failed to extract page context');
    return { css: null, error: 'Unable to extract page context from content script' };
  }

  const currentCss = await resolveCurrentCssForRefinement(message, sender, tabId);
  if (!currentCss) {
    log.warn('refine', 'No current CSS found to refine');
    return { css: null, error: 'No current CSS found to refine' };
  }
  log.info('refine', 'Current CSS resolved', { cssLength: currentCss.length });

  const request = {
    provider: typeof message.provider === 'string' ? message.provider : undefined,
    model: typeof message.model === 'string' ? message.model : undefined,
    temperature: typeof message.temperature === 'number' ? message.temperature : 0.2,
    maxTokens: typeof message.maxTokens === 'number' ? message.maxTokens : 1500,
    systemPrompt: buildRefineSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildRefineUserPrompt({
          pageContext,
          currentCss,
          feedback,
          feedbackImages,
        }),
      },
    ],
  };

  log.info('refine', 'Sending LLM request', { provider: request.provider, model: request.model });

  let llmResult;
  try {
    llmResult = await completeLlmRequest(request);
    log.info('refine', 'LLM response received', { provider: llmResult.provider, model: llmResult.model, textLength: llmResult.text?.length || 0 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to refine CSS';
    log.error('refine', 'LLM request failed', { error: msg });
    return { css: null, error: msg };
  }

  const css = extractCssFromModelText(llmResult.text || '');
  if (!css) {
    log.warn('refine', 'Response did not contain valid CSS', { rawTextPreview: (llmResult.text || '').slice(0, 200) });
    return { css: null, error: 'Provider response did not contain valid CSS' };
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'apply-css', css });
    log.info('refine', 'Refined CSS applied', { tabId, cssLength: css.length });
  } catch (_error) {
    log.error('refine', 'Failed to apply refined CSS');
    return { css: null, error: 'Refined CSS generated, but failed to apply it to the page' };
  }

  return {
    css,
    applied: true,
    provider: llmResult.provider,
    model: llmResult.model,
    feedbackUsed: feedback,
    feedbackImageCount: feedbackImages.length,
    truncatedContext: Boolean(pageContext?.truncated),
    nodeCount: pageContext?.nodeCount || 0,
  };
}

async function resolveTabIdWithFallback(message, sender) {
  const resolved = resolveTabId(message, sender);
  if (resolved !== null) return resolved;

  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return Number.isInteger(tabs[0]?.id) ? tabs[0].id : null;
  } catch {
    return null;
  }
}

async function getActivePrompts() {
  const { llmSettings } = await chrome.storage.local.get('llmSettings');
  const settings = mergeLlmSettings(llmSettings);

  if (!settings.prompts?.activeId) {
    return { system: null, user: null };
  }

  const custom = (settings.prompts.custom || []).find(
    (p) => p.id === settings.prompts.activeId
  );
  if (!custom) {
    return { system: null, user: null };
  }

  return {
    system: custom.system || null,
    user: custom.user || null,
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

function buildRefineSystemPrompt() {
  return [
    'You are a CSS-only assistant.',
    'Refine an existing dark mode stylesheet using explicit user feedback.',
    'Return CSS only. Do not include Markdown or explanations.',
    'Preserve the current layout and only adjust styles needed to satisfy feedback.',
    'Keep accessibility and contrast strong across text, controls, and interactive states.',
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

function buildRefineUserPrompt({ pageContext, currentCss, feedback, feedbackImages }) {
  const safeContext = sanitizePageContext(pageContext);
  const contextJson = JSON.stringify(safeContext);
  const safeFeedback = feedback || '(no text feedback provided; use screenshots to infer issues)';
  const textPrompt = [
    'Refine the existing dark mode CSS based on user feedback.',
    'Requirements:',
    '- Keep improvements already present unless feedback requests changes.',
    '- Preserve structure, spacing, and layout behavior.',
    '- Maintain accessible contrast and visible interactive states.',
    '- Return a full replacement CSS stylesheet.',
    'User feedback:',
    safeFeedback,
    'Current CSS:',
    currentCss,
    'Page context JSON:',
    contextJson,
  ].join('\n');

  if (!feedbackImages.length) {
    return textPrompt;
  }

  return [
    { type: 'text', text: `${textPrompt}\nAttached screenshots: ${feedbackImages.length}` },
    ...feedbackImages.map((image) => ({
      type: 'image_url',
      image_url: { url: image.dataUrl },
    })),
  ];
}

async function resolveRefinementFeedback(message) {
  if (typeof message?.feedback === 'string') {
    const fromMessage = message.feedback.trim().slice(0, 500);
    if (fromMessage) return fromMessage;
  }

  const { feedbackText } = await chrome.storage.local.get('feedbackText');
  if (typeof feedbackText !== 'string') return '';
  return feedbackText.trim().slice(0, 500);
}

async function resolveRefinementImages(message) {
  if (Array.isArray(message?.feedbackImages)) {
    return sanitizeFeedbackImages(message.feedbackImages);
  }

  const { feedbackImages } = await chrome.storage.local.get('feedbackImages');
  return sanitizeFeedbackImages(feedbackImages);
}

async function resolveCurrentCssForRefinement(message, sender, tabId) {
  if (typeof message?.currentCss === 'string' && message.currentCss.trim()) {
    return message.currentCss.trim();
  }

  try {
    const applied = await chrome.tabs.sendMessage(tabId, { type: 'get-applied-css' });
    if (typeof applied?.css === 'string' && applied.css.trim()) {
      return applied.css.trim();
    }
  } catch {
    // Continue to stored CSS fallback.
  }

  let tabUrl = sender?.tab?.url;
  if (!tabUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab?.url;
    } catch {
      tabUrl = null;
    }
  }

  const stored = await getStoredStyleForUrl(tabUrl);
  if (typeof stored?.css === 'string' && stored.css.trim()) {
    return stored.css.trim();
  }

  return '';
}

function sanitizeFeedbackImages(images) {
  if (!Array.isArray(images)) return [];
  const sanitized = [];

  for (const image of images) {
    if (!isObject(image)) continue;
    if (typeof image.dataUrl !== 'string') continue;
    if (!image.dataUrl.startsWith('data:image/')) continue;
    if (typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) continue;
    if (!Number.isFinite(image.sizeBytes) || image.sizeBytes <= 0) continue;
    if (image.sizeBytes > MAX_FEEDBACK_IMAGE_BYTES) continue;

    sanitized.push({
      id:
        typeof image.id === 'string' && image.id
          ? image.id
          : `img-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      name:
        typeof image.name === 'string' && image.name
          ? image.name.slice(0, MAX_FEEDBACK_IMAGE_NAME_LENGTH)
          : 'screenshot.webp',
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.dataUrl,
    });

    if (sanitized.length >= MAX_FEEDBACK_IMAGES) break;
  }

  return sanitized;
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
