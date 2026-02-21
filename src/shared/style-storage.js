export const STYLE_STORAGE_KEY = 'darkModeStyles';
export const SCHEMA_VERSION = 2;
export const MAX_VERSIONS = 8;

export function migrateV1ToV2(styles) {
  const migrated = createEmptyStyleStorage();
  if (!isObject(styles)) return migrated;

  for (const [domain, entry] of Object.entries(styles)) {
    if (domain === '_schemaVersion') continue;
    if (!isObject(entry)) continue;

    const migratedEntry = {
      activeVersionId: null,
      versions: [],
      pages: {},
    };

    if (typeof entry.css === 'string') {
      const version = createVersion(entry.css, { scope: 'domain', prefix: 'v' });
      migratedEntry.versions.push(version);
      migratedEntry.activeVersionId = version.id;
    }

    if (isObject(entry.pages)) {
      for (const [page, css] of Object.entries(entry.pages)) {
        if (typeof css !== 'string') continue;
        const version = createVersion(css, { prefix: 'pv' });
        migratedEntry.pages[page] = {
          activeVersionId: version.id,
          versions: [version],
        };
      }
    }

    if (migratedEntry.versions.length > 0 || Object.keys(migratedEntry.pages).length > 0) {
      migrated[domain] = migratedEntry;
    }
  }

  return migrated;
}

export function ensureMigratedStyles(rawStyles) {
  if (isObject(rawStyles) && rawStyles._schemaVersion === SCHEMA_VERSION) {
    return { styles: rawStyles, migrated: false };
  }
  return { styles: migrateV1ToV2(rawStyles), migrated: true };
}

export function createVersion(css, { scope = null, prefix = 'v', provider = null, model = null } = {}) {
  const version = {
    id: createVersionId(prefix),
    css,
    timestamp: new Date().toISOString(),
    provider,
    model,
  };
  if (typeof scope === 'string') {
    version.scope = scope;
  }
  return version;
}

function createEmptyStyleStorage() {
  return { _schemaVersion: SCHEMA_VERSION };
}

function createVersionId(prefix) {
  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
