// OAuth authentication support for providers.
//
// No provider currently supports extension-managed OAuth in this project.
// Keep this module as a future expansion point.

export function resolveOAuth(_provider, _settings) {
  return null;
}

export function validateOAuth(_provider, _auth) {
  return false;
}

export function getOAuthHeaders(_auth) {
  return null;
}
