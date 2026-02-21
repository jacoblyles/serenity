# Agentic Dark Mode Generation — Design Doc

**Status:** Proposed (v2, post-critique)  
**Author:** Serenity PM  
**Date:** 2026-02-21  
**Critique:** See `agentic-dark-mode-critique.md` for the full review that informed this revision.

## Problem

The current dark mode generation uses a single LLM completion call. The model receives a truncated DOM snapshot (max 260 nodes, depth 5) and must produce complete, correct CSS in one shot. It can't see the page, can't check its work, and can't iterate. The results are consistently mediocre — missed elements, poor contrast, broken layouts.

## Strategy: Layered Approach

Rather than jumping straight to a multi-turn agent loop, we take a layered approach where each phase independently improves quality:

1. **Phase 0: Zero-cost wins** — Extract and leverage what the site already provides (CSS custom properties, native dark mode rules)
2. **Phase 1: Better context** — Replace the truncated DOM tree with a compact color map that's directly useful for dark mode
3. **Phase 2: Two-pass generation** — Automated generate → screenshot → refine cycle (no tool calling needed)
4. **Phase 3: Full agent loop** — Multi-turn tool-calling agent for sites that need it (opt-in)

Each phase ships independently and improves on the last.

---

## Phase 0: Zero-Cost Wins

### 0a. Extract and apply `prefers-color-scheme: dark` rules

Many sites ship dark mode CSS behind `@media (prefers-color-scheme: dark)` but the user's OS preference is set to light. Serenity can extract these rules, strip the media query wrapper, and inject them directly — giving the site's *own* dark mode for free.

**Implementation:**
- Content script: enumerate all `@media (prefers-color-scheme: dark)` rules from `document.styleSheets`
- Strip the media query wrapper, collect as raw CSS text
- If total extracted CSS > some threshold (e.g., 500 bytes), apply it directly — skip LLM entirely
- Falls through to LLM-based generation only if the site lacks native dark mode or it's insufficient

**Cost:** Zero LLM calls. Instant. Perfect fidelity (it's the site's own CSS).

### 0b. CSS custom property extraction

Modern sites (GitHub, Notion, Tailwind-based apps) use CSS custom properties for theming. If the site defines `--bg-color`, `--text-color`, etc., the dark mode CSS can override just those variables.

**Implementation:**
- Content script: read all `--*` properties from `:root` computed style and from `:root` rules in stylesheets
- Group by likely purpose: backgrounds, text, accents, borders (heuristic based on name + value)
- Pass to LLM as a structured "custom property map" alongside (or instead of) the DOM tree
- LLM generates overrides for the custom properties instead of element-level CSS

**Cost:** Same single LLM call, but dramatically better context → dramatically better results.

### 0c. Improved DOM context: color map

Replace the truncated DOM tree (260 nodes, depth 5) with a **color map**: a deduplicated list of CSS selectors and their computed color-related properties (color, backgroundColor, borderColor, fill, stroke). This is:
- Far more compact than a DOM tree (hundreds of tokens vs thousands)
- Directly relevant to dark mode (colors are all that matter)
- Complete coverage (doesn't truncate at depth 5)

**Format:**
```json
{
  "customProperties": { "--bg": "#fff", "--text": "#333", ... },
  "colorMap": [
    { "selector": "body", "bg": "#fff", "color": "#333" },
    { "selector": ".sidebar", "bg": "#f5f5f5", "color": "#666" },
    { "selector": "pre, code", "bg": "#f8f8f8", "color": "#333", "border": "#e1e4e8" }
  ],
  "uniqueColors": { "backgrounds": ["#fff", "#f5f5f5", "#f8f8f8"], "text": ["#333", "#666"] }
}
```

---

## Phase 1: Two-Pass Generation

Before building tool calling, automate the existing refine pattern:

1. Generate CSS (single `completeLlmRequest()` call with color map context)
2. Apply CSS to the page
3. Capture screenshot via `chrome.tabs.captureVisibleTab()`
4. Send screenshot + current CSS back with a "evaluate and refine" prompt
5. Return refined CSS

This is essentially the manual `handleRefineDarkMode` path, automated. No tool calling, no format divergence across providers — just two sequential completion calls.

**Cost:** 2x the current cost (~$0.02-0.06 with mid-tier models). Much cheaper than a full agent loop.

**Screenshot capture notes:**
- `captureVisibleTab()` requires the tab to be visible and focused. If it fails (user switched tabs), skip the screenshot and return the first-pass CSS as-is.
- Wait for `requestAnimationFrame` + 150ms after CSS injection before capturing (let transitions/reflows settle).
- Resize in the content script or via `OffscreenCanvas` in the service worker — Canvas API not available in service workers without `OffscreenCanvas`. Target 800px wide.

---

## Phase 2: Full Agent Loop (Opt-In)

For sites where two-pass isn't enough, offer a "thorough" mode with a tool-using agent.

### Architecture

```
┌─────────────────────────────────────────────┐
│  Service Worker (agent orchestrator)         │
│                                              │
│  ┌─────────────────────────────────────┐     │
│  │  Agent Loop (max N turns)           │     │
│  │                                     │     │
│  │  1. LLM call w/ tool definitions    │     │
│  │  2. Parse response for tool calls   │     │
│  │  3. Execute tools via content script │     │
│  │  4. Feed results back as next msg   │     │
│  │  5. Repeat until done or max turns  │     │
│  └─────────────────────────────────────┘     │
│                                              │
│  State Checkpoint (chrome.storage.session)   │
│  Survives service worker termination         │
└──────────────┬──────────────────────────────┘
               │ chrome.tabs.sendMessage()
               │ chrome.tabs.captureVisibleTab()
               ▼
┌─────────────────────────────────────────────┐
│  Content Script                              │
│  Handles: inspect, color palette, contrast   │
│  Returns: JSON results to service worker     │
└─────────────────────────────────────────────┘
```

### Tools

**`inspect(selector: string, limit?: number)`**
Returns computed styles for elements matching the selector. Includes: `color`, `backgroundColor`, `fontSize`, `fontWeight`, `border*`, `display`, `position`, `visibility`, `opacity`, bounding rect. Limit defaults to 10. The model writes selectors directly — it's better at CSS selectors than any NL→selector heuristic.

**`apply_css(css: string)`**
Injects CSS into the page, waits for paint (rAF + 150ms), captures screenshot via `captureVisibleTab()`. Returns screenshot as base64. If capture fails (tab not focused), returns `{ applied: true, screenshot: null }` — the agent continues without visual feedback.

**`get_color_palette()`**
Walks visible elements and extracts unique `color`, `backgroundColor`, and `borderColor` values. Groups into: backgrounds, text, accents, borders.

**`check_contrast(foreground: string, background: string)`**
WCAG 2.1 contrast ratio calculation. Returns `{ ratio: 4.5, aa: true, aaa: false }`. Runs in service worker (pure math, no DOM).

**`scroll_and_capture(y: number)`**
Scrolls to a Y offset, waits for paint, captures screenshot. For checking below-the-fold content.

### MV3 Service Worker Survival

**The agent loop must survive service worker termination.** Chrome kills MV3 service workers after ~5 minutes of inactivity.

**State checkpointing:**
- After each turn, checkpoint to `chrome.storage.session`:
  - Current turn number
  - Message history (with old screenshots pruned — see below)
  - Current best CSS
  - Tab ID and URL
- On service worker restart, check for an active checkpoint and resume
- Clear checkpoint when generation completes or is cancelled
- Use `chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` for 10MB quota

**Screenshot pruning in message history:**
- Only keep the most recent screenshot in the stored history
- When sending turn N, remove all screenshot base64 from turns < N-1
- After turn 1, replace the DOM/color-map context with a compact summary (just custom properties + problematic selectors)
- This keeps the stored state under 1-2MB even at turn 5

**Keep-alive:** Each LLM `fetch()` call keeps the worker alive during the request. The gaps between turns (tool execution) are short (<1s). If a provider is slow (>30s response), the worker may still die — the checkpoint handles this.

### Token Cost (Honest Estimates)

Per-generation cost for a 5-turn agent loop:

| Turn | Incremental input tokens | Cumulative input | Output tokens |
|------|-------------------------|-------------------|---------------|
| 1 (analyze) | System + color map + screenshot = ~4-6K | ~5K | ~1K |
| 2 (generate) | + turn 1 exchange + tool results = ~3K | ~9K | ~3K (CSS) |
| 3 (refine) | + turn 2 exchange + new screenshot = ~5K | ~14K | ~2K |
| 4 (refine) | + turn 3 exchange + screenshot = ~5K | ~12K* | ~2K |
| 5 (final) | + turn 4 exchange = ~3K | ~10K* | ~1K |

*After pruning old screenshots and shrinking DOM context

**Totals:** ~50K input tokens, ~9K output tokens across all calls.

| Provider/Model | Estimated Cost |
|----------------|---------------|
| GPT-4.1 mini ($0.40/$1.60 per M) | ~$0.03 |
| GPT-4.1 ($2/$8 per M) | ~$0.17 |
| Claude Sonnet ($3/$15 per M) | ~$0.29 |
| Gemini Flash ($0.075/$0.30 per M) | ~$0.01 |
| Gemini Pro ($1.25/$10 per M) | ~$0.15 |

**Two-pass mode** (Phase 1) costs roughly 2x single-shot: $0.01-0.06 depending on model.

### Provider Compatibility: Tool Calling

Each provider has a different tool calling format:
- **OpenAI:** `tool_calls` array in assistant message, `tool` role for results
- **Anthropic:** `tool_use` content blocks, `tool_result` in user message
- **Google:** `functionCall` parts, `functionResponse` in user message

**Approach:** Normalize in `llm-client.js`. Define tools in a provider-agnostic format, translate to each provider's schema when building the request, and normalize tool call responses back to a common format. This is real work (~200-300 lines) but necessary.

**Alternative for simpler initial implementation:** Use structured JSON output instead of native tool calling. Tell the model to respond with JSON `{ "action": "inspect", "selector": "..." }` and parse it. Works identically across all providers. Less elegant but ships faster. Can upgrade to native tool calling later.

### Edge Cases

**CSP blocking style injection:** Some sites block inline `<style>` elements. After injection, check if `sheet.cssRules` is empty. If blocked, fall back to `chrome.scripting.insertCSS()` which bypasses CSP as extension-origin CSS.

**SPA navigation between turns:** Check `tab.url` at the start of each turn. If it's changed, abort the loop and return the best CSS so far (or restart).

**Tab not visible:** `captureVisibleTab()` fails if the tab isn't focused. Catch the error, skip the screenshot, continue without visual feedback.

**LLM call failure mid-loop:** On network error or rate limit, retry once. If it fails again, return the best CSS generated so far (or the CSS from the last successful `apply_css` call).

**`chrome://` and `about:` pages:** `captureVisibleTab()` doesn't work on these. Detect and skip.

**Screenshot timing:** After `apply_css`, wait for `requestAnimationFrame` + 150ms before capture. CSS transitions and reflows need time to settle.

**Image resizing:** Service workers lack Canvas API. Resize screenshots in the content script via an offscreen `<canvas>` element, or use `OffscreenCanvas` (available in workers in Chrome 69+). Target 800px wide max.

---

## Revised Phasing

| Phase | What | Complexity | LLM cost impact |
|-------|------|-----------|----------------|
| **0a** | Extract & apply `prefers-color-scheme: dark` rules | Low (~50 LOC in content script) | Eliminates LLM for many sites |
| **0b** | CSS custom property extraction + injection | Low (~80 LOC) | Same cost, much better results |
| **0c** | Color-map DOM context (replace truncated tree) | Medium (~150 LOC) | Same cost, better results |
| **1** | Two-pass generation (generate → screenshot → refine) | Medium (~200 LOC) | 2x current (~$0.02-0.06) |
| **2** | Instrumentation (measure quality/cost of Phase 0-1) | Low | None |
| **3** | Tool infrastructure (inspect, palette, contrast, screenshot) | Medium-High (~400 LOC) | N/A |
| **4** | Agent loop (`agent.js` with state checkpointing) | High (~600 LOC) | 5-10x current ($0.01-0.29) |
| **5** | UI (progress indicators, mode toggle, cost estimate display) | Medium (~200 LOC) | N/A |
| **6** | Opt-in rollout, then default once validated | Low | N/A |

## Success Criteria

- Phase 0: Dark mode quality noticeably better on 10+ test sites; native dark mode activated on sites that have it
- Phase 1: Two-pass produces measurably better CSS than single-shot on >50% of sites
- Phase 2+: Agent loop outperforms two-pass enough to justify the cost increase
- Generation completes in under 30 seconds (2-pass) / under 60 seconds (agent loop)
- Cost per generation: under $0.05 (2-pass with mid-tier) / under $0.30 (agent loop)
