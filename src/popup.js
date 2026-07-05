(async function () {
  "use strict";

  const enabledToggle = document.getElementById("global-enabled");
  const siteStatus = document.getElementById("site-status");
  const settings = await window.SerenitySettings.getSettings();

  enabledToggle.checked = settings.globalEnabled;
  siteStatus.textContent = "Popup controls are being wired in the next task.";

  enabledToggle.addEventListener("change", async () => {
    settings.globalEnabled = enabledToggle.checked;
    await window.SerenitySettings.setSettings(settings);
  });
})();
