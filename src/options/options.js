import {
  PROVIDER_CONFIG,
  PROVIDER_MODELS,
  MANAGED_PROVIDERS,
  getDefaultLlmSettings,
  isHttpsUrl,
  mergeLlmSettings,
} from '../shared/llm-settings.js';

const ui = {
  form: document.getElementById('settings-form'),
  defaultProvider: document.getElementById('default-provider'),
  providerList: document.getElementById('provider-list'),
  addProviderBtn: document.getElementById('add-provider-btn'),
  customEndpointUrl: document.getElementById('custom-endpoint-url'),
  customModel: document.getElementById('custom-model'),
  customApiKey: document.getElementById('custom-api-key'),
  customHeaders: document.getElementById('custom-headers'),
  resetBtn: document.getElementById('reset-btn'),
  status: document.getElementById('status'),
};

let state = getDefaultLlmSettings();
// Track which providers have visible rows
let visibleProviders = [];

function setStatus(message, type = '') {
  ui.status.textContent = message;
  ui.status.className = type;
}

function buildDefaultProviderOptions() {
  ui.defaultProvider.innerHTML = Object.entries(PROVIDER_CONFIG)
    .map(([provider, info]) => `<option value="${provider}">${info.label}</option>`)
    .join('');
}

function getAvailableProviders() {
  return MANAGED_PROVIDERS.filter((p) => !visibleProviders.includes(p));
}

function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  if (apiKey.startsWith('AI')) return 'google';
  return null;
}

function createProviderRow(provider, apiKey = '') {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return null;

  const row = document.createElement('div');
  row.className = 'provider-row';
  row.dataset.provider = provider;

  const models = PROVIDER_MODELS[provider] || [];
  const modelOptions = models
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join('');

  row.innerHTML = `
    <div class="provider-row-header">
      <span class="provider-name">${config.label}</span>
      <button type="button" class="remove-provider-btn" title="Remove">&times;</button>
    </div>
    <div class="provider-fields">
      <label class="field">
        <span class="field-label">API key</span>
        <input type="password" class="provider-api-key" autocomplete="off" placeholder="Paste your API key" value="${escapeAttr(apiKey)}">
      </label>
      <label class="field">
        <span class="field-label">Model</span>
        <select class="provider-model">${modelOptions}</select>
      </label>
    </div>
  `;

  const removeBtn = row.querySelector('.remove-provider-btn');
  removeBtn.addEventListener('click', () => {
    visibleProviders = visibleProviders.filter((p) => p !== provider);
    row.remove();
    updateAddButton();
  });

  return row;
}

function updateAddButton() {
  const available = getAvailableProviders();
  ui.addProviderBtn.style.display = available.length > 0 ? '' : 'none';
}

function addProviderPrompt() {
  const available = getAvailableProviders();
  if (available.length === 0) return;

  if (available.length === 1) {
    addProvider(available[0]);
    return;
  }

  // Show a simple picker
  const picker = document.createElement('div');
  picker.className = 'provider-picker';
  for (const provider of available) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button';
    btn.textContent = PROVIDER_CONFIG[provider].label;
    btn.addEventListener('click', () => {
      picker.remove();
      addProvider(provider);
    });
    picker.appendChild(btn);
  }
  ui.providerList.appendChild(picker);
}

function addProvider(provider, apiKey = '') {
  // Remove any picker
  const picker = ui.providerList.querySelector('.provider-picker');
  if (picker) picker.remove();

  if (visibleProviders.includes(provider)) return;
  visibleProviders.push(provider);

  const row = createProviderRow(provider, apiKey);
  if (!row) return;

  // Set model to saved value or default
  const modelSelect = row.querySelector('.provider-model');
  const savedModel = state.models[provider] || PROVIDER_CONFIG[provider].defaultModel;
  if (modelSelect) modelSelect.value = savedModel;

  ui.providerList.appendChild(row);
  updateAddButton();
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function hydrateForm() {
  ui.defaultProvider.value = state.provider;

  // Clear and rebuild provider rows
  ui.providerList.innerHTML = '';
  visibleProviders = [];

  // Show rows for providers that have an API key set
  for (const provider of MANAGED_PROVIDERS) {
    const key = state.apiKeys[provider] || '';
    if (key) {
      addProvider(provider, key);
    }
  }

  // If no providers have keys, show the default provider row
  if (visibleProviders.length === 0) {
    addProvider(state.provider);
  }

  ui.customEndpointUrl.value = state.customEndpoint.url || '';
  ui.customModel.value = state.customEndpoint.model || '';
  ui.customApiKey.value = state.customEndpoint.apiKey || '';
  ui.customHeaders.value = JSON.stringify(state.customEndpoint.headers || {}, null, 2);

  updateAddButton();
}

function parseHeadersJson(value) {
  const text = value.trim();
  if (!text) return {};

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

function collectFromForm() {
  const next = getDefaultLlmSettings();
  const provider = ui.defaultProvider.value;

  if (!PROVIDER_CONFIG[provider]) {
    throw new Error('Default provider is invalid');
  }
  next.provider = provider;

  // Read from visible provider rows
  const rows = ui.providerList.querySelectorAll('.provider-row');
  for (const row of rows) {
    const p = row.dataset.provider;
    if (!p) continue;
    const apiKeyInput = row.querySelector('.provider-api-key');
    const modelSelect = row.querySelector('.provider-model');
    next.apiKeys[p] = apiKeyInput ? apiKeyInput.value.trim() : '';
    next.models[p] = modelSelect ? modelSelect.value : PROVIDER_CONFIG[p]?.defaultModel || '';
  }

  next.customEndpoint = {
    url: ui.customEndpointUrl.value.trim(),
    model: ui.customModel.value.trim(),
    apiKey: ui.customApiKey.value.trim(),
    headers: parseHeadersJson(ui.customHeaders.value),
  };
  if (next.customEndpoint.url && !isHttpsUrl(next.customEndpoint.url)) {
    throw new Error('Custom endpoint URL must use HTTPS');
  }

  next.apiKeys.custom = next.customEndpoint.apiKey;
  next.models.custom = next.customEndpoint.model || next.models.custom;

  return next;
}

async function saveSettings(event) {
  event.preventDefault();
  setStatus('Saving...');

  let next;
  try {
    next = collectFromForm();
  } catch (error) {
    setStatus(error.message || 'Invalid settings', 'error');
    return;
  }

  const defaultModel = next.models[next.provider] || '';
  const storageUpdate = { llmSettings: next };
  if (defaultModel) {
    storageUpdate.selectedModel = defaultModel;
  }

  await chrome.storage.local.set(storageUpdate);
  state = mergeLlmSettings(next);

  setStatus('Settings saved', 'success');
}

function wireEvents() {
  ui.form.addEventListener('submit', saveSettings);

  ui.resetBtn.addEventListener('click', () => {
    hydrateForm();
    setStatus('Reset unsaved changes');
  });

  ui.addProviderBtn.addEventListener('click', addProviderPrompt);

  // Auto-detect provider from pasted API key
  ui.providerList.addEventListener('input', (event) => {
    if (!event.target.classList.contains('provider-api-key')) return;
    const row = event.target.closest('.provider-row');
    if (!row) return;
    // Auto-detect is only useful if we eventually want to switch providers,
    // but for now each row already has a known provider
  });
}

async function init() {
  try {
    buildDefaultProviderOptions();
    wireEvents();

    const { llmSettings } = await chrome.storage.local.get('llmSettings');
    state = mergeLlmSettings(llmSettings);
    hydrateForm();
    setStatus('Loaded');
  } catch (error) {
    setStatus('Failed to load settings', 'error');
  }
}

init();
