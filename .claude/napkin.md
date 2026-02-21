# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-02-20 | user | Used outdated model IDs (gpt-4.1, claude-sonnet-4, grok-3-mini-fast) | Always check latest models before setting defaults. Current: gpt-5.2, claude-sonnet-4-6-20260217, gemini-2.5-flash, grok-4-fast-non-reasoning |

## User Preferences
- Use pebbles (pb) for issue tracking
- No claude attribution in commits
- Comments sparingly
- Simplicity without sacrificing function

## Patterns That Work
- Chrome extension MV3 - vanilla JS, no framework
- chrome.storage.local for all persistent state
- Service worker handles all LLM requests
- Shared module (llm-settings.js) for config used by both options and service worker
- Content script handles detection/DOM work, service worker orchestrates via messages
- Return `{ skipped: true, reason }` from generation when pre-checks fail — popup/auto-mode handle gracefully
- E2E testing: use `chromium.launchPersistentContext` with `--load-extension` flag, use extension pages (options page) to send chrome.runtime messages with explicit tabId
- Generation quality: specific color palette targets + WCAG contrast ratios + structured custom property strategy in prompts >> generic "generate dark mode" instructions
- DOM limits: depth matters more than breadth for forums/threads — increase depth even when reducing node count for token budget

## Patterns That Don't Work
- Service workers can't `chrome.runtime.sendMessage` to themselves — must use extension page context
- Playwright `page.evaluate` runs in main world where `chrome.runtime` is undefined — can't send extension messages from content pages
- Generic prompts ("generate dark mode CSS") produce poor results — LLM needs specific palette targets, contrast ratios, and selector strategies
- Sites with inline `bgcolor` attributes (like HN `<td bgcolor>`) are hard to override even with `!important` — may need two-pass refinement

## Domain Notes
- Serenity = Chrome extension for AI-powered dark mode
- Settings stored under `llmSettings` key in chrome.storage.local
- Provider config: openai, anthropic, google, xai, custom
- Options page is a full HTML page (not popup) with vertical tab nav
- MV3 default CSP allows external stylesheets/fonts (only scripts restricted)
- Dark mode CSS stored in `darkModeStyles` with v2 schema: versions array per domain/page, activeVersionId, max 8 versions
- style-storage.js handles migration from v1 (flat css) to v2 (versioned)
- Sites tab saves immediately (no Save/Reset), providers/prompts use Save/Reset
