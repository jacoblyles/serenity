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
    'extract-dom': () => extractDOM(),
    'extract-custom-properties': () => extractCustomProperties(),
    'detect-dark-mode': () => detectExistingDarkMode(),
    'extract-dark-mode-rules': () => ({ css: extractPrefersDarkModeCss() }),
  };

  const handler = handlers[message.type];
  if (handler) {
    sendResponse(handler(message));
  }
});

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
