(function () {
  "use strict";

  const STYLE_ID = "serenity-style";
  const CACHE_PREFIX = "serenity:settings:";
  const DETECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const APP_CANVAS_VIEWPORT_RATIO = 0.3;
  const APP_CANVAS_SCAN_DELAY_MS = 250;
  const APP_CANVAS_ATTRIBUTE = "data-serenity-app-canvas";
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
  let appCanvasObserver = null;
  let appCanvasScanTimer = 0;
  let appCanvasTrackingActive = false;

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
      "canvas[data-serenity-app-canvas] {",
      "  filter: none !important;",
      "}",
      ":root {",
      "  color-scheme: dark !important;",
      "}"
    ].join("\n");

    startAppCanvasTracking();
    tagAppCanvasesIfReady();
  }

  function removeTheme() {
    stopAppCanvasTracking();

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

  function tagAppCanvasesIfReady() {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      tagAppCanvases();
    }
  }

  function tagAppCanvases() {
    const viewportArea = window.innerWidth * window.innerHeight;
    const threshold = APP_CANVAS_VIEWPORT_RATIO * viewportArea;

    document.querySelectorAll("canvas").forEach((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const canvasArea = rect.width * rect.height;

      if (viewportArea > 0 && rect.width > 0 && rect.height > 0 && canvasArea >= threshold) {
        canvas.setAttribute(APP_CANVAS_ATTRIBUTE, "");
      } else {
        canvas.removeAttribute(APP_CANVAS_ATTRIBUTE);
      }
    });
  }

  function startAppCanvasTracking() {
    if (!appCanvasTrackingActive) {
      appCanvasTrackingActive = true;
      document.addEventListener("DOMContentLoaded", tagAppCanvases);
      window.addEventListener("load", tagAppCanvases);
      window.addEventListener("resize", scheduleAppCanvasScan);
      connectAppCanvasObserver();
    }
  }

  function stopAppCanvasTracking() {
    if (!appCanvasTrackingActive) {
      return;
    }

    appCanvasTrackingActive = false;
    document.removeEventListener("DOMContentLoaded", tagAppCanvases);
    window.removeEventListener("load", tagAppCanvases);
    window.removeEventListener("resize", scheduleAppCanvasScan);

    if (appCanvasObserver) {
      appCanvasObserver.disconnect();
      appCanvasObserver = null;
    }

    if (appCanvasScanTimer) {
      window.clearTimeout(appCanvasScanTimer);
      appCanvasScanTimer = 0;
    }
  }

  function connectAppCanvasObserver() {
    if (appCanvasObserver || !document.documentElement) {
      return;
    }

    appCanvasObserver = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => Array.prototype.some.call(mutation.addedNodes, nodeContainsCanvas))) {
        scheduleAppCanvasScan();
      }
    });

    appCanvasObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function nodeContainsCanvas(node) {
    if (!node || (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) {
      return false;
    }

    return node.localName === "canvas" || Boolean(node.querySelector && node.querySelector("canvas"));
  }

  function scheduleAppCanvasScan() {
    if (!appCanvasTrackingActive || appCanvasScanTimer) {
      return;
    }

    appCanvasScanTimer = window.setTimeout(() => {
      appCanvasScanTimer = 0;

      if (appCanvasTrackingActive) {
        tagAppCanvases();
      }
    }, APP_CANVAS_SCAN_DELAY_MS);
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

  function parseColor(color) {
    const value = String(color).trim();
    const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
    if (rgbMatch) {
      return parseRgbChannels(rgbMatch[1]);
    }

    const colorMatch = value.match(/^color\((srgb|display-p3)\s+([^)]+)\)$/i);
    if (colorMatch) {
      return parseColorFunctionChannels(colorMatch[2]);
    }

    return null;
  }

  function parseRgbChannels(value) {
    if (value.includes(",")) {
      const parts = value.split(",").map((part) => Number(part.trim()));
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

    const parts = splitModernColorChannels(value);
    if (!parts || parts.rgb.some((part) => !Number.isFinite(part))) {
      return null;
    }

    return {
      r: parts.rgb[0],
      g: parts.rgb[1],
      b: parts.rgb[2],
      a: Number.isFinite(parts.alpha) ? parts.alpha : 1
    };
  }

  function parseColorFunctionChannels(value) {
    const parts = splitModernColorChannels(value);
    if (!parts || parts.rgb.some((part) => !Number.isFinite(part))) {
      return null;
    }

    return {
      r: parts.rgb[0] * 255,
      g: parts.rgb[1] * 255,
      b: parts.rgb[2] * 255,
      a: Number.isFinite(parts.alpha) ? parts.alpha : 1
    };
  }

  function splitModernColorChannels(value) {
    const parts = value.trim().replace(/\s*\/\s*/g, " ").split(/\s+/).map((part) => Number(part));
    if (parts.length < 3 || parts.length > 4) {
      return null;
    }

    return {
      rgb: parts.slice(0, 3),
      alpha: parts[3]
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
      const bodyColor = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
      if (bodyColor && bodyColor.a !== 0) {
        return bodyColor;
      }

      const htmlColor = document.documentElement ? parseColor(getComputedStyle(document.documentElement).backgroundColor) : null;
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
    const content = (meta ? meta.getAttribute("content") || "" : "").trim().toLowerCase();
    return (content === "dark" || content === "only dark") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
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
