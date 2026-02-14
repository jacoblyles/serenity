export const PROVIDER_CONFIG = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    apiKeyStorageKey: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    supportsOAuth: true,
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-3-5-sonnet-latest',
    apiKeyStorageKey: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    supportsOAuth: true,
  },
  google: {
    label: 'Google',
    defaultModel: 'gemini-2.0-flash',
    apiKeyStorageKey: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    supportsOAuth: true,
  },
  custom: {
    label: 'Custom',
    defaultModel: '',
    apiKeyStorageKey: 'custom',
    endpoint: '',
    supportsOAuth: false,
  },
};

export const OAUTH_PROVIDERS = Object.keys(PROVIDER_CONFIG).filter(
  (provider) => PROVIDER_CONFIG[provider].supportsOAuth
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
    authModes: {
      openai: 'apiKey',
      anthropic: 'apiKey',
      google: 'apiKey',
    },
    oauth: {
      openai: {
        connected: false,
        accessToken: '',
        accountEmail: '',
        scopes: [],
        updatedAt: '',
      },
      anthropic: {
        connected: false,
        accessToken: '',
        accountEmail: '',
        scopes: [],
        updatedAt: '',
      },
      google: {
        connected: false,
        accessToken: '',
        accountEmail: '',
        scopes: [],
        updatedAt: '',
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
    authModes: {
      ...defaults.authModes,
      ...(settings.authModes || {}),
    },
    oauth: {
      ...defaults.oauth,
      ...(settings.oauth || {}),
      openai: {
        ...defaults.oauth.openai,
        ...((settings.oauth && settings.oauth.openai) || {}),
      },
      anthropic: {
        ...defaults.oauth.anthropic,
        ...((settings.oauth && settings.oauth.anthropic) || {}),
      },
      google: {
        ...defaults.oauth.google,
        ...((settings.oauth && settings.oauth.google) || {}),
      },
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
