import {
  OAUTH_PROVIDERS,
  PROVIDER_CONFIG,
  getDefaultLlmSettings,
  isHttpsUrl,
  mergeLlmSettings,
} from '../shared/llm-settings.js';

const PROVIDERS = PROVIDER_CONFIG;

const ui = {
  form: document.getElementById('settings-form'),
  defaultProvider: document.getElementById('default-provider'),
  providerSettings: document.getElementById('provider-settings'),
  syncPopupModel: document.getElementById('sync-popup-model'),
  customEndpointUrl: document.getElementById('custom-endpoint-url'),
  customModel: document.getElementById('custom-model'),
  customApiKey: document.getElementById('custom-api-key'),
  customHeaders: document.getElementById('custom-headers'),
  resetBtn: document.getElementById('reset-btn'),
  status: document.getElementById('status'),
};

let state = getDefaultLlmSettings();

function setStatus(message, type = '') {
  ui.status.textContent = message;
  ui.status.className = type;
}

function buildDefaultProviderOptions() {
  ui.defaultProvider.innerHTML = Object.entries(PROVIDERS)
    .map(([provider, info]) => `<option value="${provider}">${info.label}</option>`)
    .join('');
}

function toInputId(provider, field) {
  return `${provider}-${field}`;
}

function renderProviderCards() {
  const cards = Object.entries(PROVIDERS).map(([provider, info]) => {
    if (provider === 'custom') {
      return `
        <article class="provider-card" data-provider="${provider}">
          <div class="provider-head">
            <span class="provider-name">${info.label}</span>
            <span class="provider-kind">OpenAI-compatible</span>
          </div>
          <div class="field">
            <label class="field-label" for="${toInputId(provider, 'model')}">Model</label>
            <input id="${toInputId(provider, 'model')}" type="text" placeholder="custom-model-id">
          </div>
          <p class="oauth-status">Uses URL/API key/headers from the custom endpoint section.</p>
        </article>
      `;
    }

    return `
      <article class="provider-card" data-provider="${provider}">
        <div class="provider-head">
          <span class="provider-name">${info.label}</span>
          <span class="provider-kind">Managed</span>
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'model')}">Model</label>
          <input id="${toInputId(provider, 'model')}" type="text" placeholder="${info.defaultModel}">
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'auth')}">Auth mode</label>
          <select id="${toInputId(provider, 'auth')}">
            <option value="apiKey">API key</option>
            <option value="oauth">OAuth</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'api-key')}">API key</label>
          <input id="${toInputId(provider, 'api-key')}" type="password" autocomplete="off" placeholder="sk-...">
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'oauth-email')}">OAuth account email</label>
          <input id="${toInputId(provider, 'oauth-email')}" type="email" placeholder="name@example.com">
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'oauth-token')}">OAuth access token</label>
          <input id="${toInputId(provider, 'oauth-token')}" type="password" autocomplete="off" placeholder="oauth-token">
        </div>

        <div class="field">
          <label class="field-label" for="${toInputId(provider, 'oauth-scopes')}">OAuth scopes (comma separated)</label>
          <input id="${toInputId(provider, 'oauth-scopes')}" type="text" placeholder="scope.read, scope.write">
        </div>

        <div class="oauth-actions">
          <button type="button" class="button" data-action="oauth-connect" data-provider="${provider}">Connect</button>
          <button type="button" class="button warn" data-action="oauth-disconnect" data-provider="${provider}">Disconnect</button>
        </div>
        <p id="${toInputId(provider, 'oauth-status')}" class="oauth-status">Not connected</p>
      </article>
    `;
  });

  ui.providerSettings.innerHTML = cards.join('');
}

function hydrateForm() {
  ui.defaultProvider.value = state.provider;

  for (const provider of Object.keys(PROVIDERS)) {
    const modelInput = document.getElementById(toInputId(provider, 'model'));
    if (modelInput) {
      modelInput.value = state.models[provider] || '';
    }

    if (provider === 'custom') continue;

    const apiKeyInput = document.getElementById(toInputId(provider, 'api-key'));
    const authInput = document.getElementById(toInputId(provider, 'auth'));
    const oauthEmailInput = document.getElementById(toInputId(provider, 'oauth-email'));
    const oauthTokenInput = document.getElementById(toInputId(provider, 'oauth-token'));
    const oauthScopesInput = document.getElementById(toInputId(provider, 'oauth-scopes'));

    apiKeyInput.value = state.apiKeys[provider] || '';
    authInput.value = state.authModes[provider] || 'apiKey';

    const oauth = state.oauth[provider] || {};
    oauthEmailInput.value = oauth.accountEmail || '';
    oauthTokenInput.value = oauth.accessToken || '';
    oauthScopesInput.value = (oauth.scopes || []).join(', ');

    updateOAuthStatus(provider);
  }

  ui.customEndpointUrl.value = state.customEndpoint.url || '';
  ui.customModel.value = state.customEndpoint.model || '';
  ui.customApiKey.value = state.customEndpoint.apiKey || '';
  ui.customHeaders.value = JSON.stringify(state.customEndpoint.headers || {}, null, 2);
}

function updateOAuthStatus(provider) {
  const oauth = state.oauth[provider] || {};
  const statusNode = document.getElementById(toInputId(provider, 'oauth-status'));
  if (!statusNode) return;

  if (!oauth.connected) {
    statusNode.textContent = 'Not connected';
    return;
  }

  const updated = oauth.updatedAt ? new Date(oauth.updatedAt).toLocaleString() : 'unknown time';
  const email = oauth.accountEmail || 'unknown account';
  statusNode.textContent = `Connected as ${email} (${updated})`;
}

function readTextInput(id) {
  const node = document.getElementById(id);
  return node ? node.value.trim() : '';
}

function parseScopes(value) {
  return value
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
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

  if (!PROVIDERS[provider]) {
    throw new Error('Default provider is invalid');
  }

  next.provider = provider;

  for (const key of Object.keys(PROVIDERS)) {
    next.models[key] = readTextInput(toInputId(key, 'model')) || PROVIDERS[key].defaultModel;

    if (key === 'custom') continue;

    const authMode = readTextInput(toInputId(key, 'auth'));
    next.authModes[key] = authMode === 'oauth' ? 'oauth' : 'apiKey';

    next.apiKeys[key] = readTextInput(toInputId(key, 'api-key'));

    next.oauth[key] = {
      connected: Boolean(state.oauth[key] && state.oauth[key].connected),
      accountEmail: readTextInput(toInputId(key, 'oauth-email')),
      accessToken: readTextInput(toInputId(key, 'oauth-token')),
      scopes: parseScopes(readTextInput(toInputId(key, 'oauth-scopes'))),
      updatedAt: state.oauth[key] && state.oauth[key].updatedAt ? state.oauth[key].updatedAt : '',
    };
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

  const storageUpdate = {
    llmSettings: next,
  };

  if (ui.syncPopupModel.checked) {
    const defaultModel = next.models[next.provider] || '';
    if (defaultModel) {
      storageUpdate.selectedModel = defaultModel;
    }
  }

  await chrome.storage.local.set(storageUpdate);
  state = mergeLlmSettings(next);

  for (const provider of OAUTH_PROVIDERS) {
    updateOAuthStatus(provider);
  }

  setStatus('Settings saved', 'success');
}

function connectOAuth(provider) {
  const token = readTextInput(toInputId(provider, 'oauth-token'));
  const email = readTextInput(toInputId(provider, 'oauth-email'));

  if (!token) {
    setStatus(`Cannot connect ${PROVIDERS[provider].label}: missing access token`, 'error');
    return;
  }

  state.oauth[provider] = {
    connected: true,
    accessToken: token,
    accountEmail: email,
    scopes: parseScopes(readTextInput(toInputId(provider, 'oauth-scopes'))),
    updatedAt: new Date().toISOString(),
  };

  updateOAuthStatus(provider);
  setStatus(`${PROVIDERS[provider].label} marked as connected`, 'success');
}

function disconnectOAuth(provider) {
  state.oauth[provider] = {
    connected: false,
    accessToken: '',
    accountEmail: '',
    scopes: [],
    updatedAt: new Date().toISOString(),
  };

  const tokenInput = document.getElementById(toInputId(provider, 'oauth-token'));
  const emailInput = document.getElementById(toInputId(provider, 'oauth-email'));
  const scopesInput = document.getElementById(toInputId(provider, 'oauth-scopes'));
  tokenInput.value = '';
  emailInput.value = '';
  scopesInput.value = '';

  updateOAuthStatus(provider);
  setStatus(`${PROVIDERS[provider].label} disconnected`, 'success');
}

function wireEvents() {
  ui.form.addEventListener('submit', saveSettings);

  ui.resetBtn.addEventListener('click', () => {
    hydrateForm();
    setStatus('Reset unsaved changes');
  });

  ui.providerSettings.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    const provider = target.dataset.provider;
    if (!action || !provider || !OAUTH_PROVIDERS.includes(provider)) return;

    if (action === 'oauth-connect') {
      connectOAuth(provider);
      return;
    }

    if (action === 'oauth-disconnect') {
      disconnectOAuth(provider);
    }
  });
}

async function init() {
  try {
    buildDefaultProviderOptions();
    renderProviderCards();
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
