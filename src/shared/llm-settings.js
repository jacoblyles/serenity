export const PROVIDER_MODELS = {
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
    { id: 'gpt-5.2', label: 'GPT-5.2', tier: 'balanced' },
    { id: 'gpt-5.2-pro', label: 'GPT-5.2 Pro', tier: 'strong' },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', tier: 'fast' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'balanced' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', tier: 'strong' },
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'fast' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'balanced' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', tier: 'balanced' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', tier: 'strong' },
  ],
  xai: [
    { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast', tier: 'fast' },
    { id: 'grok-4-1-fast-reasoning', label: 'Grok 4.1 Fast Reasoning', tier: 'balanced' },
  ],
};

export const PROVIDER_CONFIG = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.2',
    apiKeyStorageKey: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-6',
    apiKeyStorageKey: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  google: {
    label: 'Google',
    defaultModel: 'gemini-2.5-flash',
    apiKeyStorageKey: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
  },
  xai: {
    label: 'xAI (Grok)',
    defaultModel: 'grok-4-1-fast-non-reasoning',
    apiKeyStorageKey: 'xai',
    endpoint: 'https://api.x.ai/v1/chat/completions',
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

export const DEFAULT_PROMPTS = {
  system: [
    'You are a CSS-only assistant.',
    'Generate dark mode CSS for the provided webpage context.',
    'Return CSS only. Do not include Markdown or explanations.',
    'Preserve readability and contrast while minimizing layout changes.',
    'Prefer scoped overrides on common selectors and avoid !important unless necessary.',
  ].join(' '),
  user: [
    'Create CSS that applies a visually pleasing dark theme to this page context.',
    'Goals:',
    '- Darken page backgrounds while preserving hierarchy.',
    '- Use light text with sufficient contrast.',
    '- Keep links/buttons distinguishable and accessible.',
    '- Handle forms, tables, cards, and code blocks when present.',
    '- Do not hide content or change spacing/layout dramatically.',
    'Page context JSON:',
    '{{context}}',
  ].join('\n'),
};

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
    prompts: {
      activeId: null,
      custom: [],
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
    prompts: {
      activeId: settings.prompts?.activeId ?? null,
      custom: Array.isArray(settings.prompts?.custom) ? settings.prompts.custom : [],
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
