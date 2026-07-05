(async function () {
  "use strict";

  const DETECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const enabledToggle = document.getElementById("global-enabled");
  const originText = document.getElementById("origin");
  const statusText = document.getElementById("status");
  const siteControls = document.getElementById("site-controls");
  const modeInputs = Array.from(document.querySelectorAll('input[name="site-mode"]'));
  const brightness = document.getElementById("brightness");
  const brightnessValue = document.getElementById("brightness-value");
  const contrast = document.getElementById("contrast");
  const contrastValue = document.getElementById("contrast-value");
  const reset = document.getElementById("reset");

  let activeTab = null;
  let activeOrigin = null;
  let settings = await window.SerenitySettings.getSettings();

  enabledToggle.checked = settings.globalEnabled;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    activeOrigin = getHttpOrigin(activeTab && activeTab.url);
  } catch (error) {
    activeTab = null;
  }

  if (!activeOrigin) {
    originText.textContent = "Unsupported page";
    statusText.textContent = "Site controls are unavailable on browser, file, and Web Store pages.";
    siteControls.disabled = true;
    bindGlobalToggle();
    return;
  }

  originText.textContent = activeOrigin;
  render();
  bindGlobalToggle();
  bindSiteControls();

  function getHttpOrigin(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
    } catch (error) {
      return null;
    }
  }

  function siteConfig() {
    return settings.sites[activeOrigin] || { mode: "auto" };
  }

  function effectiveValue(key) {
    const site = siteConfig();
    return Number.isFinite(Number(site[key])) ? Number(site[key]) : settings.defaults[key];
  }

  function hasFreshDarkDetection(site) {
    const detected = site.detectedDark;
    return Boolean(
      detected &&
        detected.value === true &&
        Number.isFinite(detected.ts) &&
        Date.now() - detected.ts < DETECTION_TTL_MS
    );
  }

  function statusLabel(site) {
    if (site.mode === "off") {
      return "Off";
    }

    if (site.mode === "on") {
      return "Forced on";
    }

    if (hasFreshDarkDetection(site)) {
      return "Skipped - site is already dark";
    }

    return "On - auto";
  }

  function render() {
    const site = siteConfig();
    const mode = site.mode || "auto";

    statusText.textContent = statusLabel(site);
    modeInputs.forEach((input) => {
      input.checked = input.value === mode;
    });

    brightness.value = String(effectiveValue("brightness"));
    contrast.value = String(effectiveValue("contrast"));
    brightnessValue.textContent = `${brightness.value}%`;
    contrastValue.textContent = `${contrast.value}%`;
  }

  function bindGlobalToggle() {
    enabledToggle.addEventListener("change", async () => {
      settings.globalEnabled = enabledToggle.checked;
      await window.SerenitySettings.setSettings(settings);
      await notifyTab();
      render();
    });
  }

  function bindSiteControls() {
    modeInputs.forEach((input) => {
      input.addEventListener("change", async () => {
        if (!input.checked) {
          return;
        }

        await updateSite({ mode: input.value });
      });
    });

    brightness.addEventListener("input", () => {
      brightnessValue.textContent = `${brightness.value}%`;
    });
    brightness.addEventListener("change", () => updateSite({ brightness: Number(brightness.value) }));

    contrast.addEventListener("input", () => {
      contrastValue.textContent = `${contrast.value}%`;
    });
    contrast.addEventListener("change", () => updateSite({ contrast: Number(contrast.value) }));

    reset.addEventListener("click", () => {
      updateSite({
        brightness: undefined,
        contrast: undefined
      });
    });
  }

  async function updateSite(patch) {
    await window.SerenitySettings.setSiteConfig(activeOrigin, patch);
    settings = await window.SerenitySettings.getSettings();
    await notifyTab();
    render();
  }

  async function notifyTab() {
    if (!activeTab || !activeTab.id) {
      return;
    }

    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: "serenity:update" });
    } catch (error) {
      // Tabs opened before install or unsupported pages may not have the content script.
    }
  }
})();
