// Serenity background service worker
// Handles messaging between popup/content scripts and LLM providers

import { completeLlmRequest, listSupportedProviders } from './llm-client.js';
import { runAgentLoop } from './agent.js';
import { mergeLlmSettings, PROVIDER_MODELS } from '../shared/llm-settings.js';
import { log } from '../shared/logger.js';
import {
  generationStarted,
  generationCompleted,
  generationFailed,
} from '../shared/metrics.js';
import {
  STYLE_STORAGE_KEY,
  MAX_VERSIONS,
  ensureMigratedStyles,
  createVersion,
} from '../shared/style-storage.js';

const MAX_FEEDBACK_IMAGES = 3;
const MAX_FEEDBACK_IMAGE_BYTES = 1000000;
const MAX_FEEDBACK_IMAGE_NAME_LENGTH = 80;
const MAX_GENERATION_SCREENSHOT_DATA_URL_LENGTH = 1_200_000;
const NATIVE_DARK_MODE_DIRECT_APPLY_MIN_BYTES = 500;
const MAX_CONTEXT_DOM_NODES = 260;
const MAX_CONTEXT_DOM_DEPTH = 5;
const MAX_CONTEXT_DOM_CHILDREN = 14;
const MAX_CONTEXT_DOM_NODES_WITH_SCREENSHOT = 140;
const MAX_CONTEXT_DOM_DEPTH_WITH_SCREENSHOT = 4;
const MAX_CONTEXT_DOM_CHILDREN_WITH_SCREENSHOT = 10;
const MAX_CONTEXT_DOM_NODES_WITH_COLOR_MAP = 180;
const MAX_CONTEXT_DOM_DEPTH_WITH_COLOR_MAP = 5;
const MAX_CONTEXT_DOM_CHILDREN_WITH_COLOR_MAP = 10;
const MAX_CONTEXT_DOM_NODES_WITH_COLOR_MAP_AND_SCREENSHOT = 120;
const MAX_CONTEXT_DOM_DEPTH_WITH_COLOR_MAP_AND_SCREENSHOT = 4;
const MAX_CONTEXT_DOM_CHILDREN_WITH_COLOR_MAP_AND_SCREENSHOT = 8;
const MAX_CONTEXT_COLOR_MAP_ENTRIES = 200;
const MAX_CONTEXT_COLOR_MAP_SELECTOR_LENGTH = 180;
const MAX_CONTEXT_COLOR_LIST = 120;
const inFlightAutoGeneration = new Set();
const KNOWN_MODEL_IDS = new Set(
  Object.values(PROVIDER_MODELS)
    .flat()
    .map((model) => model.id)
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    autoMode: false,
    twoPass: true,
    generationMode: 'quick',
    agentMaxTurns: 5,
    autoThoroughMode: false,
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
    'generate-dark-mode-agent': handleGenerateDarkModeAgent,
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

  if (!styles[parsed.domain]) {
    styles[parsed.domain] = { activeVersionId: null, versions: [], pages: {} };
  }
  const entry = styles[parsed.domain];

  const newVersion = createVersion(message.css, {
    scope,
    prefix: scope === 'page' ? 'pv' : 'v',
    provider: message.provider || null,
    model: message.model || null,
  });

  if (scope === 'page') {
    if (!entry.pages[parsed.page]) {
      entry.pages[parsed.page] = { activeVersionId: null, versions: [] };
    }
    const pageEntry = entry.pages[parsed.page];
    pageEntry.versions.unshift(newVersion);
    pageEntry.versions = pageEntry.versions.slice(0, MAX_VERSIONS);
    pageEntry.activeVersionId = newVersion.id;
  } else {
    entry.versions.unshift(newVersion);
    entry.versions = entry.versions.slice(0, MAX_VERSIONS);
    entry.activeVersionId = newVersion.id;
  }

  await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: styles });
  return { ok: true, domain: parsed.domain, page: parsed.page, scope, versionId: newVersion.id };
}

async function handleDeleteStoredStyle(message, sender) {
  const rawUrl = message.url || sender?.tab?.url;
  const parsed = parseURL(rawUrl);
  if (!parsed) return { ok: false, error: 'Invalid url' };

  const scope = message.scope === 'page' ? 'page' : 'domain';
  const styles = await loadStyleStorage();
  const entry = styles[parsed.domain];
  if (!entry) return { ok: true, deleted: false };

  let deleted = false;
  if (scope === 'page') {
    if (isObject(entry.pages) && parsed.page in entry.pages) {
      delete entry.pages[parsed.page];
      deleted = true;
    }
  } else {
    entry.versions = [];
    entry.activeVersionId = null;
    deleted = true;
  }

  const hasPages = isObject(entry.pages) && Object.keys(entry.pages).length > 0;
  const hasVersions = Array.isArray(entry.versions) && entry.versions.length > 0;
  if (!hasPages && !hasVersions) {
    delete styles[parsed.domain];
  }

  await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: styles });
  return { ok: true, deleted, scope };
}

async function handleGetPopupState() {
  const state = await chrome.storage.local.get([
    'enabled',
    'autoMode',
    'twoPass',
    'generationMode',
    'autoThoroughMode',
    'selectedModel',
    'feedbackText',
    'feedbackImages',
  ]);
  const selectedModelRaw = state.selectedModel || 'gpt-5.2';
  const selectedModel = KNOWN_MODEL_IDS.has(selectedModelRaw) ? selectedModelRaw : 'gpt-5.2';
  const autoThoroughMode = Boolean(state.autoThoroughMode);
  const generationMode =
    state.generationMode === 'thorough' || (!state.generationMode && autoThoroughMode)
      ? 'thorough'
      : 'quick';

  if (selectedModel !== selectedModelRaw) {
    await chrome.storage.local.set({ selectedModel });
  }

  return {
    enabled: Boolean(state.enabled),
    autoMode: Boolean(state.autoMode),
    twoPass: typeof state.twoPass === 'boolean' ? state.twoPass : true,
    generationMode,
    autoThoroughMode,
    selectedModel,
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
  if (typeof message.twoPass === 'boolean') {
    update.twoPass = message.twoPass;
  }
  if (typeof message.generationMode === 'string') {
    update.generationMode = message.generationMode === 'thorough' ? 'thorough' : 'quick';
  }
  if (typeof message.selectedModel === 'string') {
    update.selectedModel = KNOWN_MODEL_IDS.has(message.selectedModel)
      ? message.selectedModel
      : 'gpt-5.2';
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

async function handleGenerateDarkModeAgent(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) {
    return { css: null, turns: 0, provider: null, model: null, error: 'No active tab available for generation' };
  }
  const metricsUrl = await resolveGenerationMetricsUrl(tabId, message);
  const mode = 'agent';
  const { agentMaxTurns } = await chrome.storage.local.get('agentMaxTurns');
  const fallbackTurns = Number.isInteger(agentMaxTurns) && agentMaxTurns > 0 ? agentMaxTurns : 5;
  const maxTurns =
    Number.isInteger(message?.maxTurns) && message.maxTurns > 0 ? message.maxTurns : fallbackTurns;
  const startedAt = Date.now();

  await generationStarted(metricsUrl, mode);

  const result = await runAgentLoop(tabId, {
    ...message,
    maxTurns,
    hooks: {
      onTurnStart({ turn }) {
        void chrome.runtime
          .sendMessage({
            type: 'agent-progress',
            turn,
            maxTurns,
            status: 'thinking',
          })
          .catch(() => {});
      },
    },
  });

  const durationMs = Math.max(0, Date.now() - startedAt);
  if (result?.error) {
    await generationFailed(metricsUrl, mode, {
      message: result.error,
      durationMs,
    });
    return result;
  }
  if (!result?.css || typeof result.css !== 'string' || !result.css.trim()) {
    const error = 'Agent completed without producing CSS';
    await generationFailed(metricsUrl, mode, {
      message: error,
      durationMs,
    });
    return {
      ...result,
      css: null,
      error,
    };
  }

  await generationCompleted(metricsUrl, mode, {
    provider: result?.provider || null,
    model: result?.model || null,
    cssLength: typeof result?.css === 'string' ? result.css.length : 0,
    turnsUsed: Number.isFinite(result?.turns) ? result.turns : 0,
    durationMs,
    usedNativeDarkCss: false,
    error: null,
  });
  return result;
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
  const { styles, migrated } = ensureMigratedStyles(data[STYLE_STORAGE_KEY]);
  if (migrated) {
    await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: styles });
  }
  return styles;
}

async function getStoredStyleForUrl(rawUrl) {
  const parsed = parseURL(rawUrl);
  if (!parsed) return { css: null, scope: null, found: false };

  const styles = await loadStyleStorage();
  return getStoredStyleForParsedUrl(parsed, styles);
}

async function syncTabRememberedStyle(tabId, url) {
  if (typeof tabId !== 'number') return;

  const { enabled, autoMode, selectedModel, twoPass, autoThoroughMode } = await chrome.storage.local.get([
    'enabled',
    'autoMode',
    'selectedModel',
    'twoPass',
    'autoThoroughMode',
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
    await maybeAutoGenerateForTab(tabId, url, selectedModel, twoPass, Boolean(autoThoroughMode));
    return;
  }

  await removeCssFromTab(tabId);
}

async function maybeAutoGenerateForTab(tabId, url, selectedModel, twoPassSetting, autoThoroughMode) {
  const dedupeKey = `${tabId}:${url}`;
  if (inFlightAutoGeneration.has(dedupeKey)) return;

  inFlightAutoGeneration.add(dedupeKey);
  try {
    const result = autoThoroughMode
      ? await handleGenerateDarkModeAgent({
          tabId,
          model: typeof selectedModel === 'string' ? selectedModel : undefined,
        })
      : await generateAndApplyDarkMode(tabId, {
          model: typeof selectedModel === 'string' ? selectedModel : undefined,
          twoPass: typeof twoPassSetting === 'boolean' ? twoPassSetting : true,
        });
    if (!result?.css || result.error) return;

    const saved = await handleSaveStoredStyle({ url, css: result.css, scope: 'domain', provider: result.provider, model: result.model });
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
    await sendMessageToTabWithInjection(tabId, message);
  } catch {
    // Ignore tabs without our content script (e.g. chrome:// pages).
  }
}

async function sendMessageToTabWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!shouldRetryWithContentScriptInjection(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function shouldRetryWithContentScriptInjection(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection')
  );
}

async function getContentScriptUnavailableError(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const rawUrl = typeof tab?.url === 'string' ? tab.url : '';
    if (!rawUrl) {
      return 'Unable to extract page context from content script';
    }

    let protocol = '';
    try {
      protocol = new URL(rawUrl).protocol;
    } catch {
      protocol = '';
    }

    if (protocol && protocol !== 'http:' && protocol !== 'https:') {
      return `This page does not allow extension scripting (${protocol.replace(':', '')} pages are restricted)`;
    }

    return 'Unable to extract page context from content script. Reload the page and try again.';
  } catch {
    return 'Unable to extract page context from content script';
  }
}

function shouldAutoGenerateForDomain(domain, styles) {
  if (typeof domain !== 'string' || !domain) return false;
  if (!isObject(styles)) return true;
  if (!Object.hasOwn(styles, domain)) return true;
  const entry = styles[domain];
  return !entry?.activeVersionId && (!Array.isArray(entry?.versions) || entry.versions.length === 0);
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
  const entry = styles[parsed.domain];
  if (!entry) return { css: null, scope: null, found: false };

  const pageEntry = entry.pages?.[parsed.page];
  if (pageEntry?.activeVersionId) {
    const active = pageEntry.versions?.find((v) => v.id === pageEntry.activeVersionId);
    if (active) return { css: active.css, scope: 'page', found: true };
  }

  if (entry.activeVersionId) {
    const active = entry.versions?.find((v) => v.id === entry.activeVersionId);
    if (active) return { css: active.css, scope: 'domain', found: true };
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

function getGenerationMode(twoPass, options = {}) {
  if (options.mode === 'agent') return 'agent';
  return twoPass ? 'two-pass' : 'single-pass';
}

async function resolveGenerationMetricsUrl(tabId, options = {}) {
  if (typeof options.url === 'string' && options.url.trim()) {
    return options.url.trim();
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab?.url === 'string' && tab.url.trim()) {
      return tab.url.trim();
    }
  } catch {
    // Ignore tabs that cannot be queried for URL context.
  }
  return 'unknown';
}

async function generateAndApplyDarkMode(tabId, options = {}) {
  const twoPass = typeof options.twoPass === 'boolean' ? options.twoPass : true;
  const mode = getGenerationMode(twoPass, options);
  const metricsUrl = await resolveGenerationMetricsUrl(tabId, options);
  let startedAt = 0;

  async function startGenerationMetrics() {
    if (startedAt > 0) return;
    startedAt = Date.now();
    await generationStarted(metricsUrl, mode);
  }

  async function failGenerationMetrics(errorMessage) {
    if (startedAt <= 0) return;
    await generationFailed(metricsUrl, mode, {
      message: errorMessage,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }

  async function completeGenerationMetrics(result, turnsUsed) {
    if (startedAt <= 0) return;
    const cssLength = typeof result?.css === 'string' ? result.css.length : 0;
    await generationCompleted(metricsUrl, mode, {
      provider: result?.provider || null,
      model: result?.model || null,
      cssLength,
      turnsUsed,
      durationMs: Math.max(0, Date.now() - startedAt),
      usedNativeDarkCss: Boolean(result?.usedNativeDarkModeCss),
      error: result?.error || null,
    });
  }

  async function returnFailure(errorMessage) {
    await failGenerationMetrics(errorMessage);
    return { css: null, error: errorMessage };
  }

  async function returnSuccess(result, turnsUsed) {
    await completeGenerationMetrics(result, turnsUsed);
    return result;
  }

  log.info('generate', 'Starting dark mode generation', {
    tabId,
    options: { provider: options.provider, model: options.model, twoPass },
  });

  // Detect if the page already has dark mode
  try {
    const detection = await sendMessageToTabWithInjection(tabId, { type: 'detect-dark-mode' });
    if (detection?.isDark) {
      log.info('generate', 'Page already has dark mode, skipping generation', { signals: detection.signals });
      return { css: null, skipped: true, reason: 'Page already has a dark mode', signals: detection.signals };
    }
    log.info('generate', 'Dark mode detection', { isDark: false, signals: detection?.signals });
  } catch (_error) {
    log.warn('generate', 'Dark mode detection failed, proceeding with generation');
  }

  await startGenerationMetrics();

  let pageContext;
  try {
    pageContext = await extractPageContext(tabId);
    log.info('generate', 'Extracted page context', {
      nodeCount: pageContext?.nodeCount,
      truncated: pageContext?.truncated,
      colorMapEntries: Array.isArray(pageContext?.colorMap) ? pageContext.colorMap.length : 0,
      url: pageContext?.url,
    });
  } catch (_error) {
    log.error('generate', 'Failed to extract page context', { tabId });
    return returnFailure(await getContentScriptUnavailableError(tabId));
  }

  let extractedNativeDarkCss = '';
  try {
    const extracted = await sendMessageToTabWithInjection(tabId, { type: 'extract-dark-mode-rules' });
    extractedNativeDarkCss = typeof extracted?.css === 'string' ? extracted.css.trim() : '';
  } catch {
    extractedNativeDarkCss = '';
  }

  const extractedNativeDarkCssBytes = getUtf8ByteLength(extractedNativeDarkCss);
  if (extractedNativeDarkCssBytes > NATIVE_DARK_MODE_DIRECT_APPLY_MIN_BYTES) {
    try {
      await sendMessageToTabWithInjection(tabId, { type: 'apply-css', css: extractedNativeDarkCss });
      log.info('generate', 'Applied native prefers-color-scheme dark CSS directly', {
        tabId,
        cssBytes: extractedNativeDarkCssBytes,
      });
      log.info('generate', 'Final CSS selected', { finalPass: 0, source: 'native-dark-mode-css' });
      return returnSuccess({
        css: extractedNativeDarkCss,
        applied: true,
        provider: null,
        model: null,
        finalPass: 0,
        usedNativeDarkModeCss: true,
        nativeDarkCssBytes: extractedNativeDarkCssBytes,
        truncatedContext: Boolean(pageContext?.truncated),
        nodeCount: pageContext?.nodeCount || 0,
      }, 0);
    } catch {
      log.warn('generate', 'Failed to apply extracted native dark CSS; falling back to LLM flow');
    }
  }

  let customPropertyContext = null;
  try {
    customPropertyContext = await sendMessageToTabWithInjection(tabId, {
      type: 'extract-custom-properties',
    });
  } catch (_error) {
    customPropertyContext = null;
  }

  const hasCustomProperties = Boolean(
    isObject(customPropertyContext?.properties)
    && Object.keys(customPropertyContext.properties).length > 0
  );
  if (hasCustomProperties) {
    pageContext = {
      ...pageContext,
      customProperties: customPropertyContext,
    };
    log.info('generate', 'Extracted custom properties for prompt context', {
      propertyCount: Object.keys(customPropertyContext.properties).length,
    });
  }

  const activePrompts = await getActivePrompts();
  log.info('generate', 'Using prompts', { custom: Boolean(activePrompts.system || activePrompts.user) });
  const screenshotDataUrl = sanitizeGenerationScreenshotDataUrl(options.screenshotDataUrl);
  const contextJson = buildContextJsonForPrompt(pageContext, {
    withScreenshot: Boolean(screenshotDataUrl),
  });
  const shouldPassPartialNativeDarkCssToLlm =
    extractedNativeDarkCssBytes > 0 &&
    extractedNativeDarkCssBytes < NATIVE_DARK_MODE_DIRECT_APPLY_MIN_BYTES;
  let userContent;
  if (activePrompts.user) {
    userContent = activePrompts.user.includes('{{context}}')
      ? activePrompts.user.replace('{{context}}', contextJson)
      : `${activePrompts.user}\n\nPage context JSON:\n${contextJson}`;
  } else {
    userContent = buildDarkModeUserPrompt(pageContext, {
      extractedNativeDarkCss: shouldPassPartialNativeDarkCssToLlm ? extractedNativeDarkCss : '',
      extractedNativeDarkCssBytes,
    });
  }
  if (shouldPassPartialNativeDarkCssToLlm && activePrompts.user) {
    userContent = [
      userContent,
      'Additional context: the site already provides partial prefers-color-scheme: dark rules.',
      `Extracted native dark CSS (${extractedNativeDarkCssBytes} bytes):`,
      extractedNativeDarkCss,
    ].join('\n\n');
  }

  const userMessageContent = screenshotDataUrl
    ? [
        { type: 'text', text: `${userContent}\nAttached screenshot: current viewport render.` },
        { type: 'image_url', image_url: { url: screenshotDataUrl } },
      ]
    : userContent;

  const request = {
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    model: typeof options.model === 'string' ? options.model : undefined,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 3200,
    systemPrompt: buildGenerationSystemPrompt(activePrompts.system, hasCustomProperties),
    messages: [
      {
        role: 'user',
        content: userMessageContent,
      },
    ],
  };

  log.info('generate', 'Sending LLM request', {
    provider: request.provider,
    model: request.model,
    messageLength: typeof userContent === 'string' ? userContent.length : 0,
    screenshotAttached: Boolean(screenshotDataUrl),
  });

  let llmResult;
  try {
    llmResult = await completeLlmRequest(request);
    log.info('generate', 'LLM response received', { provider: llmResult.provider, model: llmResult.model, textLength: llmResult.text?.length || 0 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to generate CSS';
    log.error('generate', 'LLM request failed', { error: msg });
    return returnFailure(msg);
  }

  const css = extractCssFromModelText(llmResult.text || '');
  if (!css) {
    log.warn('generate', 'Response did not contain valid CSS', { rawTextPreview: (llmResult.text || '').slice(0, 200) });
    return returnFailure('Provider response did not contain valid CSS');
  }

  log.info('generate', 'CSS extracted', { cssLength: css.length });

  try {
    await sendMessageToTabWithInjection(tabId, { type: 'apply-css', css });
    log.info('generate', 'CSS applied to tab', { tabId });
  } catch (_error) {
    log.error('generate', 'Failed to apply CSS to tab', { tabId });
    return returnFailure('Generated CSS, but failed to apply it to the page');
  }

  const passOneResult = {
    css,
    applied: true,
    provider: llmResult.provider,
    model: llmResult.model,
    finalPass: 1,
    usedNativeDarkModeCss: false,
    nativeDarkCssBytes: extractedNativeDarkCssBytes,
    truncatedContext: Boolean(pageContext?.truncated),
    nodeCount: pageContext?.nodeCount || 0,
  };

  if (!twoPass) {
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', twoPassEnabled: false });
    return returnSuccess(passOneResult, 1);
  }

  const autoFeedback = [
    'This dark mode CSS was auto-generated.',
    'Review the screenshot for issues: poor contrast, missed elements, broken layouts, illegible text, elements that are still light-colored.',
    'Generate improved CSS that fixes any problems you see.',
  ].join(' ');

  let passTwoScreenshotDataUrl;
  try {
    await sendMessageToTabWithInjection(tabId, { type: 'wait-for-paint' });
    passTwoScreenshotDataUrl = await captureGenerationRefinementScreenshot(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown capture error');
    log.warn('generate', 'Two-pass refinement skipped: unable to capture screenshot', { tabId, error: message });
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', reason: 'screenshot-capture-failed' });
    return returnSuccess(passOneResult, 1);
  }

  const sanitizedScreenshot = sanitizeGenerationScreenshotDataUrl(passTwoScreenshotDataUrl);
  if (!sanitizedScreenshot) {
    log.warn('generate', 'Two-pass refinement skipped: screenshot data invalid');
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', reason: 'screenshot-invalid' });
    return returnSuccess(passOneResult, 1);
  }

  const refineRequest = {
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    model: typeof options.model === 'string' ? options.model : undefined,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 3200,
    systemPrompt: buildRefineSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildRefineUserPrompt({
          pageContext,
          currentCss: css,
          feedback: autoFeedback,
          feedbackImages: [{ dataUrl: sanitizedScreenshot }],
        }),
      },
    ],
  };

  let refineResult;
  try {
    refineResult = await completeLlmRequest(refineRequest);
    log.info('generate', 'Two-pass refine response received', {
      provider: refineResult.provider,
      model: refineResult.model,
      textLength: refineResult.text?.length || 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    log.warn('generate', 'Two-pass refinement failed; keeping pass 1 CSS', { error: message });
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', reason: 'refine-llm-failed' });
    return returnSuccess(passOneResult, 1);
  }

  const refinedCss = extractCssFromModelText(refineResult.text || '');
  if (!refinedCss) {
    log.warn('generate', 'Two-pass refinement returned invalid CSS; keeping pass 1 CSS');
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', reason: 'refine-css-invalid' });
    return returnSuccess(passOneResult, 1);
  }

  try {
    await sendMessageToTabWithInjection(tabId, { type: 'apply-css', css: refinedCss });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    log.warn('generate', 'Two-pass refined CSS could not be applied; keeping pass 1 CSS', { error: message });
    log.info('generate', 'Final CSS selected', { finalPass: 1, source: 'generation-pass-1', reason: 'refined-css-apply-failed' });
    return returnSuccess(passOneResult, 1);
  }

  log.info('generate', 'Final CSS selected', { finalPass: 2, source: 'generation-pass-2' });

  return returnSuccess({
    css: refinedCss,
    applied: true,
    provider: refineResult.provider,
    model: refineResult.model,
    finalPass: 2,
    usedNativeDarkModeCss: false,
    nativeDarkCssBytes: extractedNativeDarkCssBytes,
    truncatedContext: Boolean(pageContext?.truncated),
    nodeCount: pageContext?.nodeCount || 0,
  }, 2);
}

async function captureGenerationRefinementScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab?.windowId)) {
    throw new Error('Unable to resolve tab window for screenshot capture');
  }
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
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
    pageContext = await extractPageContext(tabId);
  } catch (_error) {
    log.error('refine', 'Failed to extract page context');
    return { css: null, error: await getContentScriptUnavailableError(tabId) };
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
    maxTokens: typeof message.maxTokens === 'number' ? message.maxTokens : 3200,
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
    await sendMessageToTabWithInjection(tabId, { type: 'apply-css', css });
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
    'You are a CSS dark mode specialist.',
    'Generate a complete dark mode CSS stylesheet for the provided webpage.',
    'Return ONLY valid CSS. No markdown fences, no explanations, no comments.',
    '',
    'Color palette targets:',
    '- Page background: #1a1a2e or similar deep blue-gray (not pure black)',
    '- Surface/card backgrounds: #16213e or #1e1e2e (slightly lighter than page)',
    '- Primary text: #e0e0e0 (not pure white, reduces glare)',
    '- Secondary/muted text: #a0a0a0',
    '- Links: #6db3f2 (accessible blue)',
    '- Borders: #2a2a3e or rgba(255,255,255,0.1)',
    '- Accent colors: desaturate by ~30% and increase lightness for dark backgrounds',
    '',
    'Contrast requirements (WCAG AA):',
    '- Normal text on backgrounds: minimum 4.5:1 ratio',
    '- Large text (18px+ or 14px+ bold): minimum 3:1 ratio',
    '- Interactive elements: must be distinguishable from surrounding content',
    '',
    'Selector strategy:',
    '- Use !important on color properties (background, color, border-color, box-shadow, outline-color)',
    '- Do NOT use !important on layout properties (display, position, margin, padding, width, height)',
    '- Target broad selectors first (body, main, header, nav, aside, footer, section, article, td, th)',
    '- Then target specific component patterns from the color map',
    '- Include states: :hover, :focus, :active, :visited, ::placeholder',
    '',
    'Rules:',
    '- Set color-scheme: dark on :root',
    '- Preserve images, videos, iframes — do not invert or filter them',
    '- Handle form elements: input, textarea, select, button',
    '- Preserve visual hierarchy between page bg, card bg, and elevated surfaces',
    '- Do NOT hide content, change layout, alter spacing, or modify font sizes',
  ].join('\n');
}

function buildGenerationSystemPrompt(activeSystemPrompt, hasCustomProperties) {
  const basePrompt = activeSystemPrompt || buildDarkModeSystemPrompt();
  if (!hasCustomProperties) return basePrompt;

  const strategy = [
    '',
    'CUSTOM PROPERTY STRATEGY (this site uses CSS variables for theming):',
    '1. Override ALL color-related custom properties on :root FIRST',
    '2. For --*background*/*bg*/*surface* variables: use dark values (#1a1a2e, #1e1e2e, #252540)',
    '3. For --*text*/*foreground*/*fg* variables: use light values (#e0e0e0, #a0a0a0)',
    '4. For --*border*/*divider* variables: use subtle values (#2a2a3e, rgba(255,255,255,0.1))',
    '5. For --*accent*/*primary*/*brand* variables: desaturate and lighten the current value',
    '6. Add element-specific overrides ONLY for elements not covered by variable changes',
    '7. The :root override block should come FIRST in your CSS output',
    '8. Use !important on :root variable overrides to ensure precedence over media queries',
  ].join('\n');

  return `${basePrompt}\n${strategy}`;
}

function buildRefineSystemPrompt() {
  return [
    'You are a CSS dark mode specialist refining an existing dark stylesheet.',
    'Return ONLY valid CSS. No markdown fences, no explanations.',
    'Output a COMPLETE replacement stylesheet (not a diff or patch).',
    '',
    'Refinement priorities:',
    '- Fix any elements that are still light-colored (white/light backgrounds)',
    '- Fix any text that has poor contrast against its background (below 4.5:1)',
    '- Fix any accent colors that are too bright or saturated for dark backgrounds',
    '- Ensure form elements (inputs, textareas, selects, buttons) are dark-themed',
    '- Ensure all interactive states (:hover, :focus, :active) are visible',
    '- Preserve all existing fixes that work well',
    '- Do NOT change layout, spacing, or font properties',
  ].join('\n');
}

function buildDarkModeUserPrompt(
  pageContext,
  { extractedNativeDarkCss = '', extractedNativeDarkCssBytes = 0 } = {}
) {
  const safeContext = sanitizePageContext(pageContext);
  const sections = [];

  sections.push(`Page: ${safeContext.url || 'unknown'}`);
  sections.push(`Title: ${safeContext.title || 'unknown'}`);

  if (safeContext.layoutSummary) {
    const ls = safeContext.layoutSummary;
    sections.push(`Layout type: ${ls.layoutType} (${ls.totalElements} elements, nesting depth ${ls.nestingDepth})`);
    if (ls.regions.length) sections.push(`Regions: ${ls.regions.join(', ')}`);
    if (ls.hasNestedComments) sections.push('Has nested comment threads — ensure ALL nesting levels get dark backgrounds');
    if (ls.contentSelectors?.length) sections.push(`Key repeating selectors: ${ls.contentSelectors.join(', ')}`);
  }

  if (safeContext.customProperties) {
    const cp = safeContext.customProperties;
    sections.push('', '=== CSS CUSTOM PROPERTIES (override these on :root FIRST) ===');
    if (cp.grouped.backgrounds.length) {
      sections.push(`Background vars (→ dark values): ${cp.grouped.backgrounds.slice(0, 15).join(', ')}`);
    }
    if (cp.grouped.text.length) {
      sections.push(`Text vars (→ light values): ${cp.grouped.text.slice(0, 15).join(', ')}`);
    }
    if (cp.grouped.borders.length) {
      sections.push(`Border vars (→ subtle dark): ${cp.grouped.borders.slice(0, 10).join(', ')}`);
    }
    if (cp.grouped.accents.length) {
      sections.push(`Accent vars (→ desaturate+lighten): ${cp.grouped.accents.slice(0, 10).join(', ')}`);
    }
    const propEntries = Object.entries(cp.properties).slice(0, 50);
    if (propEntries.length) {
      sections.push('Current values:');
      for (const [name, value] of propEntries) {
        sections.push(`  ${name}: ${value}`);
      }
    }
  }

  if (Array.isArray(safeContext.colorMap) && safeContext.colorMap.length > 0) {
    sections.push('', '=== COLOR MAP (current colors by selector, grouped by role) ===');
    const byRole = {};
    for (const entry of safeContext.colorMap) {
      const role = entry.role || 'content';
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(entry);
    }
    for (const [role, entries] of Object.entries(byRole)) {
      sections.push(`[${role}]`);
      for (const entry of entries.slice(0, 30)) {
        const parts = [entry.selector];
        if (entry.bg) parts.push(`bg:${entry.bg}`);
        if (entry.color) parts.push(`text:${entry.color}`);
        if (entry.contrast) parts.push(`contrast:${entry.contrast}`);
        if (entry.isLight) parts.push('NEEDS_DARKENING');
        sections.push(`  ${parts.join(' | ')}`);
      }
    }
  }

  const contextJson = buildContextJsonForPrompt(safeContext, { withScreenshot: false });
  sections.push('', '=== PAGE STRUCTURE (compact DOM) ===', contextJson);

  const hasPartialNativeDarkCss =
    typeof extractedNativeDarkCss === 'string' &&
    extractedNativeDarkCssBytes > 0 &&
    extractedNativeDarkCssBytes < NATIVE_DARK_MODE_DIRECT_APPLY_MIN_BYTES;
  if (hasPartialNativeDarkCss) {
    sections.push('', '=== EXISTING PARTIAL DARK CSS (extend, do not replace) ===', extractedNativeDarkCss);
  }

  return sections.join('\n');
}

function buildRefineUserPrompt({ pageContext, currentCss, feedback, feedbackImages }) {
  const safeContext = sanitizePageContext(pageContext);
  const contextJson = buildContextJsonForPrompt(safeContext, { withScreenshot: false });
  const safeFeedback = feedback || '(no text feedback provided; use screenshots to infer issues)';
  const truncatedHint = safeContext.truncated
    ? 'Page context is truncated. Use resilient selectors and ensure full-surface coverage for sidebar/editor/preview/thread areas.'
    : 'Use the page context details to target specific problem components.';
  const colorMapHint = Array.isArray(safeContext.colorMap) && safeContext.colorMap.length > 0
    ? `Use the provided colorMap as the primary source of current page color usage (${safeContext.colorMap.length} grouped profiles).`
    : 'Color map is unavailable; use compact DOM cues and screenshot evidence.';
  const textPrompt = [
    'Refine the existing dark mode CSS based on user feedback.',
    'Requirements:',
    '- Keep improvements already present unless feedback requests changes.',
    '- Preserve structure, spacing, and layout behavior.',
    '- Maintain accessible contrast and visible interactive states.',
    '- Ensure sidebars, comments, editor textareas, preview containers, and quotes are all covered.',
    '- Return a full replacement CSS stylesheet.',
    'Context guidance:',
    `- ${colorMapHint}`,
    `- ${truncatedHint}`,
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
    const applied = await sendMessageToTabWithInjection(tabId, { type: 'get-applied-css' });
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

function sanitizeGenerationScreenshotDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  if (!dataUrl.startsWith('data:image/')) return null;
  if (dataUrl.length > MAX_GENERATION_SCREENSHOT_DATA_URL_LENGTH) return null;
  return dataUrl;
}

function buildContextJsonForPrompt(pageContext, { withScreenshot = false } = {}) {
  const safeContext = sanitizePageContext(pageContext);
  const hasColorMap = Array.isArray(safeContext.colorMap) && safeContext.colorMap.length > 0;
  const includeStyles = !withScreenshot && !hasColorMap;
  const maxNodes = hasColorMap
    ? (withScreenshot
        ? MAX_CONTEXT_DOM_NODES_WITH_COLOR_MAP_AND_SCREENSHOT
        : MAX_CONTEXT_DOM_NODES_WITH_COLOR_MAP)
    : (withScreenshot ? MAX_CONTEXT_DOM_NODES_WITH_SCREENSHOT : MAX_CONTEXT_DOM_NODES);
  const maxDepth = hasColorMap
    ? (withScreenshot
        ? MAX_CONTEXT_DOM_DEPTH_WITH_COLOR_MAP_AND_SCREENSHOT
        : MAX_CONTEXT_DOM_DEPTH_WITH_COLOR_MAP)
    : (withScreenshot ? MAX_CONTEXT_DOM_DEPTH_WITH_SCREENSHOT : MAX_CONTEXT_DOM_DEPTH);
  const maxChildren = hasColorMap
    ? (withScreenshot
        ? MAX_CONTEXT_DOM_CHILDREN_WITH_COLOR_MAP_AND_SCREENSHOT
        : MAX_CONTEXT_DOM_CHILDREN_WITH_COLOR_MAP)
    : (withScreenshot ? MAX_CONTEXT_DOM_CHILDREN_WITH_SCREENSHOT : MAX_CONTEXT_DOM_CHILDREN);

  const compactDom = compactDomNode(safeContext.dom, {
    includeStyles,
    maxNodes,
    maxDepth,
    maxChildren,
  });

  const contextForJson = {
    url: safeContext.url,
    hostname: safeContext.hostname,
    title: safeContext.title,
    viewport: safeContext.viewport,
    nodeCount: safeContext.nodeCount,
    truncated: safeContext.truncated,
    dom: compactDom,
  };

  return JSON.stringify(contextForJson);
}

async function extractPageContext(tabId) {
  const [domResult, colorMapResult, layoutResult] = await Promise.allSettled([
    sendMessageToTabWithInjection(tabId, { type: 'extract-dom' }),
    sendMessageToTabWithInjection(tabId, { type: 'extract-color-map' }),
    sendMessageToTabWithInjection(tabId, { type: 'extract-layout-summary' }),
  ]);

  if (domResult.status !== 'fulfilled' && colorMapResult.status !== 'fulfilled') {
    throw new Error('Unable to extract page context');
  }

  const context = isObject(domResult.value) ? { ...domResult.value } : {};
  if (colorMapResult.status === 'fulfilled' && isObject(colorMapResult.value)) {
    context.colorMap = colorMapResult.value.colorMap;
    context.uniqueColors = colorMapResult.value.uniqueColors;
  }
  if (layoutResult.status === 'fulfilled' && isObject(layoutResult.value)) {
    context.layoutSummary = layoutResult.value;
  }

  return context;
}

function selectChildren(children, maxChildren) {
  if (children.length <= maxChildren) return children;
  const half = Math.floor(maxChildren / 2);
  const front = children.slice(0, half);
  const rest = children.slice(half);
  const stride = Math.max(1, Math.floor(rest.length / (maxChildren - half)));
  const sampled = [];
  for (let i = 0; i < rest.length && sampled.length < maxChildren - half; i += stride) {
    sampled.push(rest[i]);
  }
  if (sampled.length < maxChildren - half && rest.length > 0) {
    sampled.push(rest[rest.length - 1]);
  }
  return [...front, ...sampled];
}

function compactDomNode(root, config) {
  if (!root || typeof root !== 'object') return null;

  const state = { count: 0 };
  const allowedStyleKeys = config.includeStyles
    ? new Set([
        'display',
        'position',
        'color',
        'backgroundColor',
        'fontSize',
        'fontWeight',
        'borderTopColor',
        'borderTopWidth',
        'outlineColor',
      ])
    : null;

  function visit(node, depth) {
    if (!node || typeof node !== 'object') return null;
    if (state.count >= config.maxNodes) return null;
    if (depth > config.maxDepth) return null;
    state.count += 1;

    const compact = {
      tag: typeof node.tag === 'string' ? node.tag : '',
      id: typeof node.id === 'string' ? node.id : null,
      classList: Array.isArray(node.classList) ? node.classList.slice(0, 6) : [],
      text: typeof node.text === 'string' ? node.text.slice(0, 120) : null,
      formControl: Boolean(node.formControl),
      attributes: compactAttributes(node.attributes),
      rect: compactRect(node.rect),
      children: [],
    };

    if (allowedStyleKeys && node.styles && typeof node.styles === 'object') {
      const styles = {};
      for (const key of allowedStyleKeys) {
        if (typeof node.styles[key] === 'string' && node.styles[key]) {
          styles[key] = node.styles[key];
        }
      }
      compact.styles = styles;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const selected = selectChildren(children, config.maxChildren);
    for (const child of selected) {
      const compactChild = visit(child, depth + 1);
      if (compactChild) compact.children.push(compactChild);
      if (state.count >= config.maxNodes) break;
    }

    return compact;
  }

  return visit(root, 0);
}

function compactAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return {};
  const keys = ['role', 'ariaLabel', 'type', 'placeholder', 'href', 'src', 'alt', 'title'];
  const compact = {};
  for (const key of keys) {
    if (typeof attributes[key] === 'string' && attributes[key]) {
      compact[key] = attributes[key].slice(0, 120);
    }
  }
  return compact;
}

function compactRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const out = {};
  if (Number.isFinite(rect.x)) out.x = rect.x;
  if (Number.isFinite(rect.y)) out.y = rect.y;
  if (Number.isFinite(rect.width)) out.width = rect.width;
  if (Number.isFinite(rect.height)) out.height = rect.height;
  return out;
}

function sanitizePageContext(pageContext) {
  if (!isObject(pageContext)) {
    return {
      url: '',
      title: '',
      nodeCount: 0,
      truncated: true,
      dom: null,
      colorMap: [],
      uniqueColors: {
        backgrounds: [],
        text: [],
        borders: [],
      },
    };
  }

  return {
    url: typeof pageContext.url === 'string' ? pageContext.url : '',
    hostname: typeof pageContext.hostname === 'string' ? pageContext.hostname : '',
    title: typeof pageContext.title === 'string' ? pageContext.title : '',
    rootTag: typeof pageContext.rootTag === 'string' ? pageContext.rootTag : '',
    viewport: isObject(pageContext.viewport)
      ? {
          width: Number.isFinite(pageContext.viewport.width) ? pageContext.viewport.width : null,
          height: Number.isFinite(pageContext.viewport.height) ? pageContext.viewport.height : null,
        }
      : null,
    nodeCount: Number.isFinite(pageContext.nodeCount) ? pageContext.nodeCount : 0,
    truncated: Boolean(pageContext.truncated),
    dom: pageContext.dom || null,
    customProperties: sanitizeCustomPropertiesContext(pageContext.customProperties),
    colorMap: sanitizeColorMap(pageContext.colorMap),
    uniqueColors: sanitizeUniqueColors(pageContext.uniqueColors),
    layoutSummary: sanitizeLayoutSummary(pageContext.layoutSummary),
  };
}

function sanitizeCustomPropertiesContext(customProperties) {
  if (!isObject(customProperties) || !isObject(customProperties.properties)) {
    return null;
  }

  const sanitizedProperties = {};
  for (const [name, value] of Object.entries(customProperties.properties)) {
    if (typeof name !== 'string' || !name.startsWith('--')) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    sanitizedProperties[name] = trimmed.slice(0, 120);
  }

  const sanitizedGrouped = {};
  const groupKeys = ['backgrounds', 'text', 'accents', 'borders'];
  for (const key of groupKeys) {
    if (!Array.isArray(customProperties.grouped?.[key])) {
      sanitizedGrouped[key] = [];
      continue;
    }
    sanitizedGrouped[key] = customProperties.grouped[key]
      .filter((name) => typeof name === 'string' && name.startsWith('--'))
      .slice(0, 80);
  }

  if (Object.keys(sanitizedProperties).length === 0) {
    return null;
  }

  return {
    properties: sanitizedProperties,
    grouped: sanitizedGrouped,
  };
}

function sanitizeLayoutSummary(summary) {
  if (!isObject(summary)) return null;
  const validTypes = ['forum', 'article', 'dashboard', 'generic'];
  return {
    layoutType: validTypes.includes(summary.layoutType) ? summary.layoutType : 'generic',
    regions: Array.isArray(summary.regions) ? summary.regions.filter((r) => typeof r === 'string').slice(0, 10) : [],
    nestingDepth: Number.isFinite(summary.nestingDepth) ? Math.min(summary.nestingDepth, 20) : 0,
    hasNestedComments: Boolean(summary.hasNestedComments),
    hasSidebar: Boolean(summary.hasSidebar),
    hasCodeBlocks: Boolean(summary.hasCodeBlocks),
    hasForms: Boolean(summary.hasForms),
    contentSelectors: Array.isArray(summary.contentSelectors) ? summary.contentSelectors.filter((s) => typeof s === 'string').slice(0, 5) : [],
    totalElements: Number.isFinite(summary.totalElements) ? summary.totalElements : 0,
  };
}

function sanitizeColorMap(colorMap) {
  if (!Array.isArray(colorMap)) return [];

  return colorMap
    .slice(0, MAX_CONTEXT_COLOR_MAP_ENTRIES)
    .map((entry) => sanitizeColorMapEntry(entry))
    .filter(Boolean);
}

function sanitizeColorMapEntry(entry) {
  if (!isObject(entry)) return null;
  if (typeof entry.selector !== 'string' || !entry.selector.trim()) return null;

  const out = {
    selector: entry.selector.slice(0, MAX_CONTEXT_COLOR_MAP_SELECTOR_LENGTH),
  };

  if (typeof entry.role === 'string' && entry.role) out.role = entry.role;
  if (typeof entry.contrast === 'number' && Number.isFinite(entry.contrast)) out.contrast = entry.contrast;
  if (typeof entry.isLight === 'boolean') out.isLight = entry.isLight;

  const stringKeys = ['bg', 'color', 'fill', 'stroke'];
  for (const key of stringKeys) {
    if (typeof entry[key] === 'string' && entry[key]) {
      out[key] = entry[key].slice(0, 40);
    }
  }

  if (typeof entry.border === 'string' && entry.border) {
    out.border = entry.border.slice(0, 40);
  } else if (isObject(entry.border)) {
    const border = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (typeof entry.border[side] === 'string' && entry.border[side]) {
        border[side] = entry.border[side].slice(0, 40);
      }
    }
    if (Object.keys(border).length) out.border = border;
  }

  return out;
}

function sanitizeUniqueColors(uniqueColors) {
  if (!isObject(uniqueColors)) {
    return {
      backgrounds: [],
      text: [],
      borders: [],
    };
  }

  return {
    backgrounds: sanitizeUniqueColorList(uniqueColors.backgrounds),
    text: sanitizeUniqueColorList(uniqueColors.text),
    borders: sanitizeUniqueColorList(uniqueColors.borders),
  };
}

function sanitizeUniqueColorList(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (isObject(value) && typeof value.color === 'string' && value.color) {
      const color = value.color.slice(0, 40);
      if (seen.has(color)) continue;
      seen.add(color);
      result.push({
        color,
        luminance: typeof value.luminance === 'number' ? value.luminance : null,
        isLight: typeof value.isLight === 'boolean' ? value.isLight : null,
        count: typeof value.count === 'number' ? value.count : 0,
      });
    } else if (typeof value === 'string' && value) {
      const color = value.slice(0, 40);
      if (seen.has(color)) continue;
      seen.add(color);
      result.push({ color });
    }
    if (result.length >= MAX_CONTEXT_COLOR_LIST) break;
  }
  return result;
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

function getUtf8ByteLength(text) {
  if (typeof text !== 'string' || !text) return 0;
  return new TextEncoder().encode(text).length;
}
