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
    'detect-dark-mode': () => detectExistingDarkMode(),
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

function parseLuminance(bgColor) {
  if (!bgColor || bgColor === 'transparent' || bgColor === 'rgba(0, 0, 0, 0)') return null;
  const match = bgColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  const [r, g, b] = [+match[1] / 255, +match[2] / 255, +match[3] / 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
