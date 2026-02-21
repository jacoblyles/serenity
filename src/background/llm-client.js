import { PROVIDER_CONFIG, isHttpsUrl, mergeLlmSettings } from '../shared/llm-settings.js';
import { resolveOAuth, validateOAuth, getOAuthHeaders } from './oauth.js';
import {
  toOpenAiTools,
  toAnthropicTools,
  toGoogleTools,
  parseOpenAiToolCalls,
  parseAnthropicToolCalls,
  parseGoogleToolCalls,
} from './llm-tools.js';

function normalizeMessages(messages, systemPrompt) {
  const normalized = [];
  if (systemPrompt) {
    normalized.push({ role: 'system', content: String(systemPrompt) });
  }

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    const content = normalizeMessageContent(message.content);
    const hasAssistantToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!message.role || (!content && !hasAssistantToolCalls)) continue;
    const role = String(message.role);
    const normalizedMessage = {
      role,
      content,
    };

    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      normalizedMessage.tool_calls = normalizeOpenAiAssistantToolCalls(message.tool_calls);
    }

    if (role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id) {
      normalizedMessage.tool_call_id = message.tool_call_id;
    }

    normalized.push(normalizedMessage);
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
      part.type === 'tool_result' &&
      typeof part.tool_use_id === 'string' &&
      (typeof part.content === 'string' || Array.isArray(part.content))
    ) {
      normalizedParts.push({
        type: 'tool_result',
        tool_use_id: part.tool_use_id,
        content:
          typeof part.content === 'string'
            ? part.content
            : normalizeAnthropicToolResultParts(part.content),
      });
      continue;
    }

    if (
      part.type === 'tool_use' &&
      typeof part.id === 'string' &&
      typeof part.name === 'string'
    ) {
      normalizedParts.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: isObject(part.input) ? part.input : {},
      });
      continue;
    }

    if (
      part.functionResponse &&
      typeof part.functionResponse === 'object' &&
      typeof part.functionResponse.name === 'string'
    ) {
      normalizedParts.push({
        functionResponse: {
          name: part.functionResponse.name,
          response: part.functionResponse.response,
        },
      });
      continue;
    }

    if (
      part.functionCall &&
      typeof part.functionCall === 'object' &&
      typeof part.functionCall.name === 'string'
    ) {
      normalizedParts.push({
        functionCall: {
          name: part.functionCall.name,
          args: isObject(part.functionCall.args) ? part.functionCall.args : {},
        },
      });
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

function normalizeOpenAiAssistantToolCalls(toolCalls) {
  return toolCalls
    .map((call) => {
      const functionName = call?.function?.name;
      if (typeof functionName !== 'string' || !functionName) return null;
      const rawArguments = call?.function?.arguments;
      const parsedArguments = parseToolArguments(rawArguments);
      return {
        id: typeof call?.id === 'string' && call.id ? call.id : generateToolCallId(),
        type: 'function',
        function: {
          name: functionName,
          arguments: JSON.stringify(parsedArguments),
        },
      };
    })
    .filter(Boolean);
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

async function readLlmSettings() {
  const { llmSettings } = await chrome.storage.local.get('llmSettings');
  return mergeLlmSettings(llmSettings);
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
  const oauthResult = resolveOAuth(provider, settings);
  if (oauthResult) return oauthResult;

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
    if (!isHttpsUrl(endpoint)) {
      throw new Error('Custom endpoint URL must use HTTPS');
    }
    return;
  }

  if (validateOAuth(provider, auth)) return;

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
  tools,
}) {
  const normalizedMessages = messages.map((message) => convertToOpenAiMessage(message));
  const parsedTools = toOpenAiTools(tools);

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
      ...(parsedTools.length ? { tools: parsedTools } : {}),
    }),
  });

  if (!response.ok) await parseErrorResponse(response);
  const data = await response.json();
  const text = extractOpenAiText(data?.choices?.[0]?.message?.content);
  const toolCalls = parseOpenAiToolCalls(data);

  if (!text && !toolCalls.length) {
    throw new Error('No text returned from provider');
  }

  return { text, toolCalls, raw: data };
}

function convertToOpenAiMessage(message) {
  const openAiMessage = {
    role: message.role,
    content: convertToOpenAiContent(message.content),
  };

  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    openAiMessage.tool_calls = normalizeOpenAiAssistantToolCalls(message.tool_calls);
  }

  if (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id) {
    openAiMessage.tool_call_id = message.tool_call_id;
  }

  return openAiMessage;
}

async function requestAnthropicCompletion({
  endpoint,
  auth,
  model,
  messages,
  temperature,
  maxTokens,
  tools,
}) {
  const system = messages.find((msg) => msg.role === 'system')?.content || '';
  const providerTools = toAnthropicTools(tools);
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
      ...(getOAuthHeaders(auth) || { 'x-api-key': auth.credential }),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(system ? { system } : {}),
      messages: conversationalMessages,
      ...(providerTools.length ? { tools: providerTools } : {}),
    }),
  });

  if (!response.ok) await parseErrorResponse(response);
  const data = await response.json();
  const text = (data?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  const toolCalls = parseAnthropicToolCalls(data);

  if (!text && !toolCalls.length) {
    throw new Error('No text returned from provider');
  }

  return { text, toolCalls, raw: data };
}

async function requestGoogleCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  tools,
}) {
  const system = messages.find((msg) => msg.role === 'system')?.content || '';
  const promptMessages = messages.filter((msg) => msg.role !== 'system');
  const providerTools = toGoogleTools(tools);
  const url = `${endpoint}/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
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
      ...(providerTools.length ? { tools: providerTools } : {}),
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
  const toolCalls = parseGoogleToolCalls(data);

  if (!text && !toolCalls.length) {
    throw new Error('No text returned from provider');
  }

  return { text, toolCalls, raw: data };
}

function convertToOpenAiContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];

  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url') {
      parts.push({
        type: 'image_url',
        image_url: { url: part.image_url.url },
      });
    }
  }

  return parts;
}

function extractOpenAiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => (part?.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
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
      continue;
    }

    if (
      part.type === 'tool_use' &&
      typeof part.id === 'string' &&
      typeof part.name === 'string'
    ) {
      parts.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: isObject(part.input) ? part.input : {},
      });
      continue;
    }

    if (
      part.type === 'tool_result' &&
      typeof part.tool_use_id === 'string' &&
      (typeof part.content === 'string' || Array.isArray(part.content))
    ) {
      parts.push({
        type: 'tool_result',
        tool_use_id: part.tool_use_id,
        content:
          typeof part.content === 'string'
            ? part.content
            : convertToAnthropicToolResultContent(part.content),
      });
    }
  }

  return parts;
}

function normalizeAnthropicToolResultParts(contentParts) {
  const normalized = [];

  for (const part of contentParts) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      normalized.push({ type: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image' &&
      part.source &&
      typeof part.source === 'object' &&
      part.source.type === 'base64' &&
      typeof part.source.media_type === 'string' &&
      typeof part.source.data === 'string'
    ) {
      normalized.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.source.media_type,
          data: part.source.data,
        },
      });
    }
  }

  return normalized;
}

function convertToAnthropicToolResultContent(contentParts) {
  const converted = [];

  for (const part of contentParts) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text' && typeof part.text === 'string') {
      converted.push({ type: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image' &&
      part.source &&
      typeof part.source === 'object' &&
      part.source.type === 'base64' &&
      typeof part.source.media_type === 'string' &&
      typeof part.source.data === 'string'
    ) {
      converted.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.source.media_type,
          data: part.source.data,
        },
      });
    }
  }

  return converted;
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
      continue;
    }

    if (
      part.functionCall &&
      typeof part.functionCall === 'object' &&
      typeof part.functionCall.name === 'string'
    ) {
      parts.push({
        functionCall: {
          name: part.functionCall.name,
          args: isObject(part.functionCall.args) ? part.functionCall.args : {},
        },
      });
      continue;
    }

    if (
      part.functionResponse &&
      typeof part.functionResponse === 'object' &&
      typeof part.functionResponse.name === 'string'
    ) {
      parts.push({
        functionResponse: {
          name: part.functionResponse.name,
          response: part.functionResponse.response,
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

function parseToolArguments(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function generateToolCallId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `toolcall_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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
          tools: request.tools,
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
          tools: request.tools,
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
          tools: request.tools,
        })),
      };
    case 'xai':
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
          tools: request.tools,
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
          tools: request.tools,
        })),
      };
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

export function listSupportedProviders() {
  return Object.keys(PROVIDER_CONFIG);
}
