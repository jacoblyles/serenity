export const PROVIDER_MODELS = {
  openai: [
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', tier: 'fast' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', tier: 'balanced' },
    { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'strong' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', tier: 'balanced' },
    { id: 'claude-opus-4-20250918', label: 'Claude Opus 4', tier: 'strong' },
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'fast' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'strong' },
  ],
};

export const PROVIDER_CONFIG = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    apiKeyStorageKey: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    apiKeyStorageKey: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  google: {
    label: 'Google',
    defaultModel: 'gemini-2.5-flash',
    apiKeyStorageKey: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
  },
  custom: {
    label: 'Custom',
    defaultModel: '',
    apiKeyStorageKey: 'custom',
    endpoint: '',
  },
};

export const MANAGED_PROVIDERS = Object.keys(PROVIDER_CONFIG).filter(
  (provider) => provider !== 'custom'
);

export function getDefaultLlmSettings() {
  return {
    provider: 'openai',
    models: Object.fromEntries(
      Object.entries(PROVIDER_CONFIG).map(([provider, config]) => [provider, config.defaultModel])
    ),
    apiKeys: Object.fromEntries(
      Object.entries(PROVIDER_CONFIG).map(([, config]) => [config.apiKeyStorageKey, ''])
    ),
    customEndpoint: {
      url: '',
      model: '',
      apiKey: '',
      headers: {},
    },
  };
}

export function mergeLlmSettings(rawSettings) {
  const defaults = getDefaultLlmSettings();
  const settings = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};

  return {
    ...defaults,
    ...settings,
    models: {
      ...defaults.models,
      ...(settings.models || {}),
    },
    apiKeys: {
      ...defaults.apiKeys,
      ...(settings.apiKeys || {}),
    },
    customEndpoint: {
      ...defaults.customEndpoint,
      ...(settings.customEndpoint || {}),
      headers: {
        ...defaults.customEndpoint.headers,
        ...(((settings.customEndpoint || {}).headers) || {}),
      },
    },
  };
}

export function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;

  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}
