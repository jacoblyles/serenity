# Agentic Dark Mode Generation — Design Doc

**Status:** Proposed  
**Author:** Serenity PM  
**Date:** 2026-02-21

## Problem

The current dark mode generation uses a single LLM completion call. The model receives a truncated DOM snapshot (max 260 nodes, depth 5) and must produce complete, correct CSS in one shot. It can't see the page, can't check its work, and can't iterate. The results are consistently mediocre — missed elements, poor contrast, broken layouts.

## Solution: Tool-Using Agent Loop

Replace the single `completeLlmRequest()` call with a multi-turn agent loop running in the service worker. The agent gets tools to explore the page, apply CSS, and visually verify results.

## Architecture

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
│  Tool Execution Layer                        │
│  ├─ inspect(selector) → computed styles      │
│  ├─ apply_css(css) → screenshot              │
│  ├─ get_color_palette() → color map          │
│  ├─ query_elements(desc) → selectors+styles  │
│  ├─ check_contrast(fg, bg) → WCAG ratio      │
│  └─ scroll_and_capture(y) → screenshot       │
└──────────────┬──────────────────────────────┘
               │ chrome.tabs.sendMessage()
               │ chrome.tabs.captureVisibleTab()
               ▼
┌─────────────────────────────────────────────┐
│  Content Script                              │
│  Handles: inspect, query, palette, contrast  │
│  Returns: JSON results to service worker     │
└─────────────────────────────────────────────┘
```

## Tools

### `inspect(selector: string, limit?: number)`
Returns computed styles for elements matching the selector. Includes: `color`, `backgroundColor`, `fontSize`, `fontWeight`, `border*`, `display`, `position`, `visibility`, `opacity`, bounding rect. Limit defaults to 10.

### `apply_css(css: string)`
Injects CSS into the page via the existing `apply-css` content script message, then captures a screenshot via `chrome.tabs.captureVisibleTab()`. Returns the screenshot as base64. This is the visual feedback loop — the model sees what its CSS actually does.

### `get_color_palette()`
Walks visible elements and extracts unique `color`, `backgroundColor`, and `borderColor` values. Groups into: backgrounds, text, accents, borders. Returns a summary like `{ backgrounds: ["#fff", "#f5f5f5"], text: ["#333", "#666"], ... }`.

### `query_elements(description: string)`
Semantic element query. Given a natural language description (e.g. "navigation sidebar", "code blocks", "search input"), returns matching selectors with their current computed styles. Implementation: a lightweight heuristic matcher using tag names, roles, aria labels, class names, and position.

### `check_contrast(foreground: string, background: string)`
Calculates WCAG 2.1 contrast ratio. Returns `{ ratio: 4.5, aa: true, aaa: false }`. Runs in the service worker (no DOM needed, pure math).

### `scroll_and_capture(y: number)`
Scrolls the page to a vertical offset, waits for paint, captures screenshot. Lets the agent check below-the-fold content.

## Agent Loop

```
System prompt: You are a dark mode CSS expert. Analyze the page, generate 
dark mode CSS, apply it, and iterate until it looks good. You have tools 
to inspect the page, apply CSS, and take screenshots to verify your work.

Turn 1 (Analyze):
  - Model receives: page URL, title, initial screenshot, basic DOM summary
  - Model responds: analysis of page structure, color palette, plan of attack
  - Model calls: get_color_palette(), maybe inspect() on key regions

Turn 2 (Generate):
  - Model generates initial CSS based on analysis
  - Model calls: apply_css(initial_css)
  - Gets back: screenshot showing the result

Turn 3+ (Iterate):
  - Model evaluates screenshot, identifies problems
  - Model calls: inspect() on problem elements, generates fixes
  - Model calls: apply_css(updated_css) → new screenshot
  - Repeats until satisfied

Final turn:
  - Model responds with final CSS (no tool call)
  - Agent loop extracts CSS and returns it
```

### Turn Budget

- **Default:** 5 turns max (analyze + generate + 3 refinement rounds)
- **Quick mode:** 1 turn (current behavior, single-shot, for users who want speed)
- **Configurable** in options page

### Token Budget

Screenshots are expensive. Mitigations:
- Resize captured screenshots to max 800px wide before base64 encoding
- Only include screenshot in the message immediately following `apply_css`
- DOM summary stays lean — model pulls details on demand via `inspect()`
- Estimated per-generation cost: ~15-25K input tokens across all turns

## Content Script Changes

New message types handled by content script:

- `inspect-elements` — takes `{ selector, limit }`, returns computed styles array
- `get-color-palette` — walks visible DOM, returns grouped color map
- `query-elements` — takes `{ description }`, returns heuristic matches

The existing `extract-dom`, `apply-css`, `remove-css`, `detect-dark-mode` messages stay unchanged.

## LLM Client Changes

The `completeLlmRequest()` function currently handles simple completions. For the agent loop, we need:

- **Tool definitions** passed alongside messages (OpenAI `tools` format, translated for Anthropic/Google)
- **Tool call parsing** from responses (handle `tool_calls` in assistant messages)
- **Multi-turn message history** management in the agent loop

This means either extending `completeLlmRequest()` to support tool-calling responses, or building a new `agentLoop()` function that wraps it.

Recommended: new `runAgentLoop(config)` function in a new file `src/background/agent.js` that:
1. Manages the message history
2. Calls `completeLlmRequest()` each turn with tool definitions
3. Parses tool calls, executes them, appends results
4. Returns final CSS when the model stops calling tools

## Provider Compatibility

Tool/function calling support:
- **OpenAI** (GPT-4.1, etc.) — native `tools` parameter ✅
- **Anthropic** (Claude) — native `tools` parameter ✅  
- **Google** (Gemini) — native `tools` parameter ✅
- **Custom endpoints** — may or may not support tools. Fall back to single-shot for unsupported providers.

## UI Changes

### Popup
- Add a generation mode toggle or dropdown: **Quick** (1-shot) vs **Thorough** (agentic)
- Show progress during agentic generation: "Analyzing page..." → "Generating CSS..." → "Refining (round 2)..." → "Done"

### Options Page  
- Max turns setting (default 5)
- Toggle for agentic mode as default

## Migration Path

1. **Phase 1:** Build the tool infrastructure — content script handlers, screenshot capture, `check_contrast` utility
2. **Phase 2:** Build `agent.js` with the agent loop, tool definitions, multi-turn message management
3. **Phase 3:** Wire up the agent loop as the default generation path, with single-shot fallback
4. **Phase 4:** UI — progress indicators, mode toggle, settings
5. **Phase 5:** Optimize — caching, cost tracking, smarter prompts based on site type

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Cost — multiple LLM calls per generation | Quick mode fallback; turn cap; use smaller models for analysis turns |
| Latency — 3-5 round trips | Progress UI; parallel tool execution where possible |
| Screenshot token cost | Resize to 800px; only attach when needed |
| Tool calling not supported by provider | Detect capability, fall back to single-shot |
| Infinite loops | Hard turn cap, total token budget |
| Inconsistent tool call formats across providers | Normalize in llm-client.js |

## Success Criteria

- Dark mode CSS quality noticeably better on 10+ test sites (GitHub, HN, Reddit, Wikipedia, Stack Overflow, docs sites, blogs)
- Works across OpenAI, Anthropic, and Google providers
- Generation completes in under 30 seconds on average
- Cost per generation under $0.05 with mid-tier models
