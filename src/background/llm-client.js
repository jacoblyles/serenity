const PROVIDER_CONFIG = {
  openai: {
    defaultModel: 'gpt-4.1-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKeyStorageKey: 'openai',
  },
  anthropic: {
    defaultModel: 'claude-3-5-sonnet-latest',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKeyStorageKey: 'anthropic',
  },
  google: {
    defaultModel: 'gemini-2.0-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    apiKeyStorageKey: 'google',
  },
  custom: {
    defaultModel: '',
    endpoint: '',
    apiKeyStorageKey: 'custom',
  },
};

function normalizeMessages(messages, systemPrompt) {
  const normalized = [];
  if (systemPrompt) {
    normalized.push({ role: 'system', content: String(systemPrompt) });
  }

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (!message.role || !message.content) continue;
    normalized.push({
      role: String(message.role),
      content: String(message.content),
    });
  }

  return normalized;
}

function getErrorMessage(responseBody, fallback) {
  if (!responseBody || typeof responseBody !== 'object') return fallback;
  if (typeof responseBody.error === 'string') return responseBody.error;
  if (responseBody.error && typeof responseBody.error.message === 'string') {
    return responseBody.error.message;
  }
  return fallback;
}

async function parseErrorResponse(response) {
  let parsed = null;
  try {
    parsed = await response.json();
  } catch (_error) {
    // Ignore parse errors; we still surface status text below.
  }

  const message = getErrorMessage(
    parsed,
    `Provider request failed (${response.status} ${response.statusText})`
  );

  throw new Error(message);
}

function getDefaultSettings() {
  return {
    provider: 'openai',
    models: {},
    apiKeys: {},
    customEndpoint: {
      url: '',
      model: '',
      apiKey: '',
      headers: {},
    },
  };
}

async function readLlmSettings() {
  const { llmSettings } = await chrome.storage.local.get('llmSettings');
  return {
    ...getDefaultSettings(),
    ...(llmSettings || {}),
    models: {
      ...getDefaultSettings().models,
      ...((llmSettings && llmSettings.models) || {}),
    },
    apiKeys: {
      ...getDefaultSettings().apiKeys,
      ...((llmSettings && llmSettings.apiKeys) || {}),
    },
    customEndpoint: {
      ...getDefaultSettings().customEndpoint,
      ...((llmSettings && llmSettings.customEndpoint) || {}),
    },
  };
}

function resolveProvider(provider) {
  if (!provider) return 'openai';
  if (!PROVIDER_CONFIG[provider]) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
  return provider;
}

function getModelForProvider(provider, settings, modelOverride) {
  if (modelOverride) return modelOverride;
  if (settings.models && settings.models[provider]) return settings.models[provider];
  if (provider === 'custom' && settings.customEndpoint.model) {
    return settings.customEndpoint.model;
  }
  return PROVIDER_CONFIG[provider].defaultModel;
}

function getApiKeyForProvider(provider, settings, apiKeyOverride) {
  if (apiKeyOverride) return apiKeyOverride;
  if (provider === 'custom' && settings.customEndpoint.apiKey) {
    return settings.customEndpoint.apiKey;
  }

  const storageKey = PROVIDER_CONFIG[provider].apiKeyStorageKey;
  return settings.apiKeys[storageKey] || '';
}

function ensureRequiredConfig(provider, model, apiKey, settings, endpointOverride) {
  if (!model) {
    throw new Error(`No model configured for provider "${provider}"`);
  }

  if (provider === 'custom') {
    const endpoint = endpointOverride || settings.customEndpoint.url;
    if (!endpoint) {
      throw new Error('No custom endpoint URL configured');
    }
    return;
  }

  if (!apiKey) {
    throw new Error(`Missing API key for provider "${provider}"`);
  }
}

async function requestOpenAiLikeCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  headers = {},
}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
    }),
  });

  if (!response.ok) await parseErrorResponse(response);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';

  if (!text) {
    throw new Error('No text returned from provider');
  }

  return { text, raw: data };
}

async function requestAnthropicCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
}) {
  const system = messages.find((msg) => msg.role === 'system')?.content || '';
  const conversationalMessages = messages
    .filter((msg) => msg.role !== 'system')
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(system ? { system } : {}),
      messages: conversationalMessages,
    }),
  });

  if (!response.ok) await parseErrorResponse(response);
  const data = await response.json();
  const text = (data?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('No text returned from provider');
  }

  return { text, raw: data };
}

async function requestGoogleCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
}) {
  const system = messages.find((msg) => msg.role === 'system')?.content || '';
  const promptMessages = messages.filter((msg) => msg.role !== 'system');
  const url = `${endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...(system
        ? {
            systemInstruction: {
              parts: [{ text: system }],
            },
          }
        : {}),
      contents: promptMessages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { maxOutputTokens: maxTokens } : {}),
      },
    }),
  });

  if (!response.ok) await parseErrorResponse(response);
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('No text returned from provider');
  }

  return { text, raw: data };
}

export async function completeLlmRequest(request = {}) {
  const settings = await readLlmSettings();
  const provider = resolveProvider(request.provider || settings.provider);
  const model = getModelForProvider(provider, settings, request.model);
  const apiKey = getApiKeyForProvider(provider, settings, request.apiKey);
  const messages = normalizeMessages(request.messages, request.systemPrompt);
  const endpoint =
    request.endpoint ||
    (provider === 'custom' ? settings.customEndpoint.url : PROVIDER_CONFIG[provider].endpoint);
  const headers =
    provider === 'custom'
      ? {
          ...(settings.customEndpoint.headers || {}),
          ...(request.headers || {}),
        }
      : {};

  ensureRequiredConfig(provider, model, apiKey, settings, request.endpoint);

  if (!messages.length) {
    throw new Error('At least one message is required');
  }

  switch (provider) {
    case 'openai':
      return {
        provider,
        model,
        ...(await requestOpenAiLikeCompletion({
          endpoint,
          apiKey,
          model,
          messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        })),
      };
    case 'anthropic':
      return {
        provider,
        model,
        ...(await requestAnthropicCompletion({
          endpoint,
          apiKey,
          model,
          messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        })),
      };
    case 'google':
      return {
        provider,
        model,
        ...(await requestGoogleCompletion({
          endpoint,
          apiKey,
          model,
          messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        })),
      };
    case 'custom':
      return {
        provider,
        model,
        ...(await requestOpenAiLikeCompletion({
          endpoint,
          apiKey,
          model,
          messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          headers,
        })),
      };
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

export function listSupportedProviders() {
  return Object.keys(PROVIDER_CONFIG);
}
