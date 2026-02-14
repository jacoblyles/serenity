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
    const content = normalizeMessageContent(message.content);
    if (!message.role || !content) continue;
    normalized.push({
      role: String(message.role),
      content,
    });
  }

  return normalized;
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const normalizedParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      normalizedParts.push({ type: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image_url' &&
      part.image_url &&
      typeof part.image_url === 'object' &&
      typeof part.image_url.url === 'string' &&
      part.image_url.url.startsWith('data:image/')
    ) {
      normalizedParts.push({
        type: 'image_url',
        image_url: { url: part.image_url.url },
      });
    }
  }

  return normalizedParts.length ? normalizedParts : '';
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
    authModes: {
      openai: 'apiKey',
      anthropic: 'apiKey',
      google: 'apiKey',
    },
    oauth: {
      openai: {
        connected: false,
        accessToken: '',
      },
      anthropic: {
        connected: false,
        accessToken: '',
      },
      google: {
        connected: false,
        accessToken: '',
      },
    },
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
    authModes: {
      ...getDefaultSettings().authModes,
      ...((llmSettings && llmSettings.authModes) || {}),
    },
    oauth: {
      ...getDefaultSettings().oauth,
      ...((llmSettings && llmSettings.oauth) || {}),
      openai: {
        ...getDefaultSettings().oauth.openai,
        ...(((llmSettings && llmSettings.oauth) || {}).openai || {}),
      },
      anthropic: {
        ...getDefaultSettings().oauth.anthropic,
        ...(((llmSettings && llmSettings.oauth) || {}).anthropic || {}),
      },
      google: {
        ...getDefaultSettings().oauth.google,
        ...(((llmSettings && llmSettings.oauth) || {}).google || {}),
      },
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

function resolveAuthForProvider(provider, settings, apiKeyOverride) {
  if (provider === 'custom') {
    return {
      type: 'apiKey',
      credential: getApiKeyForProvider(provider, settings, apiKeyOverride),
    };
  }

  const authMode =
    settings.authModes && settings.authModes[provider] === 'oauth' ? 'oauth' : 'apiKey';

  if (provider === 'anthropic' && authMode === 'oauth') {
    const oauth = settings.oauth && settings.oauth[provider];
    return {
      type: 'oauth',
      connected: Boolean(oauth && oauth.connected),
      credential: oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : '',
    };
  }

  return {
    type: 'apiKey',
    credential: getApiKeyForProvider(provider, settings, apiKeyOverride),
  };
}

function ensureRequiredConfig(provider, model, auth, settings, endpointOverride) {
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

  if (provider === 'anthropic' && auth.type === 'oauth') {
    if (!auth.connected) {
      throw new Error('Anthropic OAuth is selected but not connected');
    }
    if (!auth.credential) {
      throw new Error('Anthropic OAuth is selected but access token is missing');
    }
    return;
  }

  if (!auth.credential) {
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
  const normalizedMessages = messages.map((message) => ({
    role: message.role,
    content: convertToOpenAiContent(message.content),
  }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages: normalizedMessages,
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
  auth,
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
      content: convertToAnthropicContent(msg.content),
    }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth.type === 'oauth'
        ? { authorization: `Bearer ${auth.credential}` }
        : { 'x-api-key': auth.credential }),
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
        parts: convertToGoogleParts(msg.content),
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

function convertToOpenAiContent(content) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'image_url',
      image_url: { url: part.image_url.url },
    };
  });
}

function convertToAnthropicContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];

  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url') {
      const parsed = parseDataUrl(part.image_url.url);
      if (!parsed) continue;
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mimeType,
          data: parsed.base64Data,
        },
      });
    }
  }

  return parts;
}

function convertToGoogleParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  const parts = [];

  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
      continue;
    }

    if (part.type === 'image_url') {
      const parsed = parseDataUrl(part.image_url.url);
      if (!parsed) continue;
      parts.push({
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.base64Data,
        },
      });
    }
  }

  return parts;
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64Data: match[2],
  };
}

export async function completeLlmRequest(request = {}) {
  const settings = await readLlmSettings();
  const provider = resolveProvider(request.provider || settings.provider);
  const model = getModelForProvider(provider, settings, request.model);
  const auth = resolveAuthForProvider(provider, settings, request.apiKey);
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

  ensureRequiredConfig(provider, model, auth, settings, request.endpoint);

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
          apiKey: auth.credential,
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
          auth,
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
          apiKey: auth.credential,
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
          apiKey: auth.credential,
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
