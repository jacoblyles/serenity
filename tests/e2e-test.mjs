import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');
const screenshotDir = path.resolve(__dirname, 'screenshots');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY env var');
  process.exit(1);
}

fs.mkdirSync(screenshotDir, { recursive: true });

async function generateForUrl(serviceWorker, extensionPage, targetUrl, label, screenshotBefore, screenshotAfter, sitePage) {
  await sitePage.screenshot({ path: path.join(screenshotDir, screenshotBefore) });
  console.log(`Screenshot: ${label} before dark mode`);

  // Find the tab ID for the target URL from the service worker
  const tabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.includes(url));
    return tab?.id ?? null;
  }, targetUrl);

  if (tabId === null) {
    console.log(`${label}: Could not find tab for ${targetUrl}`);
    return null;
  }
  console.log(`${label}: Found tab ${tabId}`);

  // Use the extension page to send the generate message with explicit tabId
  console.log(`Generating dark mode for ${label}...`);
  const result = await extensionPage.evaluate(async ({ tabId, provider, model }) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'generate-dark-mode',
        tabId,
        provider,
        model,
        twoPass: false,
      });
      return response;
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }, { tabId, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });

  console.log(`${label} result:`, JSON.stringify(result, null, 2)?.slice(0, 800));

  if (result?.error) {
    console.log(`${label} ERROR: ${result.error}`);
    await sitePage.screenshot({ path: path.join(screenshotDir, screenshotAfter) });
    return result;
  }

  if (result?.skipped) {
    console.log(`${label} SKIPPED: ${result.reason}`);
    await sitePage.screenshot({ path: path.join(screenshotDir, screenshotAfter) });
    return result;
  }

  if (result?.css) {
    await sitePage.waitForTimeout(1000);
    await sitePage.screenshot({ path: path.join(screenshotDir, screenshotAfter) });
    console.log(`Screenshot: ${label} with dark mode (${result.css.length} bytes CSS)`);

    // Save the style
    const saveResult = await extensionPage.evaluate(async ({ url, css }) => {
      return chrome.runtime.sendMessage({
        type: 'save-stored-style',
        url,
        css,
        scope: 'domain',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
    }, { url: await sitePage.url(), css: result.css });
    console.log(`${label} save result:`, JSON.stringify(saveResult));
  }

  return result;
}

async function run() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
    viewport: { width: 1440, height: 900 },
  });

  // Wait for extension service worker
  let serviceWorker;
  if (context.serviceWorkers().length === 0) {
    serviceWorker = await context.waitForEvent('serviceworker');
  } else {
    serviceWorker = context.serviceWorkers()[0];
  }

  const extensionId = serviceWorker.url().split('/')[2];
  console.log('Extension ID:', extensionId);

  // Configure API key and settings, clear old styles
  await serviceWorker.evaluate(async (apiKey) => {
    const { llmSettings } = await chrome.storage.local.get('llmSettings');
    const settings = llmSettings || {};
    if (!settings.apiKeys) settings.apiKeys = {};
    settings.apiKeys.anthropic = apiKey;
    await chrome.storage.local.set({
      llmSettings: settings,
      selectedModel: 'claude-haiku-4-5-20251001',
      enabled: true,
      twoPass: false,
      generationMode: 'quick',
      darkModeStyles: { _schemaVersion: 2 },
    });
  }, API_KEY);
  console.log('Configured: API key, Haiku 4.5, enabled, single-pass, quick mode, styles cleared');

  // Open options page as our "extension page" for sending messages
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await optionsPage.waitForLoadState('domcontentloaded');
  await optionsPage.waitForTimeout(800);

  // Screenshot options tabs
  await optionsPage.screenshot({ path: path.join(screenshotDir, '01-options-providers.png') });
  console.log('Screenshot: options - providers tab');

  for (const tabName of ['prompts', 'sites', 'debug']) {
    await optionsPage.locator(`[data-tab="${tabName}"]`).click();
    await optionsPage.waitForTimeout(400);
    await optionsPage.screenshot({ path: path.join(screenshotDir, `01-options-${tabName}.png`) });
    console.log(`Screenshot: options - ${tabName} tab`);
  }
  // Switch back to providers
  await optionsPage.locator('[data-tab="providers"]').click();
  await optionsPage.waitForTimeout(200);

  // --- TEST SITE 1: Hacker News ---
  console.log('\n=== Testing: Hacker News ===');
  const hnPage = await context.newPage();
  await hnPage.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded' });
  await hnPage.waitForTimeout(2000);

  const hnResult = await generateForUrl(
    serviceWorker, optionsPage, 'news.ycombinator.com',
    'HN', '03-hn-before.png', '04-hn-dark.png', hnPage
  );

  // Navigate to HN thread detail
  if (hnResult?.css) {
    console.log('Navigating to HN thread...');
    const commentsLink = hnPage.locator('.subtext a[href*="item?id="]').first();
    if (await commentsLink.isVisible().catch(() => false)) {
      await commentsLink.click();
      await hnPage.waitForLoadState('domcontentloaded');
      await hnPage.waitForTimeout(2000);
      await hnPage.screenshot({ path: path.join(screenshotDir, '05-hn-thread.png') });
      console.log('Screenshot: HN thread detail (domain style should auto-apply)');
    }
  }

  // --- TEST SITE 2: The Motte ---
  console.log('\n=== Testing: The Motte ===');
  const mottePage = await context.newPage();
  await mottePage.goto('https://www.themotte.org/', { waitUntil: 'domcontentloaded' });
  await mottePage.waitForTimeout(2000);

  const motteResult = await generateForUrl(
    serviceWorker, optionsPage, 'themotte.org',
    'Motte', '06-motte-before.png', '07-motte-dark.png', mottePage
  );

  // Navigate to a Motte thread
  if (motteResult?.css) {
    console.log('Navigating to Motte thread...');
    const threadLink = mottePage.locator('a[href*="/post/"]').first();
    if (await threadLink.isVisible().catch(() => false)) {
      await threadLink.click();
      await mottePage.waitForLoadState('domcontentloaded');
      await mottePage.waitForTimeout(2000);
      await mottePage.screenshot({ path: path.join(screenshotDir, '08-motte-thread.png') });
      console.log('Screenshot: Motte thread detail');
    }
  }

  // --- Check options after generation ---
  console.log('\n=== Checking Options Page ===');
  await optionsPage.reload();
  await optionsPage.waitForLoadState('domcontentloaded');
  await optionsPage.waitForTimeout(800);

  // Sites tab
  await optionsPage.locator('[data-tab="sites"]').click();
  await optionsPage.waitForTimeout(600);
  await optionsPage.screenshot({ path: path.join(screenshotDir, '09-sites-populated.png') });
  console.log('Screenshot: sites tab with saved styles');

  // Expand a site card if present
  const siteCard = optionsPage.locator('.site-card').first();
  if (await siteCard.isVisible().catch(() => false)) {
    await siteCard.locator('.site-header').click().catch(() => {});
    await optionsPage.waitForTimeout(400);
    await optionsPage.screenshot({ path: path.join(screenshotDir, '09b-site-expanded.png') });
    console.log('Screenshot: site card expanded');
  }

  // Scroll to statistics
  await optionsPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await optionsPage.waitForTimeout(300);
  await optionsPage.screenshot({ path: path.join(screenshotDir, '10-statistics.png') });
  console.log('Screenshot: statistics');

  // Popup
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popupPage.waitForLoadState('domcontentloaded');
  await popupPage.waitForTimeout(500);
  await popupPage.screenshot({ path: path.join(screenshotDir, '11-popup.png') });
  console.log('Screenshot: popup');

  console.log('\n=== All screenshots saved to tests/screenshots/ ===');
  console.log('Browser stays open 20s for manual inspection...');
  await new Promise((r) => setTimeout(r, 20000));

  await context.close();
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
