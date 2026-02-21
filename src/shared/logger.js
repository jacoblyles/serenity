const MAX_LOG_ENTRIES = 300;
const STORAGE_KEY = 'debugLogs';
const ENABLED_KEY = 'debugLogging';

async function isEnabled() {
  const data = await chrome.storage.local.get(ENABLED_KEY);
  return Boolean(data[ENABLED_KEY]);
}

async function append(level, source, message, data) {
  if (!(await isEnabled())) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    source,
    message,
  };
  if (data !== undefined) {
    try {
      entry.data = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
    } catch {
      entry.data = String(data);
    }
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const logs = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  logs.push(entry);

  if (logs.length > MAX_LOG_ENTRIES) {
    logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: logs });
}

export const log = {
  info: (source, message, data) => append('info', source, message, data),
  warn: (source, message, data) => append('warn', source, message, data),
  error: (source, message, data) => append('error', source, message, data),
};

export async function getLogs() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

export async function clearLogs() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

export async function setLogging(enabled) {
  await chrome.storage.local.set({ [ENABLED_KEY]: Boolean(enabled) });
}

export async function getLoggingEnabled() {
  return isEnabled();
}
