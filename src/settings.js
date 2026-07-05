(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    globalEnabled: true,
    defaults: {
      brightness: 100,
      contrast: 100
    },
    sites: {}
  };

  function storageArea() {
    if (chrome.storage && chrome.storage.sync) {
      return chrome.storage.sync;
    }

    return chrome.storage.local;
  }

  function toPercent(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function mergeSettings(raw) {
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

  function getSettings() {
    return new Promise((resolve) => {
      storageArea().get(DEFAULT_SETTINGS, (items) => {
        resolve(mergeSettings(items));
      });
    });
  }

  async function setSettings(settings) {
    const merged = mergeSettings(settings);

    return new Promise((resolve) => {
      storageArea().set(merged, resolve);
    });
  }

  async function getSiteConfig(origin) {
    const settings = await getSettings();
    return settings.sites[origin] || { mode: "auto" };
  }

  async function setSiteConfig(origin, patch) {
    const settings = await getSettings();
    const current = settings.sites[origin] || { mode: "auto" };
    settings.sites[origin] = Object.assign({}, current, patch);
    Object.keys(settings.sites[origin]).forEach((key) => {
      if (settings.sites[origin][key] === undefined) {
        delete settings.sites[origin][key];
      }
    });
    await setSettings(settings);
    return settings.sites[origin];
  }

  window.SerenitySettings = {
    DEFAULT_SETTINGS,
    getSettings,
    getSiteConfig,
    setSiteConfig,
    setSettings
  };
})();
