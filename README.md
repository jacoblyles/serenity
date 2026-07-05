# Serenity

Serenity is a Chrome Manifest V3 extension that automatically applies a night mode to sites that do not provide one. The v1 engine is local, deterministic, and dependency-free.

## Load Unpacked

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked.
4. Select this repository directory.

## File Layout

- `manifest.json`: Chrome MV3 extension manifest.
- `src/content.js`: content script entry point.
- `src/settings.js`: storage schema and popup settings helpers.
- `src/popup.html`: extension popup markup.
- `src/popup.css`: popup styles.
- `src/popup.js`: popup behavior.
- `icons/`: extension icons.

## Storage

Settings are stored in `chrome.storage.sync`, falling back to `chrome.storage.local` if sync is unavailable:

```json
{
  "globalEnabled": true,
  "defaults": {
    "brightness": 100,
    "contrast": 100
  },
  "sites": {
    "https://example.com": {
      "mode": "auto",
      "brightness": 100,
      "contrast": 100
    }
  }
}
```
