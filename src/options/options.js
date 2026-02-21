import {
  PROVIDER_CONFIG,
  PROVIDER_MODELS,
  MANAGED_PROVIDERS,
  DEFAULT_PROMPTS,
  getDefaultLlmSettings,
  isHttpsUrl,
  mergeLlmSettings,
} from '../shared/llm-settings.js';
import { getLogs, clearLogs, setLogging, getLoggingEnabled } from '../shared/logger.js';

const ALL_PROVIDERS = [...MANAGED_PROVIDERS, 'custom'];

const $ = (sel) => document.querySelector(sel);
const providerContainer = $('#provider-cards');
const promptContainer = $('#prompt-cards');
const addProviderBtn = $('#add-provider');
const addPromptBtn = $('#add-prompt');
const saveBtn = $('#save-btn');
const resetBtn = $('#reset-btn');
const statusEl = $('#status');

let state = getDefaultLlmSettings();
let visibleProviders = [];

function flash(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
  if (type === 'success') {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 2500);
  }
}

function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAvailableProviders(include) {
  return ALL_PROVIDERS.filter((p) => p === include || !visibleProviders.includes(p));
}

function buildProviderCard(provider, apiKey = '') {
  const config = PROVIDER_CONFIG[provider];
  const isDefault = provider === state.provider;
  const isCustom = provider === 'custom';
  const models = PROVIDER_MODELS[provider] || [];
  const savedModel = state.models[provider] || config?.defaultModel || '';

  const card = document.createElement('div');
  card.className = `card${isDefault ? ' is-default' : ''}`;
  card.dataset.provider = provider;

  const providerOpts = getAvailableProviders(provider)
    .map(
      (p) =>
        `<option value="${p}" ${p === provider ? 'selected' : ''}>${PROVIDER_CONFIG[p]?.label || p}</option>`
    )
    .join('');

  const modelHtml = isCustom
    ? `<input type="text" class="model-input" placeholder="model-id" value="${escapeAttr(savedModel)}">`
    : `<select class="model-select">${models.map((m) => `<option value="${m.id}" ${m.id === savedModel ? 'selected' : ''}>${m.label}</option>`).join('')}</select>`;

  const customHtml = isCustom
    ? `<div class="field-row">
        <label class="field full">
          <span class="field-label">Endpoint URL</span>
          <input type="url" class="endpoint-input" placeholder="https://api.example.com/v1/chat/completions" value="${escapeAttr(state.customEndpoint.url)}">
        </label>
      </div>
      <div class="field-row">
        <label class="field full">
          <span class="field-label">Headers (JSON)</span>
          <textarea class="headers-input" rows="3" placeholder='{"x-api-key": "..."}'>${escapeAttr(JSON.stringify(state.customEndpoint.headers || {}, null, 2))}</textarea>
        </label>
      </div>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <div class="provider-select-wrap">
        <select class="provider-select">${providerOpts}</select>
      </div>
      <div class="card-actions">
        <button type="button" class="default-pill${isDefault ? ' active' : ''}">Default</button>
        <button type="button" class="remove-btn" title="Remove">&times;</button>
      </div>
    </div>
    <div class="card-body">
      <div class="field-row">
        <label class="field">
          <span class="field-label">API Key</span>
          <div class="input-with-action">
            <input type="password" class="api-key-input" autocomplete="off" placeholder="Paste your API key" value="${escapeAttr(apiKey)}">
            <button type="button" class="reveal-btn" tabindex="-1">Show</button>
          </div>
        </label>
        <label class="field">
          <span class="field-label">Model</span>
          ${modelHtml}
        </label>
      </div>
      ${customHtml}
    </div>
  `;

  card.querySelector('.provider-select').addEventListener('change', (e) => {
    switchCardProvider(card, provider, e.target.value);
  });

  card.querySelector('.default-pill').addEventListener('click', () => {
    setDefaultProvider(card.dataset.provider);
  });

  card.querySelector('.remove-btn').addEventListener('click', () => {
    removeProviderCard(card);
  });

  card.querySelector('.reveal-btn').addEventListener('click', (e) => {
    const input = card.querySelector('.api-key-input');
    const btn = e.currentTarget;
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  });

  return card;
}

function switchCardProvider(card, oldProvider, newProvider) {
  visibleProviders = visibleProviders.filter((p) => p !== oldProvider);
  const wasDefault = state.provider === oldProvider;
  const newApiKey = state.apiKeys[newProvider] || '';
  const newCard = buildProviderCard(newProvider, newApiKey);

  if (wasDefault) {
    state.provider = newProvider;
    newCard.classList.add('is-default');
    newCard.querySelector('.default-pill').classList.add('active');
  }

  card.replaceWith(newCard);
  visibleProviders.push(newProvider);
  refreshProviderSelects();
  updateProviderControls();
}

function setDefaultProvider(provider) {
  state.provider = provider;
  providerContainer.querySelectorAll('.card').forEach((card) => {
    const match = card.dataset.provider === provider;
    card.classList.toggle('is-default', match);
    card.querySelector('.default-pill').classList.toggle('active', match);
  });
}

function removeProviderCard(card) {
  const provider = card.dataset.provider;
  visibleProviders = visibleProviders.filter((p) => p !== provider);
  card.style.animation = 'cardOut 0.2s ease forwards';
  card.addEventListener('animationend', () => {
    card.remove();
    refreshProviderSelects();
    updateProviderControls();
    if (state.provider === provider && visibleProviders.length > 0) {
      setDefaultProvider(visibleProviders[0]);
    }
  });
}

function addProviderCard(provider, apiKey = '') {
  if (visibleProviders.includes(provider)) return;
  visibleProviders.push(provider);
  const card = buildProviderCard(provider, apiKey);
  providerContainer.appendChild(card);
  refreshProviderSelects();
  updateProviderControls();
}

function refreshProviderSelects() {
  providerContainer.querySelectorAll('.card').forEach((card) => {
    const current = card.dataset.provider;
    const select = card.querySelector('.provider-select');
    const opts = getAvailableProviders(current)
      .map(
        (p) =>
          `<option value="${p}" ${p === current ? 'selected' : ''}>${PROVIDER_CONFIG[p]?.label || p}</option>`
      )
      .join('');
    select.innerHTML = opts;
  });
}

function updateProviderControls() {
  const hasAvailable = ALL_PROVIDERS.some((p) => !visibleProviders.includes(p));
  addProviderBtn.style.display = hasAvailable ? '' : 'none';

  const cards = providerContainer.querySelectorAll('.card');
  cards.forEach((card) => {
    card.querySelector('.remove-btn').style.display = cards.length <= 1 ? 'none' : '';
  });
}

function buildBuiltinPromptCard() {
  const isDefault = !state.prompts?.activeId;
  const card = document.createElement('div');
  card.className = `card prompt-card${isDefault ? ' is-default' : ''}`;
  card.dataset.promptId = 'builtin';

  card.innerHTML = `
    <div class="card-top">
      <span class="prompt-name">Built-in Default</span>
      <div class="card-actions">
        <button type="button" class="default-pill${isDefault ? ' active' : ''}">Default</button>
      </div>
    </div>
    <details class="prompt-expand">
      <summary>View prompt</summary>
      <div class="prompt-expand-body">
        <div class="field">
          <span class="field-label">System</span>
          <div class="prompt-readonly">${escapeHtml(DEFAULT_PROMPTS.system)}</div>
        </div>
        <div class="field">
          <span class="field-label">User Template</span>
          <div class="prompt-readonly">${escapeHtml(DEFAULT_PROMPTS.user)}</div>
        </div>
      </div>
    </details>
  `;

  card.querySelector('.default-pill').addEventListener('click', () => {
    setDefaultPrompt(null);
  });

  return card;
}

function buildCustomPromptCard(prompt) {
  const isDefault = state.prompts?.activeId === prompt.id;
  const card = document.createElement('div');
  card.className = `card prompt-card${isDefault ? ' is-default' : ''}`;
  card.dataset.promptId = prompt.id;

  card.innerHTML = `
    <div class="card-top">
      <input type="text" class="prompt-name-input" value="${escapeAttr(prompt.name)}" placeholder="Prompt name">
      <div class="card-actions">
        <button type="button" class="default-pill${isDefault ? ' active' : ''}">Default</button>
        <button type="button" class="remove-btn" title="Remove">&times;</button>
      </div>
    </div>
    <div class="card-body">
      <div class="field">
        <span class="field-label">System Prompt</span>
        <textarea class="system-prompt-input" rows="4" placeholder="Instructions for the AI...">${escapeHtml(prompt.system || '')}</textarea>
      </div>
      <div class="field">
        <span class="field-label">User Template <span class="hint">Use {{context}} for page data</span></span>
        <textarea class="user-prompt-input" rows="4" placeholder="Describe what CSS to generate...">${escapeHtml(prompt.user || '')}</textarea>
      </div>
    </div>
  `;

  card.querySelector('.default-pill').addEventListener('click', () => {
    setDefaultPrompt(prompt.id);
  });

  card.querySelector('.remove-btn').addEventListener('click', () => {
    card.style.animation = 'cardOut 0.2s ease forwards';
    card.addEventListener('animationend', () => {
      card.remove();
      if (state.prompts?.activeId === prompt.id) {
        setDefaultPrompt(null);
      }
    });
  });

  return card;
}

function setDefaultPrompt(id) {
  if (!state.prompts) state.prompts = { activeId: null, custom: [] };
  state.prompts.activeId = id;

  promptContainer.querySelectorAll('.prompt-card').forEach((card) => {
    const match =
      (id === null && card.dataset.promptId === 'builtin') || card.dataset.promptId === id;
    card.classList.toggle('is-default', match);
    card.querySelector('.default-pill').classList.toggle('active', match);
  });
}

function renderProviders() {
  providerContainer.innerHTML = '';
  visibleProviders = [];

  for (const provider of MANAGED_PROVIDERS) {
    if (state.apiKeys[provider]) {
      addProviderCard(provider, state.apiKeys[provider]);
    }
  }

  if (state.customEndpoint.url || state.apiKeys.custom) {
    addProviderCard('custom', state.apiKeys.custom || state.customEndpoint.apiKey || '');
  }

  if (visibleProviders.length === 0) {
    addProviderCard(state.provider);
  }
}

function renderPrompts() {
  promptContainer.innerHTML = '';
  promptContainer.appendChild(buildBuiltinPromptCard());

  const custom = state.prompts?.custom || [];
  for (const prompt of custom) {
    promptContainer.appendChild(buildCustomPromptCard(prompt));
  }
}

function parseHeadersJson(value) {
  const text = value.trim();
  if (!text || text === '{}') return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Custom headers must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Custom headers must be a JSON object');
  }

  const normalized = {};
  for (const [key, val] of Object.entries(parsed)) {
    normalized[String(key)] = String(val);
  }
  return normalized;
}

function collectProviders() {
  const next = getDefaultLlmSettings();
  next.provider = state.provider;

  providerContainer.querySelectorAll('.card').forEach((card) => {
    const p = card.dataset.provider;
    if (!p) return;

    const apiKey = card.querySelector('.api-key-input')?.value.trim() || '';
    next.apiKeys[p] = apiKey;

    if (p === 'custom') {
      const modelInput = card.querySelector('.model-input');
      const endpointInput = card.querySelector('.endpoint-input');
      const headersInput = card.querySelector('.headers-input');

      next.customEndpoint = {
        url: endpointInput?.value.trim() || '',
        model: modelInput?.value.trim() || '',
        apiKey: apiKey,
        headers: headersInput ? parseHeadersJson(headersInput.value) : {},
      };
      if (next.customEndpoint.url && !isHttpsUrl(next.customEndpoint.url)) {
        throw new Error('Custom endpoint URL must use HTTPS');
      }
      next.models.custom = next.customEndpoint.model;
      next.apiKeys.custom = apiKey;
    } else {
      const modelSelect = card.querySelector('.model-select');
      next.models[p] = modelSelect?.value || PROVIDER_CONFIG[p]?.defaultModel || '';
    }
  });

  return next;
}

function collectPrompts() {
  const prompts = {
    activeId: state.prompts?.activeId || null,
    custom: [],
  };

  promptContainer.querySelectorAll('.prompt-card').forEach((card) => {
    const id = card.dataset.promptId;
    if (id === 'builtin') return;

    const name = card.querySelector('.prompt-name-input')?.value.trim() || 'Untitled';
    const system = card.querySelector('.system-prompt-input')?.value || '';
    const user = card.querySelector('.user-prompt-input')?.value || '';
    prompts.custom.push({ id, name, system, user });
  });

  return prompts;
}

async function save() {
  let settings;
  try {
    settings = collectProviders();
  } catch (err) {
    flash(err.message, 'error');
    return;
  }

  settings.prompts = collectPrompts();

  const defaultModel = settings.models[settings.provider] || '';
  const update = { llmSettings: settings };
  if (defaultModel) update.selectedModel = defaultModel;

  await chrome.storage.local.set(update);
  state = mergeLlmSettings(settings);

  saveBtn.textContent = 'Saved';
  saveBtn.classList.add('saved');
  flash('Settings saved', 'success');
  setTimeout(() => {
    saveBtn.textContent = 'Save';
    saveBtn.classList.remove('saved');
  }, 1500);
}

async function init() {
  try {
    const { llmSettings } = await chrome.storage.local.get('llmSettings');
    state = mergeLlmSettings(llmSettings);
    renderProviders();
    renderPrompts();
  } catch {
    flash('Failed to load settings', 'error');
  }

  saveBtn.addEventListener('click', save);

  resetBtn.addEventListener('click', async () => {
    const { llmSettings } = await chrome.storage.local.get('llmSettings');
    state = mergeLlmSettings(llmSettings);
    renderProviders();
    renderPrompts();
    flash('Reset to saved');
  });

  addProviderBtn.addEventListener('click', () => {
    const available = ALL_PROVIDERS.filter((p) => !visibleProviders.includes(p));
    if (available.length > 0) {
      addProviderCard(available[0]);
    }
  });

  addPromptBtn.addEventListener('click', () => {
    const id = `prompt-${Date.now()}`;
    const prompt = { id, name: '', system: '', user: '' };
    if (!state.prompts) state.prompts = { activeId: null, custom: [] };
    const card = buildCustomPromptCard(prompt);
    promptContainer.appendChild(card);
    card.querySelector('.prompt-name-input').focus();
  });

  initDebugUI();
}

async function initDebugUI() {
  const debugToggle = $('#debug-toggle');
  const logViewerWrap = $('#log-viewer-wrap');
  const logViewer = $('#log-viewer');
  const logCount = $('#log-count');
  const refreshBtn = $('#refresh-logs-btn');
  const clearBtn = $('#clear-logs-btn');

  const enabled = await getLoggingEnabled();
  debugToggle.checked = enabled;
  logViewerWrap.style.display = enabled ? '' : 'none';

  if (enabled) renderLogs();

  debugToggle.addEventListener('change', async () => {
    const on = debugToggle.checked;
    await setLogging(on);
    logViewerWrap.style.display = on ? '' : 'none';
    if (on) renderLogs();
  });

  refreshBtn.addEventListener('click', renderLogs);

  clearBtn.addEventListener('click', async () => {
    await clearLogs();
    renderLogs();
  });

  async function renderLogs() {
    const logs = await getLogs();
    logCount.textContent = `${logs.length} entries`;

    if (logs.length === 0) {
      logViewer.innerHTML = '<div class="log-empty">No logs yet</div>';
      return;
    }

    const html = logs
      .slice()
      .reverse()
      .map((entry) => {
        const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
        const dataHtml = entry.data
          ? `<div class="log-data">${escapeHtml(entry.data)}</div>`
          : '';
        return `<div class="log-entry">
          <span class="log-ts">${ts}</span>
          <span class="log-level ${entry.level || ''}">${escapeHtml(entry.level || '')}</span>
          <span class="log-source">[${escapeHtml(entry.source || '')}]</span>
          <span class="log-msg">${escapeHtml(entry.message || '')}</span>
          ${dataHtml}
        </div>`;
      })
      .join('');

    logViewer.innerHTML = html;
  }
}

init();
