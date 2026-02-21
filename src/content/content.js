// Serenity content script
// Injected into all pages; handles style extraction and CSS injection

const STYLE_ELEMENT_ID = 'serenity-styles';
const MAX_NODES = 900;
const MAX_DEPTH = 8;
const MAX_CHILDREN_PER_NODE = 35;
const MAX_TEXT_LENGTH = 180;
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'META',
  'LINK',
  'TITLE',
  'BASE',
]);
const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON']);
const STYLE_PROPERTIES = [
  'display',
  'position',
  'zIndex',
  'color',
  'backgroundColor',
  'backgroundImage',
  'opacity',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'lineHeight',
  'textAlign',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxShadow',
  'outlineColor',
  'outlineStyle',
  'outlineWidth',
  'caretColor',
  'textDecorationColor',
];
const MAX_COLOR_MAP_ENTRIES = 200;
const MAX_COLOR_MAP_SELECTORS_PER_ENTRY = 4;

function injectCSS(css) {
  let el = document.getElementById(STYLE_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function removeCSS() {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.remove();
}

function getInjectedCSS() {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  return el?.textContent || '';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'apply-css': (msg) => { injectCSS(msg.css); return { applied: true }; },
    'remove-css': () => { removeCSS(); return { removed: true }; },
    'get-applied-css': () => ({ css: getInjectedCSS() }),
    'wait-for-paint': () => waitForPaint(),
    'scroll-to': (msg) => scrollToY(msg.y),
    'inspect-elements': (msg) => inspectElements(msg),
    'extract-page-context': () => extractDOM(),
    'extract-dom': () => extractDOM(),
    'extract-custom-properties': () => extractCustomProperties(),
    'extract-color-map': () => extractColorMap(),
    'detect-dark-mode': () => detectExistingDarkMode(),
    'extract-dark-mode-rules': () => ({ css: extractPrefersDarkModeCss() }),
    'extract-layout-summary': () => extractLayoutSummary(),
  };

  const handler = handlers[message.type];
  if (handler) {
    Promise.resolve()
      .then(() => handler(message))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }));
    return true;
  }
});

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(() => resolve({ ok: true }), 150);
    });
  });
}

function scrollToY(y) {
  const targetY = Number.isFinite(Number(y)) ? Number(y) : 0;
  window.scrollTo(0, targetY);
  return waitForPaint().then(() => ({ ok: true, y: targetY }));
}

function inspectElements(message) {
  const selector = typeof message?.selector === 'string' ? message.selector.trim() : '';
  if (!selector) return [];

  const parsedLimit = Number(message?.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), 100)
    : 10;

  let matches = [];
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch (_error) {
    return [];
  }

  return matches.slice(0, limit).map((el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      selector: buildCompactSelector(el),
      tagName: el.tagName,
      computedStyles: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        display: style.display,
        position: style.position,
        visibility: style.visibility,
        opacity: style.opacity,
        borderColor: style.borderColor,
      },
      boundingRect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
}

function extractDOM() {
  const result = {
    url: location.href,
    hostname: location.hostname,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    rootTag: '',
    dom: null,
    truncated: false,
    nodeCount: 0,
  };

  let nodeCount = 0;

  function normalizeText(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }

  function getVisibleText(el) {
    if (FORM_TAGS.has(el.tagName)) return null;

    const text = normalizeText(el.innerText || '');
    if (!text) return null;
    return truncateText(text, MAX_TEXT_LENGTH);
  }

  function sanitizeUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const parsed = new URL(rawUrl, location.href);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_err) {
      return null;
    }
  }

  function getSafeAttributes(el) {
    const attrs = {};
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const ariaHidden = el.getAttribute('aria-hidden');
    const alt = el.getAttribute('alt');
    const title = el.getAttribute('title');
    const type = el.getAttribute('type');
    const placeholder = el.getAttribute('placeholder');
    const href = el.getAttribute('href');
    const src = el.getAttribute('src');

    if (role) attrs.role = role;
    if (ariaLabel) attrs.ariaLabel = truncateText(ariaLabel, MAX_TEXT_LENGTH);
    if (ariaHidden) attrs.ariaHidden = ariaHidden;
    if (alt) attrs.alt = truncateText(alt, MAX_TEXT_LENGTH);
    if (title) attrs.title = truncateText(title, MAX_TEXT_LENGTH);
    if (type) attrs.type = type;
    if (placeholder) attrs.placeholder = truncateText(placeholder, MAX_TEXT_LENGTH);
    if (href) attrs.href = sanitizeUrl(href);
    if (src) attrs.src = sanitizeUrl(src);

    return attrs;
  }

  function getStyles(el) {
    const computed = window.getComputedStyle(el);
    const styles = {};
    for (const prop of STYLE_PROPERTIES) {
      styles[prop] = computed[prop];
    }
    return styles;
  }

  function extractElement(el, depth) {
    if (nodeCount >= MAX_NODES) {
      result.truncated = true;
      return null;
    }
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      return null;
    }
    if (SKIP_TAGS.has(el.tagName)) {
      return null;
    }

    nodeCount += 1;

    const rect = el.getBoundingClientRect();
    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classList: Array.from(el.classList).slice(0, 8),
      attributes: getSafeAttributes(el),
      text: getVisibleText(el),
      formControl: FORM_TAGS.has(el.tagName),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles: getStyles(el),
      children: [],
    };

    const children = Array.from(el.children).slice(0, MAX_CHILDREN_PER_NODE);
    if (el.children.length > children.length) {
      result.truncated = true;
    }

    for (const child of children) {
      const childNode = extractElement(child, depth + 1);
      if (childNode) {
        node.children.push(childNode);
      }
      if (nodeCount >= MAX_NODES) {
        result.truncated = true;
        break;
      }
    }

    return node;
  }

  const rootEl = document.body || document.documentElement;
  result.rootTag = rootEl.tagName.toLowerCase();
  result.dom = extractElement(rootEl, 0);
  result.nodeCount = nodeCount;

  return {
    ...result,
  };
}

function extractCustomProperties() {
  const properties = new Map();
  const rootComputed = getComputedStyle(document.documentElement);

  for (let i = 0; i < rootComputed.length; i += 1) {
    const propertyName = rootComputed[i];
    if (!propertyName || !propertyName.startsWith('--')) continue;
    const value = rootComputed.getPropertyValue(propertyName).trim();
    if (!value) continue;
    properties.set(propertyName, value);
  }

  for (const [name, value] of getRootRuleCustomPropertiesFromStylesheets()) {
    if (!properties.has(name) && value) {
      properties.set(name, value);
    }
  }

  const grouped = groupCustomProperties(properties);

  return {
    properties: Object.fromEntries(properties),
    grouped,
  };
}

function getRootRuleCustomPropertiesFromStylesheets() {
  const collected = new Map();
  const visited = new Set();

  function collectFromRules(rules) {
    if (!rules) return;
    for (const rule of rules) {
      if (!rule) continue;
      if (rule.type === CSSRule.STYLE_RULE) {
        const selector = rule.selectorText || '';
        if (selectorTargetsRoot(selector)) {
          for (let i = 0; i < rule.style.length; i += 1) {
            const name = rule.style[i];
            if (!name || !name.startsWith('--')) continue;
            const value = rule.style.getPropertyValue(name).trim();
            if (value && !collected.has(name)) {
              collected.set(name, value);
            }
          }
        }
        continue;
      }

      if (
        rule.type === CSSRule.MEDIA_RULE
        || rule.type === CSSRule.SUPPORTS_RULE
      ) {
        collectFromRules(rule.cssRules);
        continue;
      }

      if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
        collectFromSheet(rule.styleSheet);
      }
    }
  }

  function collectFromSheet(sheet) {
    if (!sheet || visited.has(sheet)) return;
    visited.add(sheet);
    try {
      collectFromRules(sheet.cssRules || sheet.rules);
    } catch {
      // Ignore cross-origin or restricted stylesheets.
    }
  }

  for (const sheet of document.styleSheets) {
    collectFromSheet(sheet);
  }

  return collected;
}

function selectorTargetsRoot(selectorText) {
  if (!selectorText) return false;
  const selectors = selectorText
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean);
  return selectors.some((selector) => /(^|[\s>+~])(:root|html)\b/.test(selector));
}

function groupCustomProperties(properties) {
  const grouped = {
    backgrounds: new Set(),
    text: new Set(),
    accents: new Set(),
    borders: new Set(),
  };

  for (const [name, value] of properties.entries()) {
    const lowerName = name.toLowerCase();
    const colorInfo = parseColorInfo(value);
    const isLight = colorInfo && colorInfo.alpha > 0 && colorInfo.luminance >= 0.72;
    const isDark = colorInfo && colorInfo.alpha > 0 && colorInfo.luminance <= 0.38;

    if (
      /(?:^|[-_])(bg|background|surface|base)(?:[-_]|$)/.test(lowerName)
      || isLight
    ) {
      grouped.backgrounds.add(name);
    }

    if (
      /(?:^|[-_])(accent|primary|secondary|link|brand)(?:[-_]|$)/.test(lowerName)
    ) {
      grouped.accents.add(name);
    }

    if (
      /(?:^|[-_])(border|divider|separator)(?:[-_]|$)/.test(lowerName)
    ) {
      grouped.borders.add(name);
    }

    const containsColorKeyword = lowerName.includes('color');
    const isBackgroundColorName = lowerName.includes('background-color');
    if (
      /(?:^|[-_])(text|foreground|fg)(?:[-_]|$)/.test(lowerName)
      || ((containsColorKeyword && !isBackgroundColorName) && isDark)
    ) {
      grouped.text.add(name);
    }
  }

  return {
    backgrounds: Array.from(grouped.backgrounds),
    text: Array.from(grouped.text),
    accents: Array.from(grouped.accents),
    borders: Array.from(grouped.borders),
  };
}

function parseColorInfo(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') return null;

  const hexMatch = trimmed.match(/^#([0-9a-f]{3,8})\b/i);
  if (hexMatch) {
    return parseHexColor(hexMatch[1]);
  }

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((part) => part.trim());
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]);
    if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return null;
    const luminance = computeLuminance(r, g, b);
    return { luminance, alpha };
  }

  return null;
}

function parseHexColor(hex) {
  const normalized = hex.toLowerCase();
  if (![3, 4, 6, 8].includes(normalized.length)) return null;

  const expanded = normalized.length <= 4
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized;
  const hasAlpha = expanded.length === 8;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  const alpha = hasAlpha ? parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return null;
  const luminance = computeLuminance(r, g, b);
  return { luminance, alpha };
}

function computeLuminance(r255, g255, b255) {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function detectExistingDarkMode() {
  const signals = [];

  // Check <meta name="color-scheme">
  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) {
    const content = (colorSchemeMeta.getAttribute('content') || '').toLowerCase();
    if (content.includes('dark')) {
      signals.push('meta-color-scheme');
    }
  }

  // Check CSS color-scheme property on root
  const rootStyle = getComputedStyle(document.documentElement);
  if (rootStyle.colorScheme && rootStyle.colorScheme.includes('dark')) {
    signals.push('css-color-scheme');
  }

  // Check background luminance on html and body
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    const lum = parseLuminance(bg);
    if (lum !== null && lum < 0.2) {
      signals.push(el === document.documentElement ? 'html-dark-bg' : 'body-dark-bg');
    }
  }

  // Check common dark-mode class names on html/body
  const darkClassPattern = /\b(dark|dark[-_]mode|dark[-_]theme|theme[-_]dark|night)\b/i;
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    if (darkClassPattern.test(el.className)) {
      signals.push('dark-class');
      break;
    }
    if (el.dataset.theme && /dark|night/i.test(el.dataset.theme)) {
      signals.push('data-theme-dark');
      break;
    }
  }

  // Check for prefers-color-scheme: dark rules in stylesheets
  try {
    for (const sheet of document.styleSheets) {
      if (hasDarkMediaRule(sheet)) {
        signals.push('media-prefers-dark');
        break;
      }
    }
  } catch {
    // Cross-origin stylesheets can't be inspected
  }

  const isDark = signals.length >= 2 || signals.includes('body-dark-bg') || signals.includes('html-dark-bg');
  return { isDark, signals };
}

function hasDarkMediaRule(sheet) {
  let rules;
  try { rules = sheet.cssRules || sheet.rules; } catch { return false; }
  if (!rules) return false;

  for (const rule of rules) {
    if (rule.type === CSSRule.MEDIA_RULE && /prefers-color-scheme\s*:\s*dark/.test(rule.conditionText)) {
      if (rule.cssRules && rule.cssRules.length > 0) return true;
    }
  }
  return false;
}

function extractPrefersDarkModeCss() {
  const extractedRules = [];

  function walkRules(ruleList) {
    if (!ruleList) return;

    for (const rule of ruleList) {
      if (rule.type === CSSRule.MEDIA_RULE && isPrefersDarkMediaRule(rule)) {
        if (rule.cssRules && rule.cssRules.length > 0) {
          extractedRules.push(cssRuleListToText(rule.cssRules));
        }
        continue;
      }

      if ('cssRules' in rule && rule.cssRules?.length) {
        walkRules(rule.cssRules);
      }
    }
  }

  for (const sheet of document.styleSheets) {
    try {
      walkRules(sheet.cssRules || sheet.rules);
    } catch {
      // Cross-origin stylesheets cannot be read.
    }
  }

  return extractedRules.filter(Boolean).join('\n\n').trim();
}

function isPrefersDarkMediaRule(rule) {
  const conditionText = String(rule.conditionText || '');
  if (/prefers-color-scheme\s*:\s*dark/i.test(conditionText)) return true;
  return Boolean(rule.media?.mediaText && /prefers-color-scheme\s*:\s*dark/i.test(rule.media.mediaText));
}

function cssRuleListToText(ruleList) {
  return Array.from(ruleList)
    .map((cssRule) => cssRule.cssText)
    .filter(Boolean)
    .join('\n');
}

function parseLuminance(bgColor) {
  if (!bgColor || bgColor === 'transparent' || bgColor === 'rgba(0, 0, 0, 0)') return null;
  const match = bgColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  const [r, g, b] = [+match[1] / 255, +match[2] / 255, +match[3] / 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function extractColorMap() {
  const allElements = Array.from(document.querySelectorAll('*'));
  const profileMap = new Map();

  for (const el of allElements) {
    if (!isVisibleForColorMap(el)) continue;

    const style = window.getComputedStyle(el);
    const profile = {
      color: normalizeColorValue(style.color),
      bg: normalizeColorValue(style.backgroundColor),
      border: normalizeColorValue(style.borderColor),
      borderTop: normalizeColorValue(style.borderTopColor),
      borderBottom: normalizeColorValue(style.borderBottomColor),
      borderLeft: normalizeColorValue(style.borderLeftColor),
      borderRight: normalizeColorValue(style.borderRightColor),
      fill: normalizeColorValue(style.fill),
      stroke: normalizeColorValue(style.stroke),
    };

    const key = JSON.stringify(profile);
    const selector = buildCompactSelector(el);
    const existing = profileMap.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.selectors.size < MAX_COLOR_MAP_SELECTORS_PER_ENTRY) {
        existing.selectors.add(selector);
      }
      if (!existing.role || existing.role === 'content') {
        existing.role = classifyElementRole(el);
      }
    } else {
      profileMap.set(key, {
        profile,
        selectors: new Set([selector]),
        count: 1,
        role: classifyElementRole(el),
      });
    }
  }

  const sortedProfiles = Array.from(profileMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_COLOR_MAP_ENTRIES);

  const uniqueBackgrounds = new Set();
  const uniqueText = new Set();
  const uniqueBorders = new Set();

  const bgCounts = new Map();
  const textCounts = new Map();
  const borderCounts = new Map();

  const colorMap = sortedProfiles.map((entry) => {
    const selectors = Array.from(entry.selectors).sort();
    const item = {
      selector: selectors.join(', '),
      role: entry.role || 'content',
    };

    if (isMeaningfulColor(entry.profile.bg)) {
      item.bg = entry.profile.bg;
      uniqueBackgrounds.add(entry.profile.bg);
      bgCounts.set(entry.profile.bg, (bgCounts.get(entry.profile.bg) || 0) + entry.count);
      const bgInfo = parseColorInfo(entry.profile.bg);
      if (bgInfo) item.isLight = bgInfo.luminance > 0.5;
    }
    if (isMeaningfulColor(entry.profile.color)) {
      item.color = entry.profile.color;
      uniqueText.add(entry.profile.color);
      textCounts.set(entry.profile.color, (textCounts.get(entry.profile.color) || 0) + entry.count);
    }

    if (item.bg && item.color) {
      const cr = contrastRatio(item.color, item.bg);
      if (cr !== null) item.contrast = cr;
    }

    const borderValue = deriveBorderValue(entry.profile);
    if (borderValue) {
      item.border = borderValue;
      if (typeof borderValue === 'string') {
        uniqueBorders.add(borderValue);
        borderCounts.set(borderValue, (borderCounts.get(borderValue) || 0) + entry.count);
      } else {
        for (const value of Object.values(borderValue)) {
          if (isMeaningfulColor(value)) {
            uniqueBorders.add(value);
            borderCounts.set(value, (borderCounts.get(value) || 0) + entry.count);
          }
        }
      }
    }

    if (isMeaningfulColor(entry.profile.fill)) {
      item.fill = entry.profile.fill;
    }
    if (isMeaningfulColor(entry.profile.stroke)) {
      item.stroke = entry.profile.stroke;
    }

    return item;
  });

  function buildUniqueColorList(colorSet, countMap) {
    return Array.from(colorSet).map((color) => {
      const info = parseColorInfo(color);
      return {
        color,
        luminance: info ? Math.round(info.luminance * 100) / 100 : null,
        isLight: info ? info.luminance > 0.5 : null,
        count: countMap.get(color) || 0,
      };
    }).sort((a, b) => b.count - a.count);
  }

  return {
    colorMap,
    uniqueColors: {
      backgrounds: buildUniqueColorList(uniqueBackgrounds, bgCounts),
      text: buildUniqueColorList(uniqueText, textCounts),
      borders: buildUniqueColorList(uniqueBorders, borderCounts),
    },
  };
}

function isVisibleForColorMap(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (SKIP_TAGS.has(el.tagName)) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;

  return true;
}

function normalizeColorValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isMeaningfulColor(value) {
  if (typeof value !== 'string') return false;
  if (!value) return false;
  if (value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return false;
  if (value === 'initial' || value === 'inherit' || value === 'unset') return false;
  if (value === 'none') return false;
  return true;
}

function deriveBorderValue(profile) {
  const sides = {
    top: profile.borderTop,
    right: profile.borderRight,
    bottom: profile.borderBottom,
    left: profile.borderLeft,
  };
  const sideValues = Object.values(sides).filter(isMeaningfulColor);
  if (!sideValues.length && isMeaningfulColor(profile.border)) {
    return profile.border;
  }
  if (!sideValues.length) return null;

  const uniqueSideValues = new Set(sideValues);
  if (uniqueSideValues.size === 1) {
    return sideValues[0];
  }

  const sideMap = {};
  for (const [side, value] of Object.entries(sides)) {
    if (isMeaningfulColor(value)) sideMap[side] = value;
  }
  return Object.keys(sideMap).length ? sideMap : null;
}

function buildCompactSelector(el) {
  const tag = el.tagName.toLowerCase();
  const safeEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
  };

  if (el.id) {
    return `${tag}#${safeEscape(el.id)}`;
  }

  const classes = Array.from(el.classList)
    .filter(Boolean)
    .slice(0, 2)
    .map((cls) => `.${safeEscape(cls)}`);
  if (classes.length) {
    return `${tag}${classes.join('')}`;
  }

  return buildShortCssPath(el, safeEscape);
}

function extractLayoutSummary() {
  const totalElements = document.querySelectorAll('*').length;
  const regions = [];
  const regionSelectors = [
    ['header', 'header, [role="banner"]'],
    ['nav', 'nav, [role="navigation"]'],
    ['main', 'main, [role="main"]'],
    ['sidebar', 'aside, [role="complementary"], [class*="sidebar"], [class*="side-bar"]'],
    ['footer', 'footer, [role="contentinfo"]'],
    ['comments', '[class*="comment"], [class*="reply"], [class*="thread"], [id*="comment"]'],
  ];
  for (const [name, selector] of regionSelectors) {
    try {
      if (document.querySelector(selector)) regions.push(name);
    } catch { /* invalid selector */ }
  }

  const commentPatterns = [
    '[class*="comment"]', '[class*="reply"]', '[class*="thread"]',
    '.comment', '.reply', '.post', '.message',
  ];
  let hasNestedComments = false;
  for (const pattern of commentPatterns) {
    try {
      const els = document.querySelectorAll(pattern);
      for (const el of els) {
        if (el.querySelector(pattern)) { hasNestedComments = true; break; }
      }
    } catch { /* skip */ }
    if (hasNestedComments) break;
  }

  let nestingDepth = 0;
  const mainContent = document.querySelector('main, [role="main"]') || document.body;
  if (mainContent) {
    function measureDepth(el, depth) {
      if (depth > nestingDepth) nestingDepth = depth;
      if (depth >= 20) return;
      for (const child of el.children) {
        if (!SKIP_TAGS.has(child.tagName)) measureDepth(child, depth + 1);
      }
    }
    measureDepth(mainContent, 0);
  }

  const hasSidebar = regions.includes('sidebar');
  const hasCodeBlocks = Boolean(document.querySelector('pre code, .highlight, .codehilite'));
  const hasForms = Boolean(document.querySelector('form, input[type="text"], textarea'));

  const classCounts = new Map();
  const contentTags = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'TR']);
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    if (!contentTags.has(el.tagName)) continue;
    for (const cls of el.classList) {
      if (!cls || cls.length > 40) continue;
      const key = `${el.tagName.toLowerCase()}.${cls}`;
      classCounts.set(key, (classCounts.get(key) || 0) + 1);
    }
  }
  const contentSelectors = Array.from(classCounts.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([selector]) => selector);

  let layoutType = 'generic';
  if (hasNestedComments || regions.includes('comments')) {
    layoutType = 'forum';
  } else {
    const articles = document.querySelectorAll('article, [class*="post-body"], [class*="article-body"]');
    if (articles.length === 1) {
      const text = articles[0].textContent || '';
      if (text.length > 500) layoutType = 'article';
    }
  }

  return {
    layoutType,
    regions,
    nestingDepth: Math.min(nestingDepth, 20),
    hasNestedComments,
    hasSidebar,
    hasCodeBlocks,
    hasForms,
    contentSelectors,
    totalElements,
  };
}

const CHROME_TAGS = new Set(['HEADER', 'NAV', 'FOOTER']);
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL']);

function classifyElementRole(el) {
  const tag = el.tagName;
  if (CHROME_TAGS.has(tag)) return 'chrome';
  if (INTERACTIVE_TAGS.has(tag)) return 'interactive';

  const role = el.getAttribute('role') || '';
  if (['banner', 'navigation', 'contentinfo'].includes(role)) return 'chrome';
  if (['button', 'link', 'textbox', 'searchbox', 'combobox'].includes(role)) return 'interactive';

  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    if (CHROME_TAGS.has(parent.tagName)) return 'chrome';
    const parentRole = parent.getAttribute('role') || '';
    if (['banner', 'navigation', 'contentinfo'].includes(parentRole)) return 'chrome';
    parent = parent.parentElement;
  }

  return 'content';
}

function contrastRatio(fgColor, bgColor) {
  const fgInfo = parseColorInfo(fgColor);
  const bgInfo = parseColorInfo(bgColor);
  if (!fgInfo || !bgInfo) return null;
  const l1 = Math.max(fgInfo.luminance, bgInfo.luminance);
  const l2 = Math.min(fgInfo.luminance, bgInfo.luminance);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10;
}

function buildShortCssPath(el, escapeFn) {
  const parts = [];
  let current = el;
  let depth = 0;

  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 3) {
    const tag = current.tagName.toLowerCase();
    let part = tag;

    if (current.id) {
      part = `${tag}#${escapeFn(current.id)}`;
      parts.unshift(part);
      break;
    }

    const cls = Array.from(current.classList).find(Boolean);
    if (cls) {
      part = `${tag}.${escapeFn(cls)}`;
    } else if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children)
        .filter((child) => child.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part = `${tag}:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    current = current.parentElement;
    depth += 1;
  }

  return parts.join(' > ');
}
