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

  function getSettings() {
    const area = chrome.storage && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
    return new Promise((resolve) => {
      area.get(DEFAULT_SETTINGS, (items) => {
        resolve(items || DEFAULT_SETTINGS);
      });
    });
  }

  getSettings();
})();
