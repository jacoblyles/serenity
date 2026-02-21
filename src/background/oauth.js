// OAuth authentication support for providers.
//
// Currently unused — Anthropic banned third-party OAuth tokens in Feb 2026.
// Kept as a potential future expansion if providers open OAuth to extensions.
// See: https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/

export function resolveOAuth(provider, settings) {
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

  return null;
}

export function validateOAuth(provider, auth) {
  if (provider === 'anthropic' && auth.type === 'oauth') {
    if (!auth.connected) {
      throw new Error('Anthropic OAuth is selected but not connected');
    }
    if (!auth.credential) {
      throw new Error('Anthropic OAuth is selected but access token is missing');
    }
    return true;
  }
  return false;
}

export function getOAuthHeaders(auth) {
  if (auth.type === 'oauth') {
    return { authorization: `Bearer ${auth.credential}` };
  }
  return null;
}
