(function () {
  "use strict";

  const STYLE_ID = "serenity-style";
  const CACHE_PREFIX = "serenity:settings:";
  const DEFAULT_SETTINGS = {
    globalEnabled: true,
    defaults: {
      brightness: 100,
      contrast: 100
    },
    sites: {}
  };

  const origin = window.location.origin;
  let currentSettings = readCachedSettings();

  function storageArea() {
    if (chrome.storage && chrome.storage.sync) {
      return chrome.storage.sync;
    }

    return chrome.storage.local;
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

    return {
      globalEnabled: settings.globalEnabled !== false,
      defaults: {
        brightness: toPercent(defaults.brightness, DEFAULT_SETTINGS.defaults.brightness),
        contrast: toPercent(defaults.contrast, DEFAULT_SETTINGS.defaults.contrast)
      },
      sites
    };
  }

  function toPercent(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getSiteConfig(settings) {
    return settings.sites[origin] || { mode: "auto" };
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
    return settings.globalEnabled !== false && site.mode !== "off";
  }

  function getSettings() {
    return new Promise((resolve) => {
      storageArea().get(DEFAULT_SETTINGS, (items) => {
        resolve(normalizeSettings(items));
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
      "img, picture, video, canvas, embed, object {",
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

  window.Serenity = {
    applyTheme,
    removeTheme
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
})();
