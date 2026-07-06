# Serenity

A Chrome extension that automatically gives websites a night mode when they don't have one.

Serenity is local, deterministic, and dependency-free: no LLM, no network calls, no build
step, no cached stylesheets to go stale. Pages darken instantly on load, sites that already
ship their own dark theme are detected and left alone, and everything is adjustable per site
from the popup.

## How it works

- **Inversion engine.** A content script injects `filter: invert(1) hue-rotate(180deg)` on
  the root element at `document_start`, before the first paint — so there is no white flash.
  The hue rotation keeps colors recognizable instead of turning them into negatives.
- **Media stays natural.** Images, video, and small canvases are counter-inverted so photos
  keep their real colors. Canvases that cover a large share of the viewport are treated as
  app surfaces (Google Docs renders documents into canvas tiles) and darken with the page.
- **Already-dark detection.** After load, Serenity measures the page's effective background
  luminance — parsing modern color syntaxes like `color(display-p3 …)` — and auto-skips
  sites that are already dark. The verdict is cached per origin for 7 days, so repeat visits
  to dark sites are untouched with no flash in either direction.
- **Native dark UI.** `color-scheme: dark` is set so form controls and scrollbars follow.

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked** and select this repository directory.

## Usage

Click the toolbar icon:

- **Global toggle** turns Serenity on or off everywhere.
- **Site mode** — *Auto* (dark unless the site already is), *Always on* (force dark even if
  detection thinks the site is dark), *Off* (never touch this site).
- **Brightness / Contrast** sliders tune the effect per site.

Changes apply to the open tab immediately, no reload needed.

## Storage

User settings live in `chrome.storage.sync` (falling back to local if sync is unavailable):

```json
{
  "globalEnabled": true,
  "defaults": { "brightness": 100, "contrast": 100 },
  "sites": {
    "https://example.com": { "mode": "auto", "brightness": 100, "contrast": 100 }
  }
}
```

Dark-site detection verdicts are kept separately in `chrome.storage.local` under
`detections` (`{ origin: timestamp }`) so they never count against sync quota or sync
your browsing origins across devices.

## Development

- `src/content.js` — inversion engine, dark-site detection, app-canvas tagging.
- `src/settings.js` — storage schema and helpers shared with the popup.
- `src/popup.{html,css,js}` — the popup UI.
- `test/fixtures/` — self-contained pages covering the edge cases (media, fixed headers,
  iframes, native-dark and wide-gamut backgrounds). See [TESTING.md](TESTING.md) for the
  manual QA checklist.

Issue tracking uses pebbles (`pb list` from the repo root).

## Roadmap

- Clear a site's cached detection verdict when its mode is changed from the popup.
- Optional v2 engine: dynamic palette theming (rewrite stylesheet colors instead of
  inverting) for higher fidelity on sites where inversion falls short.
