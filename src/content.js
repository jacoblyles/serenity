(function () {
  "use strict";

  const STYLE_ID = "serenity-style";
  const CACHE_PREFIX = "serenity:settings:";
  const DETECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_SETTINGS = {
    globalEnabled: true,
    defaults: {
      brightness: 100,
      contrast: 100
    },
    sites: {},
    detections: {}
  };

  const origin = window.location.origin;
  let currentSettings = readCachedSettings();

  function storageArea() {
    if (chrome.storage && chrome.storage.sync) {
      return chrome.storage.sync;
    }

    return chrome.storage.local;
  }

  function detectionStorageArea() {
    return chrome.storage && chrome.storage.local ? chrome.storage.local : storageArea();
  }

  function readCachedSettings() {
    try {
      const cached = window.localStorage.getItem(CACHE_PREFIX + origin);
      return normalizeSettings(cached ? JSON.parse(cached) : DEFAULT_SETTINGS);
    } catch (error) {
      return DEFAULT_SETTINGS;
    }
  }

  function writeCachedSettings(settings) {
    try {
      window.localStorage.setItem(CACHE_PREFIX + origin, JSON.stringify(settings));
    } catch (error) {
      // Some sites deny localStorage access; async Chrome storage still works.
    }
  }

  function normalizeSettings(raw) {
    const settings = raw && typeof raw === "object" ? raw : {};
    const defaults = settings.defaults && typeof settings.defaults === "object" ? settings.defaults : {};
    const sites = settings.sites && typeof settings.sites === "object" ? settings.sites : {};
    const detections = settings.detections && typeof settings.detections === "object" ? settings.detections : {};

    return {
      globalEnabled: settings.globalEnabled !== false,
      defaults: {
        brightness: toPercent(defaults.brightness, DEFAULT_SETTINGS.defaults.brightness),
        contrast: toPercent(defaults.contrast, DEFAULT_SETTINGS.defaults.contrast)
      },
      sites,
      detections
    };
  }

  function toPercent(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getSiteConfig(settings) {
    return settings.sites[origin] || { mode: "auto" };
  }

  function hasFreshDarkDetection(settings) {
    const ts = Number(settings.detections[origin]);
    return Number.isFinite(ts) && Date.now() - ts < DETECTION_TTL_MS;
  }

  function getEffectiveConfig(settings) {
    const site = getSiteConfig(settings);
    return {
      mode: site.mode || "auto",
      brightness: toPercent(site.brightness, settings.defaults.brightness),
      contrast: toPercent(site.contrast, settings.defaults.contrast)
    };
  }

  function shouldApply(settings) {
    const site = getSiteConfig(settings);
    const mode = site.mode || "auto";
    return settings.globalEnabled !== false && mode !== "off" && !(mode === "auto" && hasFreshDarkDetection(settings));
  }

  function getSettings() {
    return new Promise((resolve) => {
      storageArea().get(DEFAULT_SETTINGS, (items) => {
        detectionStorageArea().get({ detections: {} }, (detectionItems) => {
          resolve(normalizeSettings(Object.assign({}, items, { detections: detectionItems.detections || {} })));
        });
      });
    });
  }

  function setSettings(settings) {
    return new Promise((resolve) => {
      const normalized = normalizeSettings(settings);
      storageArea().set(
        {
          globalEnabled: normalized.globalEnabled,
          defaults: normalized.defaults,
          sites: normalized.sites
        },
        () => {
          resolve(!chrome.runtime.lastError);
        }
      );
    });
  }

  function setDetection(originKey, ts) {
    return new Promise((resolve) => {
      detectionStorageArea().get({ detections: {} }, (items) => {
        const detections = items.detections && typeof items.detections === "object" ? items.detections : {};
        detections[originKey] = ts;
        detectionStorageArea().set({ detections }, () => {
          resolve(!chrome.runtime.lastError);
        });
      });
    });
  }

  function applyTheme(config) {
    const effective = Object.assign({ brightness: 100, contrast: 100 }, config || {});
    const style = getStyleElement();
    const brightness = toPercent(effective.brightness, 100) / 100;
    const contrast = toPercent(effective.contrast, 100) / 100;

    style.textContent = [
      "html {",
      `  filter: invert(1) hue-rotate(180deg) brightness(${brightness}) contrast(${contrast}) !important;`,
      "  background: #fff !important;",
      "}",
      "img, video, canvas, embed, object {",
      "  filter: invert(1) hue-rotate(180deg) !important;",
      "}",
      ":root {",
      "  color-scheme: dark !important;",
      "}"
    ].join("\n");
  }

  function removeTheme() {
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  function getStyleElement() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.documentElement || document).appendChild(style);
    }

    return style;
  }

  function refreshFromSettings(settings) {
    currentSettings = normalizeSettings(settings);
    writeCachedSettings(currentSettings);

    if (shouldApply(currentSettings)) {
      applyTheme(getEffectiveConfig(currentSettings));
    } else {
      removeTheme();
    }
  }

  async function refreshFromStorage() {
    refreshFromSettings(await getSettings());
  }

  function parseRgb(color) {
    const match = String(color).match(/rgba?\(([^)]+)\)/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(",").map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.some((part, index) => index < 3 && !Number.isFinite(part))) {
      return null;
    }

    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: Number.isFinite(parts[3]) ? parts[3] : 1
    };
  }

  function relativeLuminance(r, g, b) {
    const channels = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });

    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function effectiveBackgroundColor() {
    const style = document.getElementById(STYLE_ID);
    const wasDisabled = style ? style.disabled : false;

    if (style) {
      style.disabled = true;
    }

    try {
      const bodyColor = document.body ? parseRgb(getComputedStyle(document.body).backgroundColor) : null;
      if (bodyColor && bodyColor.a !== 0) {
        return bodyColor;
      }

      const htmlColor = document.documentElement ? parseRgb(getComputedStyle(document.documentElement).backgroundColor) : null;
      if (htmlColor && htmlColor.a !== 0) {
        return htmlColor;
      }

      return { r: 255, g: 255, b: 255, a: 1 };
    } finally {
      if (style) {
        style.disabled = wasDisabled;
      }
    }
  }

  function hasDarkColorSchemeMeta() {
    const meta = document.querySelector('meta[name="color-scheme" i]');
    const content = meta ? meta.getAttribute("content") || "" : "";
    return /\bdark\b/i.test(content) && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function isNativelyDark() {
    if (hasDarkColorSchemeMeta()) {
      return true;
    }

    const color = effectiveBackgroundColor();
    return relativeLuminance(color.r, color.g, color.b) < 0.35;
  }

  async function recordDetectedDark() {
    const settings = await getSettings();
    const site = getSiteConfig(settings);
    if ((site.mode || "auto") !== "auto") {
      return;
    }

    const ts = Date.now();
    settings.detections[origin] = ts;
    await setDetection(origin, ts);
    refreshFromSettings(settings);
  }

  function detectAndSkipIfNeeded() {
    const site = getSiteConfig(currentSettings);
    if ((site.mode || "auto") !== "auto") {
      return;
    }

    if (isNativelyDark()) {
      removeTheme();
      recordDetectedDark();
    }
  }

  function scheduleNativeDarkChecks() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", detectAndSkipIfNeeded, { once: true });
    } else {
      detectAndSkipIfNeeded();
    }

    window.addEventListener("load", detectAndSkipIfNeeded, { once: true });
  }

  window.Serenity = {
    applyTheme,
    removeTheme,
    relativeLuminance
  };

  if (shouldApply(currentSettings)) {
    applyTheme(getEffectiveConfig(currentSettings));
  }

  refreshFromStorage();

  chrome.storage.onChanged.addListener(() => {
    refreshFromStorage();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "serenity:update") {
      refreshFromStorage();
    }
  });

  scheduleNativeDarkChecks();
})();
