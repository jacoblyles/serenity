const METRICS_STORAGE_KEY = 'serenityMetrics';
const RECENT_GENERATIONS_LIMIT = 50;
const SUPPORTED_MODES = ['single-pass', 'two-pass', 'agent'];

function emptyBucket() {
  return { count: 0, totalMs: 0 };
}

function normalizeMode(mode) {
  return SUPPORTED_MODES.includes(mode) ? mode : 'single-pass';
}

function normalizeDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function normalizeProvider(provider) {
  if (typeof provider !== 'string') return '';
  return provider.trim().toLowerCase();
}

function normalizeRecentUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return 'unknown';
  return url.trim().slice(0, 500);
}

function createDefaultMetrics() {
  return {
    totalGenerations: 0,
    successCount: 0,
    failCount: 0,
    nativeDarkModeCount: 0,
    byMode: {
      'single-pass': emptyBucket(),
      'two-pass': emptyBucket(),
      agent: emptyBucket(),
    },
    byProvider: {},
    recentGenerations: [],
  };
}

function mergeMetrics(rawMetrics) {
  const base = createDefaultMetrics();
  if (!rawMetrics || typeof rawMetrics !== 'object' || Array.isArray(rawMetrics)) {
    return base;
  }

  const merged = {
    ...base,
    ...rawMetrics,
    byMode: {
      ...base.byMode,
      ...(rawMetrics.byMode && typeof rawMetrics.byMode === 'object' ? rawMetrics.byMode : {}),
    },
    byProvider: (rawMetrics.byProvider && typeof rawMetrics.byProvider === 'object')
      ? { ...rawMetrics.byProvider }
      : {},
    recentGenerations: Array.isArray(rawMetrics.recentGenerations)
      ? rawMetrics.recentGenerations.slice(0, RECENT_GENERATIONS_LIMIT)
      : [],
  };

  for (const mode of SUPPORTED_MODES) {
    const bucket = merged.byMode[mode];
    merged.byMode[mode] = {
      count: Number.isFinite(bucket?.count) ? Math.max(0, bucket.count) : 0,
      totalMs: Number.isFinite(bucket?.totalMs) ? Math.max(0, bucket.totalMs) : 0,
    };
  }

  merged.totalGenerations = Number.isFinite(merged.totalGenerations) ? Math.max(0, merged.totalGenerations) : 0;
  merged.successCount = Number.isFinite(merged.successCount) ? Math.max(0, merged.successCount) : 0;
  merged.failCount = Number.isFinite(merged.failCount) ? Math.max(0, merged.failCount) : 0;
  merged.nativeDarkModeCount = Number.isFinite(merged.nativeDarkModeCount) ? Math.max(0, merged.nativeDarkModeCount) : 0;
  return merged;
}

async function loadMetrics() {
  const data = await chrome.storage.local.get(METRICS_STORAGE_KEY);
  return mergeMetrics(data[METRICS_STORAGE_KEY]);
}

async function saveMetrics(metrics) {
  await chrome.storage.local.set({ [METRICS_STORAGE_KEY]: metrics });
}

let metricsWriteChain = Promise.resolve();

function enqueueMetricsUpdate(updateFn) {
  metricsWriteChain = metricsWriteChain.then(updateFn, updateFn);
  return metricsWriteChain;
}

function appendRecent(metrics, entry) {
  metrics.recentGenerations.unshift(entry);
  if (metrics.recentGenerations.length > RECENT_GENERATIONS_LIMIT) {
    metrics.recentGenerations = metrics.recentGenerations.slice(0, RECENT_GENERATIONS_LIMIT);
  }
}

function extractFailureDuration(error) {
  if (typeof error === 'object' && error && Number.isFinite(error.durationMs)) {
    return normalizeDurationMs(error.durationMs);
  }
  return 0;
}

export async function getMetrics() {
  return loadMetrics();
}

export async function clearMetrics() {
  return enqueueMetricsUpdate(async () => {
    const next = createDefaultMetrics();
    await saveMetrics(next);
    return next;
  });
}

export async function generationStarted(url, mode) {
  return enqueueMetricsUpdate(async () => {
    const normalizedMode = normalizeMode(mode);
    const metrics = await loadMetrics();

    metrics.totalGenerations += 1;
    metrics.byMode[normalizedMode].count += 1;

    await saveMetrics(metrics);
  });
}

export async function generationCompleted(url, mode, result = {}) {
  return enqueueMetricsUpdate(async () => {
    const normalizedMode = normalizeMode(mode);
    const metrics = await loadMetrics();
    const durationMs = normalizeDurationMs(result.durationMs);
    const providerKey = normalizeProvider(result.provider);

    metrics.successCount += 1;
    metrics.byMode[normalizedMode].totalMs += durationMs;

    if (result.usedNativeDarkCss) {
      metrics.nativeDarkModeCount += 1;
    }

    if (providerKey) {
      if (!metrics.byProvider[providerKey]) {
        metrics.byProvider[providerKey] = emptyBucket();
      }
      metrics.byProvider[providerKey].count += 1;
      metrics.byProvider[providerKey].totalMs += durationMs;
    }

    appendRecent(metrics, {
      url: normalizeRecentUrl(url),
      mode: normalizedMode,
      provider: result.provider || null,
      model: result.model || null,
      cssLength: Number.isFinite(result.cssLength) ? Math.max(0, Math.round(result.cssLength)) : 0,
      durationMs,
      turnsUsed: Number.isFinite(result.turnsUsed) ? Math.max(0, Math.round(result.turnsUsed)) : 0,
      success: true,
      timestamp: Date.now(),
    });

    await saveMetrics(metrics);
  });
}

export async function generationFailed(url, mode, error) {
  return enqueueMetricsUpdate(async () => {
    const normalizedMode = normalizeMode(mode);
    const metrics = await loadMetrics();
    const durationMs = extractFailureDuration(error);

    metrics.failCount += 1;
    metrics.byMode[normalizedMode].totalMs += durationMs;

    appendRecent(metrics, {
      url: normalizeRecentUrl(url),
      mode: normalizedMode,
      provider: null,
      model: null,
      cssLength: 0,
      durationMs,
      turnsUsed: 0,
      success: false,
      timestamp: Date.now(),
    });

    await saveMetrics(metrics);
  });
}

export {
  METRICS_STORAGE_KEY,
  RECENT_GENERATIONS_LIMIT,
  SUPPORTED_MODES,
  createDefaultMetrics,
};
