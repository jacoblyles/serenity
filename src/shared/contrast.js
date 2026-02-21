const NAMED_COLORS = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseHex(value) {
  if (!value.startsWith('#')) return null;
  const hex = value.slice(1);

  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1,
    };
  }

  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  if (/^[0-9a-f]{8}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16) / 255,
    };
  }

  return null;
}

function parseRgbChannel(token) {
  const t = token.trim();
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return clamp(Math.round((pct / 100) * 255), 0, 255);
  }
  const value = Number(t);
  if (!Number.isFinite(value)) return null;
  return clamp(Math.round(value), 0, 255);
}

function parseAlpha(token) {
  const t = token.trim();
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return clamp(pct / 100, 0, 1);
  }
  const value = Number(t);
  if (!Number.isFinite(value)) return null;
  return clamp(value, 0, 1);
}

function parseRgb(value) {
  const match = value.match(/^rgba?\((.*)\)$/i);
  if (!match) return null;

  const inner = match[1].trim();
  let channels;
  let alpha = 1;

  if (inner.includes('/')) {
    const [colorPart, alphaPart] = inner.split('/');
    channels = colorPart.trim().split(/\s+/);
    alpha = parseAlpha(alphaPart);
    if (alpha === null) return null;
  } else {
    const commaParts = inner.split(',').map((part) => part.trim());
    if (commaParts.length === 4) {
      channels = commaParts.slice(0, 3);
      alpha = parseAlpha(commaParts[3]);
      if (alpha === null) return null;
    } else if (commaParts.length === 3) {
      channels = commaParts;
    } else {
      channels = inner.split(/\s+/);
    }
  }

  if (!channels || channels.length !== 3) return null;

  const r = parseRgbChannel(channels[0]);
  const g = parseRgbChannel(channels[1]);
  const b = parseRgbChannel(channels[2]);

  if (r === null || g === null || b === null) return null;

  return { r, g, b, a: alpha };
}

export function parseColor(str) {
  if (typeof str !== 'string') {
    throw new TypeError('Color must be a string');
  }

  const value = str.trim().toLowerCase();

  const named = NAMED_COLORS[value];
  if (named) return { ...named };

  const hex = parseHex(value);
  if (hex) return hex;

  const rgb = parseRgb(value);
  if (rgb) return rgb;

  throw new Error(`Unsupported color format: ${str}`);
}

function srgbToLinear(channel255) {
  const c = channel255 / 255;
  if (c <= 0.03928) {
    return c / 12.92;
  }
  return ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(r, g, b) {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function composite(over, under) {
  const a = over.a + under.a * (1 - over.a);
  if (a <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  return {
    r: (over.r * over.a + under.r * under.a * (1 - over.a)) / a,
    g: (over.g * over.a + under.g * under.a * (1 - over.a)) / a,
    b: (over.b * over.a + under.b * under.a * (1 - over.a)) / a,
    a,
  };
}

function contrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function checkContrast(foreground, background) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const white = { r: 255, g: 255, b: 255, a: 1 };

  const resolvedBg = bg.a < 1 ? composite(bg, white) : bg;
  const resolvedFg = fg.a < 1 ? composite(fg, resolvedBg) : fg;

  const fgL = relativeLuminance(resolvedFg.r, resolvedFg.g, resolvedFg.b);
  const bgL = relativeLuminance(resolvedBg.r, resolvedBg.g, resolvedBg.b);
  const ratio = contrastRatio(fgL, bgL);

  return {
    ratio,
    aa: ratio >= 4.5,
    aaa: ratio >= 7,
    aaLarge: ratio >= 3,
    aaaLarge: ratio >= 4.5,
  };
}
