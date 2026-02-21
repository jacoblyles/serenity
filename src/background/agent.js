import { completeLlmRequest } from './llm-client.js';
import {
  buildToolResultMessage,
  buildToolResultMessageWithImage,
} from './llm-tools.js';
import { checkContrast } from '../shared/contrast.js';
import { log } from '../shared/logger.js';

const AGENT_CHECKPOINT_KEY = 'agentCheckpoint';
const DEFAULT_MAX_TURNS = 5;

const AGENT_SYSTEM_PROMPT = `You are a dark mode CSS generator. You can inspect page elements, apply CSS, and check your work via screenshots.

Strategy:
1. Review the color palette and page structure
2. Generate comprehensive dark mode CSS
3. Apply it and review the screenshot
4. Fix any issues (poor contrast, missed elements, broken layouts)
5. When satisfied, respond with your final CSS in a \`\`\`css fenced block

Rules:
- Cover ALL surfaces: body, headers, nav, sidebar, main content, cards, forms, inputs, tables, code blocks, footers
- Ensure WCAG AA contrast (4.5:1 for normal text, 3:1 for large text)
- Use !important on all rules (existing styles take precedence otherwise)
- Prefer CSS custom property overrides when available
- Keep images, videos, and SVG logos readable (don't invert them blindly)
- Use \`color-scheme: dark\` on :root`;

const AGENT_TOOLS = [
  {
    name: 'inspect',
    description: 'Inspect matching page elements and return computed style snapshots.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to inspect' },
        limit: { type: 'number', description: 'Maximum number of matched elements to inspect' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'apply_css',
    description: 'Apply CSS to the page and return a screenshot of the current viewport.',
    parameters: {
      type: 'object',
      properties: {
        css: { type: 'string', description: 'Complete CSS stylesheet to apply' },
      },
      required: ['css'],
    },
  },
  {
    name: 'get_color_palette',
    description: 'Get the current page color map and unique color palette.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'check_contrast',
    description: 'Compute WCAG contrast ratio for foreground/background color pair.',
    parameters: {
      type: 'object',
      properties: {
        foreground: { type: 'string' },
        background: { type: 'string' },
      },
      required: ['foreground', 'background'],
    },
  },
  {
    name: 'scroll_and_capture',
    description: 'Scroll to an absolute Y position and capture a viewport screenshot.',
    parameters: {
      type: 'object',
      properties: {
        y: { type: 'number', description: 'Vertical pixel offset to scroll to' },
      },
      required: ['y'],
    },
  },
];

export async function runAgentLoop(tabId, options = {}) {
  const maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns > 0
    ? options.maxTurns
    : DEFAULT_MAX_TURNS;

  let turns = 0;
  let currentCss = '';
  let lastAppliedCss = '';
  let provider = typeof options.provider === 'string' ? options.provider : null;
  let model = typeof options.model === 'string' ? options.model : null;
  let messages = [];
  let activeUrl = '';
  const hooks = isObject(options.hooks) ? options.hooks : {};

  try {
    const tab = await chrome.tabs.get(tabId);
    activeUrl = typeof tab?.url === 'string' ? tab.url : '';

    const checkpoint = await loadAgentCheckpoint();
    if (checkpoint && checkpoint.tabId === tabId && checkpoint.url === activeUrl) {
      turns = Number.isInteger(checkpoint.turnNumber) ? checkpoint.turnNumber : 0;
      messages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
      currentCss = typeof checkpoint.currentCss === 'string' ? checkpoint.currentCss : '';
      lastAppliedCss = currentCss;
      await log.info('agent', 'Resuming checkpoint', { tabId, url: activeUrl, turnNumber: turns });
    } else {
      const pageContext = await extractPageContext(tabId);
      const [colorMap, customProperties, screenshot] = await Promise.all([
        safeSendMessageToTabWithInjection(tabId, { type: 'extract-color-map' }).catch(() => null),
        safeSendMessageToTabWithInjection(tabId, { type: 'extract-custom-properties' }).catch(() => null),
        captureVisibleTabScreenshot(),
      ]);

      const initialPayload = {
        pageContext,
        colorMap,
        customProperties,
      };

      const text = [
        'Generate dark mode CSS for this page using iterative tool calls.',
        'Page context JSON:',
        JSON.stringify(initialPayload),
      ].join('\n\n');

      const content = screenshot
        ? [
            { type: 'text', text: `${text}\n\nAttached: initial viewport screenshot.` },
            { type: 'image_url', image_url: { url: screenshot } },
          ]
        : text;

      messages = [{ role: 'user', content }];
    }

    while (turns < maxTurns) {
      const currentTab = await chrome.tabs.get(tabId);
      const currentUrl = typeof currentTab?.url === 'string' ? currentTab.url : '';
      if (activeUrl && currentUrl && currentUrl !== activeUrl) {
        await log.warn('agent', 'Tab URL changed during run', { from: activeUrl, to: currentUrl });
        break;
      }

      if (typeof hooks.onTurnStart === 'function') {
        try {
          await hooks.onTurnStart({ turn: turns + 1, maxTurns, tabId, url: activeUrl });
        } catch {
          // Ignore progress hook failures and continue generation.
        }
      }

      const llmResult = await completeLlmRequest({
        provider: typeof options.provider === 'string' ? options.provider : undefined,
        model: typeof options.model === 'string' ? options.model : undefined,
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
        maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : 3200,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        messages,
        tools: AGENT_TOOLS,
      });

      turns += 1;
      provider = llmResult.provider;
      model = llmResult.model;

      const assistantText = typeof llmResult.text === 'string' ? llmResult.text : '';
      if (assistantText) {
        messages.push({ role: 'assistant', content: assistantText });
      }

      const toolCalls = Array.isArray(llmResult.toolCalls) ? llmResult.toolCalls : [];
      if (!toolCalls.length) {
        const cssFromText = extractCssFromModelText(assistantText);
        if (cssFromText) {
          currentCss = cssFromText;
        }

        await saveAgentCheckpoint({
          turnNumber: turns,
          messages,
          currentCss,
          tabId,
          url: activeUrl,
          timestamp: Date.now(),
        });
        break;
      }

      messages.push(buildAssistantToolCallMessage(llmResult.provider, assistantText, toolCalls));

      for (const toolCall of toolCalls) {
        const toolResult = await executeAgentTool(tabId, toolCall, {
          onApplyCss(css) {
            if (typeof css === 'string' && css.trim()) {
              currentCss = css;
              lastAppliedCss = css;
            }
          },
        });

        const imageDataUrl = getToolResultScreenshot(toolCall.name, toolResult);
        const sanitizedToolResult = imageDataUrl
          ? removeScreenshotFromToolResult(toolResult)
          : toolResult;

        const toolMessage = imageDataUrl
          ? buildToolResultMessageWithImage(
              llmResult.provider,
              toolCall.id,
              toolCall.name,
              sanitizedToolResult,
              imageDataUrl
            )
          : buildToolResultMessage(
              llmResult.provider,
              toolCall.id,
              toolCall.name,
              sanitizedToolResult
            );
        messages.push(toolMessage);
        pruneScreenshotsInConversation(messages, 1);
      }

      await saveAgentCheckpoint({
        turnNumber: turns,
        messages,
        currentCss,
        tabId,
        url: activeUrl,
        timestamp: Date.now(),
      });
    }

    const css = lastAppliedCss || currentCss;
    if (!css) {
      await clearAgentCheckpoint();
      return {
        css: null,
        turns,
        provider,
        model,
        error: 'Agent completed without producing CSS',
      };
    }

    await clearAgentCheckpoint();
    return {
      css,
      turns,
      provider,
      model,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent loop failed';
    await log.error('agent', 'Agent loop failed', { tabId, error: message });
    await clearAgentCheckpoint();
    return {
      css: currentCss || null,
      turns,
      provider,
      model,
      error: message,
    };
  }
}

function buildAssistantToolCallMessage(provider, assistantText, toolCalls) {
  const safeText = typeof assistantText === 'string' ? assistantText : '';
  const validToolCalls = toolCalls.filter(
    (call) => isObject(call) && typeof call.id === 'string' && typeof call.name === 'string'
  );

  if (provider === 'anthropic') {
    const content = [];
    if (safeText) {
      content.push({ type: 'text', text: safeText });
    }
    for (const toolCall of validToolCalls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: isObject(toolCall.arguments) ? toolCall.arguments : {},
      });
    }
    return {
      role: 'assistant',
      content,
    };
  }

  if (provider === 'google') {
    const content = [];
    if (safeText) {
      content.push({ type: 'text', text: safeText });
    }
    for (const toolCall of validToolCalls) {
      content.push({
        functionCall: {
          name: toolCall.name,
          args: isObject(toolCall.arguments) ? toolCall.arguments : {},
        },
      });
    }
    return {
      role: 'assistant',
      content,
    };
  }

  return {
    role: 'assistant',
    content: safeText,
    tool_calls: validToolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(
          isObject(toolCall.arguments) ? toolCall.arguments : {}
        ),
      },
    })),
  };
}

async function executeAgentTool(tabId, toolCall, hooks = {}) {
  const name = toolCall?.name;
  const args = isObject(toolCall?.arguments) ? toolCall.arguments : {};

  if (name === 'inspect') {
    if (typeof args.selector !== 'string' || !args.selector.trim()) {
      return { error: 'inspect requires selector' };
    }
    return safeSendMessageToTabWithInjection(tabId, {
      type: 'inspect-elements',
      selector: args.selector,
      limit: Number.isFinite(args.limit) ? Number(args.limit) : undefined,
    });
  }

  if (name === 'apply_css') {
    if (typeof args.css !== 'string' || !args.css.trim()) {
      return { applied: false, screenshot: null, error: 'apply_css requires css' };
    }

    await safeSendMessageToTabWithInjection(tabId, { type: 'apply-css', css: args.css });
    await safeSendMessageToTabWithInjection(tabId, { type: 'wait-for-paint' });
    if (typeof hooks.onApplyCss === 'function') {
      hooks.onApplyCss(args.css);
    }

    const screenshot = await captureVisibleTabScreenshot();
    return {
      applied: true,
      screenshot,
      cssLength: args.css.length,
    };
  }

  if (name === 'get_color_palette') {
    return safeSendMessageToTabWithInjection(tabId, { type: 'extract-color-map' });
  }

  if (name === 'check_contrast') {
    if (typeof args.foreground !== 'string' || typeof args.background !== 'string') {
      return { error: 'check_contrast requires foreground and background' };
    }

    try {
      return checkContrast(args.foreground, args.background);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'contrast check failed' };
    }
  }

  if (name === 'scroll_and_capture') {
    const y = Number(args.y);
    if (!Number.isFinite(y)) {
      return { screenshot: null, error: 'scroll_and_capture requires numeric y' };
    }

    await safeSendMessageToTabWithInjection(tabId, { type: 'scroll-to', y });
    const screenshot = await captureVisibleTabScreenshot();
    return { screenshot, y };
  }

  return { error: `Unknown tool: ${String(name)}` };
}

async function captureVisibleTabScreenshot() {
  try {
    return await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    await log.warn('agent', 'Screenshot capture failed', { error: message });
    return null;
  }
}

async function extractPageContext(tabId) {
  const domPromise = safeSendMessageToTabWithInjection(tabId, { type: 'extract-page-context' })
    .catch(() => safeSendMessageToTabWithInjection(tabId, { type: 'extract-dom' }));
  const [domResult, colorMapResult] = await Promise.allSettled([
    domPromise,
    safeSendMessageToTabWithInjection(tabId, { type: 'extract-color-map' }),
  ]);

  if (domResult.status !== 'fulfilled' && colorMapResult.status !== 'fulfilled') {
    throw new Error('Unable to extract page context');
  }

  const context = isObject(domResult.value) ? { ...domResult.value } : {};
  if (colorMapResult.status === 'fulfilled' && isObject(colorMapResult.value)) {
    context.colorMap = colorMapResult.value.colorMap;
    context.uniqueColors = colorMapResult.value.uniqueColors;
  }

  return context;
}

async function safeSendMessageToTabWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!shouldRetryWithContentScriptInjection(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function shouldRetryWithContentScriptInjection(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('Receiving end does not exist')
    || message.includes('Could not establish connection')
  );
}

async function loadAgentCheckpoint() {
  try {
    const data = await chrome.storage.session.get(AGENT_CHECKPOINT_KEY);
    return isObject(data?.[AGENT_CHECKPOINT_KEY]) ? data[AGENT_CHECKPOINT_KEY] : null;
  } catch {
    return null;
  }
}

async function saveAgentCheckpoint(checkpoint) {
  const prunedMessages = pruneScreenshotsForCheckpoint(checkpoint.messages);
  await chrome.storage.session.set({
    [AGENT_CHECKPOINT_KEY]: {
      turnNumber: checkpoint.turnNumber,
      messages: prunedMessages,
      currentCss: checkpoint.currentCss,
      tabId: checkpoint.tabId,
      url: checkpoint.url,
      timestamp: checkpoint.timestamp,
    },
  });
}

async function clearAgentCheckpoint() {
  try {
    await chrome.storage.session.remove(AGENT_CHECKPOINT_KEY);
  } catch {
    // Ignore clear failures.
  }
}

function pruneScreenshotsForCheckpoint(messages) {
  if (!Array.isArray(messages)) return [];

  const cloned = structuredClone(messages);
  const holders = [];

  for (const message of cloned) {
    collectScreenshotHoldersFromMessage(message, holders);
  }

  const keepIndex = holders.length - 1;
  for (let i = 0; i < holders.length; i += 1) {
    if (i === keepIndex) continue;
    holders[i].setPruned();
  }

  return cloned;
}

function pruneScreenshotsInConversation(messages, keepLatest = 1) {
  if (!Array.isArray(messages)) return;

  const holders = [];
  for (const message of messages) {
    collectScreenshotHoldersFromMessage(message, holders);
  }

  const keep = Math.max(0, Math.floor(keepLatest));
  const pruneUntil = Math.max(0, holders.length - keep);
  for (let i = 0; i < pruneUntil; i += 1) {
    holders[i].setPruned();
  }
}

function collectScreenshotHoldersFromMessage(message, holders) {
  if (!isObject(message)) return;

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isObject(part)) continue;

      if (
        part.type === 'image_url'
        && isObject(part.image_url)
        && typeof part.image_url.url === 'string'
        && part.image_url.url.startsWith('data:image/')
      ) {
        holders.push({
          setPruned: () => {
            part.image_url.url = '[screenshot pruned]';
          },
        });
      }

      if (part.type === 'tool_result' && typeof part.content === 'string') {
        collectScreenshotHoldersFromJsonString(
          part.content,
          (next) => {
            part.content = next;
          },
          holders
        );
      }

      if (part.type === 'tool_result' && Array.isArray(part.content)) {
        collectScreenshotHoldersFromContentParts(part.content, holders);
      }

      if (isObject(part.functionResponse)) {
        collectScreenshotHoldersFromObject(part.functionResponse.response, holders);
      }
    }
  }

  if (typeof message.content === 'string') {
    collectScreenshotHoldersFromJsonString(
      message.content,
      (next) => {
        message.content = next;
      },
      holders
    );
  }
}

function collectScreenshotHoldersFromContentParts(parts, holders) {
  for (const part of parts) {
    if (!isObject(part)) continue;

    if (
      part.type === 'image'
      && isObject(part.source)
      && part.source.type === 'base64'
      && typeof part.source.data === 'string'
      && part.source.data
    ) {
      holders.push({
        setPruned: () => {
          part.source.data = '[screenshot pruned]';
        },
      });
      continue;
    }

    if (
      part.type === 'image_url'
      && isObject(part.image_url)
      && typeof part.image_url.url === 'string'
      && part.image_url.url.startsWith('data:image/')
    ) {
      holders.push({
        setPruned: () => {
          part.image_url.url = '[screenshot pruned]';
        },
      });
    }
  }
}

function collectScreenshotHoldersFromJsonString(value, applyChange, holders) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }

  const localHolders = [];
  collectScreenshotHoldersFromObject(parsed, localHolders);
  if (!localHolders.length) return;

  for (const holder of localHolders) {
    holders.push({
      setPruned: () => {
        holder.setPruned();
        applyChange(JSON.stringify(parsed));
      },
    });
  }
}

function collectScreenshotHoldersFromObject(value, holders) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectScreenshotHoldersFromObject(item, holders);
    }
    return;
  }

  if (!isObject(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && nested.startsWith('data:image/')) {
      holders.push({
        setPruned: () => {
          value[key] = '[screenshot pruned]';
        },
      });
      continue;
    }

    collectScreenshotHoldersFromObject(nested, holders);
  }
}

function extractCssFromModelText(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:css)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (!candidate) return '';

  const normalized = candidate
    .replace(/^\s*<style[^>]*>/i, '')
    .replace(/<\/style>\s*$/i, '')
    .trim();

  if (!looksLikeCss(normalized)) return '';
  return normalized;
}

function looksLikeCss(text) {
  return /[.#:]?[a-zA-Z][a-zA-Z0-9_:\-#.*\s>,+~[\]="'()]*\{[^{}]*\}/.test(text);
}

function getToolResultScreenshot(toolName, result) {
  if (toolName !== 'apply_css' && toolName !== 'scroll_and_capture') {
    return null;
  }

  const screenshot = isObject(result) ? result.screenshot : null;
  if (typeof screenshot !== 'string' || !screenshot.startsWith('data:image/')) {
    return null;
  }

  return screenshot;
}

function removeScreenshotFromToolResult(result) {
  if (!isObject(result)) return result;
  const cloned = { ...result };
  delete cloned.screenshot;
  return cloned;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
