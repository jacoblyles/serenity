# Serenity Testing

## Load Unpacked

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this repository directory.

## Local Fixture Server

Serve the repository root:

```sh
python3 -m http.server
```

Open fixtures from `http://localhost:8000/test/fixtures/`.

Detection is per origin, so all fixtures served from `localhost:8000` share the same Serenity site setting and detected-dark cache. Use the popup site tri-state to switch between Auto, Always on, and Off while checking different fixtures.

## Fixture Checks

- `light.html`: page renders dark in Auto or Always on, with readable text, links, forms, and no white flash.
- `dark.html`: page is auto-skipped as already dark; on a second visit there should be no initial inversion flash.
- `media.html`: image and picture colors look natural, video poster and canvas are counter-inverted, and inline SVG icons invert with page text.
- `fixed.html`: fixed header remains pinned and sticky sidebar behaves while scrolling.
- `frame.html`: embedded `light.html` and `dark.html` frames are inverted only once by the top-frame root filter.

## Real-Site Pass List

Check these sites in Auto mode and with popup overrides:

- `https://www.wikipedia.org/`
- `https://news.ycombinator.com/`
- `https://developer.mozilla.org/`
- `https://github.com/`
- A Google search results page

For each site, verify:

- No white flash on load when Serenity is enabled.
- Photos and video look natural.
- Fixed headers and sticky UI behave while scrolling.
- Already-dark sites are untouched in Auto mode.
- Popup controls update the current tab live.
- Global, per-site mode, brightness, and contrast settings persist after browser restart.
