import { PROVIDER_CONFIG, PROVIDER_MODELS, MANAGED_PROVIDERS } from '../shared/llm-settings.js';

const toggle = document.getElementById('toggle-dark-mode');
const autoToggle = document.getElementById('toggle-auto-mode');
const label = document.getElementById('toggle-label');
const autoLabel = document.getElementById('auto-toggle-label');
const twoPassToggle = document.getElementById('toggle-two-pass');
const twoPassLabel = document.getElementById('two-pass-toggle-label');
const providerSelector = document.getElementById('provider-selector');
const modelSelector = document.getElementById('model-selector');
const generationModeButtons = Array.from(document.querySelectorAll('[data-generation-mode]'));
const generateDarkModeBtn = document.getElementById('generate-dark-mode-btn');
const generationProgress = document.getElementById('generation-progress');
const openSettingsBtn = document.getElementById('open-settings-btn');
const feedbackText = document.getElementById('feedback-text');
const feedbackImageBtn = document.getElementById('feedback-image-btn');
const feedbackImageInput = document.getElementById('feedback-image-input');
const feedbackImageList = document.getElementById('feedback-image-list');
const refineDarkModeBtn = document.getElementById('refine-dark-mode-btn');
const status = document.getElementById('status');
let feedbackSaveTimer = null;
let feedbackImages = [];
let isGenerating = false;
let isRefining = false;
let generationMode = 'quick';

const MAX_FEEDBACK_IMAGES = 3;
const MAX_FEEDBACK_IMAGE_BYTES = 1000000;
const MAX_FEEDBACK_IMAGE_DIMENSION = 1600;
const IMAGE_NAME_MAX_LENGTH = 80;
const GENERATION_SCREENSHOT_PROVIDERS = new Set(['anthropic']);
const MAX_GENERATION_SCREENSHOT_BYTES = 350000;
const MAX_GENERATION_SCREENSHOT_DIMENSION = 1280;

function buildProviderOptions() {
  for (const key of MANAGED_PROVIDERS) {
    const config = PROVIDER_CONFIG[key];
    if (!config) continue;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = config.label;
    providerSelector.appendChild(option);
  }
}

function buildModelOptions(providerKey) {
  modelSelector.innerHTML = '';

  const models = PROVIDER_MODELS[providerKey];
  if (!models || models.length === 0) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'No models available';
    modelSelector.appendChild(placeholder);
    modelSelector.disabled = true;
    return;
  }

  modelSelector.disabled = false;
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    modelSelector.appendChild(option);
  }
}

function findProviderForModel(modelId) {
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    if (models.some((m) => m.id === modelId)) return provider;
  }
  return null;
}

function setSelectedProvider(providerKey) {
  if (providerKey && PROVIDER_CONFIG[providerKey]) {
    providerSelector.value = providerKey;
    buildModelOptions(providerKey);
  }
}

function setSelectedModel(modelId) {
  if (!modelId) return;

  const provider = findProviderForModel(modelId);
  if (provider) {
    setSelectedProvider(provider);
    modelSelector.value = modelId;
    if (modelSelector.value !== modelId) {
      // Model not in list — append it
      const option = document.createElement('option');
      option.value = modelId;
      option.textContent = modelId;
      modelSelector.appendChild(option);
      modelSelector.value = modelId;
    }
  }
}

function setGenerateInFlight(inFlight) {
  isGenerating = inFlight;
  generateDarkModeBtn.disabled = inFlight;
  const icon = generateDarkModeBtn.querySelector('.btn-icon');
  if (inFlight) {
    if (icon) icon.style.display = 'none';
    generateDarkModeBtn.lastChild.textContent = 'Generating\u2026';
  } else {
    if (icon) icon.style.display = '';
    generateDarkModeBtn.lastChild.textContent = 'Generate dark mode';
  }
}

function shouldAttachGenerationScreenshot(provider) {
  return GENERATION_SCREENSHOT_PROVIDERS.has(provider);
}

async function captureGenerationScreenshot(windowId) {
  try {
    const rawDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 68,
    });
    return await compressGenerationScreenshot(rawDataUrl);
  } catch {
    return null;
  }
}

async function compressGenerationScreenshot(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }

  const sourceBlob = await dataUrlToBlob(dataUrl);
  const imageBitmap = await createImageBitmap(sourceBlob);
  const { width, height } = imageBitmap;
  const scale = Math.min(1, MAX_GENERATION_SCREENSHOT_DIMENSION / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    imageBitmap.close();
    return null;
  }
  ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);
  imageBitmap.close();

  let quality = 0.72;
  let blob = await canvasToBlob(canvas, 'image/webp', quality);
  while (blob && blob.size > MAX_GENERATION_SCREENSHOT_BYTES && quality > 0.42) {
    quality -= 0.1;
    blob = await canvasToBlob(canvas, 'image/webp', quality);
  }

  if (!blob || blob.size > MAX_GENERATION_SCREENSHOT_BYTES) return null;
  return blobToDataUrl(blob);
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function init() {
  buildProviderOptions();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-popup-state' });
    toggle.checked = Boolean(response.enabled);
    autoToggle.checked = Boolean(response.autoMode);
    twoPassToggle.checked = typeof response.twoPass === 'boolean' ? response.twoPass : true;
    setGenerationMode(response.generationMode);
    label.textContent = response.enabled ? 'On' : 'Off';
    autoLabel.textContent = response.autoMode ? 'On' : 'Off';
    twoPassLabel.textContent = twoPassToggle.checked ? 'On' : 'Off';
    setSelectedModel(response.selectedModel);
    feedbackText.value = response.feedbackText || '';
    feedbackImages = sanitizeFeedbackImages(response.feedbackImages);
    renderFeedbackImages();
    status.textContent = '';
    generationProgress.textContent = '';
  } catch (error) {
    status.textContent = 'Unable to load popup state';
  }
}

function setGenerationMode(nextMode) {
  generationMode = nextMode === 'thorough' ? 'thorough' : 'quick';
  for (const button of generationModeButtons) {
    const buttonMode = button.dataset.generationMode;
    const selected = buttonMode === generationMode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
}

async function saveState(partialState) {
  try {
    await chrome.runtime.sendMessage({ type: 'set-popup-state', ...partialState });
    status.textContent = 'Saved';
    setTimeout(() => {
      status.textContent = '';
    }, 900);
  } catch (error) {
    status.textContent = 'Failed to save changes';
  }
}

openSettingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  label.textContent = enabled ? 'On' : 'Off';
  await saveState({ enabled });
});

autoToggle.addEventListener('change', async () => {
  const autoMode = autoToggle.checked;
  autoLabel.textContent = autoMode ? 'On' : 'Off';
  await saveState({ autoMode });
});

twoPassToggle.addEventListener('change', async () => {
  const twoPass = twoPassToggle.checked;
  twoPassLabel.textContent = twoPass ? 'On' : 'Off';
  await saveState({ twoPass });
});

providerSelector.addEventListener('change', () => {
  const providerKey = providerSelector.value;
  buildModelOptions(providerKey);

  // Auto-select the provider's default model
  const config = PROVIDER_CONFIG[providerKey];
  if (config?.defaultModel) {
    modelSelector.value = config.defaultModel;
  }
  // Save the newly selected model
  saveState({ selectedModel: modelSelector.value });
});

modelSelector.addEventListener('change', async () => {
  await saveState({ selectedModel: modelSelector.value });
});

for (const button of generationModeButtons) {
  button.addEventListener('click', async () => {
    const selectedMode = button.dataset.generationMode;
    if (selectedMode !== 'quick' && selectedMode !== 'thorough') return;
    if (generationMode === selectedMode) return;
    setGenerationMode(selectedMode);
    generationProgress.textContent = '';
    await saveState({ generationMode: selectedMode });
  });
}

feedbackText.addEventListener('input', async () => {
  clearTimeout(feedbackSaveTimer);
  feedbackSaveTimer = setTimeout(() => {
    saveState({ feedbackText: feedbackText.value });
  }, 250);
});

feedbackText.addEventListener('paste', async (event) => {
  const clipboardItems = event.clipboardData?.items || [];
  const imageFiles = [];
  for (const item of clipboardItems) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) imageFiles.push(file);
  }

  if (!imageFiles.length) return;
  event.preventDefault();
  await addFeedbackImageFiles(imageFiles);
});

feedbackImageBtn.addEventListener('click', () => {
  feedbackImageInput.click();
});

feedbackImageInput.addEventListener('change', async () => {
  const files = Array.from(feedbackImageInput.files || []);
  feedbackImageInput.value = '';
  if (!files.length) return;
  await addFeedbackImageFiles(files);
});

generateDarkModeBtn.addEventListener('click', async () => {
  if (isGenerating) return;

  setGenerateInFlight(true);
  generationProgress.textContent = '';
  status.textContent = 'Generating dark mode\u2026';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!Number.isInteger(activeTab?.id)) {
      throw new Error('No active tab available');
    }
    const provider = providerSelector.value;
    const model = modelSelector.value;
    const screenshotDataUrl =
      shouldAttachGenerationScreenshot(provider) && Number.isInteger(activeTab?.windowId)
        ? await captureGenerationScreenshot(activeTab.windowId)
        : null;

    const request = generationMode === 'thorough'
      ? {
          type: 'generate-dark-mode-agent',
          tabId: activeTab.id,
          provider,
          model,
        }
      : {
          type: 'generate-dark-mode',
          tabId: activeTab.id,
          provider,
          model,
          twoPass: twoPassToggle.checked,
          screenshotDataUrl,
        };

    const result = await chrome.runtime.sendMessage(request);

    if (result?.skipped) {
      status.textContent = 'This site already has a dark mode';
      return;
    }
    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.css) {
      throw new Error('No CSS was generated');
    }

    const saved = await chrome.runtime.sendMessage({
      type: 'save-stored-style',
      url: activeTab.url,
      css: result.css,
      scope: 'domain',
      provider: result.provider,
      model: result.model,
    });
    if (!saved?.ok) {
      throw new Error(saved?.error || 'Generated CSS but could not save it');
    }

    status.textContent = 'Generated and saved';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Failed to generate dark mode';
  } finally {
    generationProgress.textContent = '';
    setGenerateInFlight(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'agent-progress') return;
  if (!isGenerating || generationMode !== 'thorough') return;

  const turn = Number(message.turn);
  const maxTurns = Number(message.maxTurns);
  if (!Number.isFinite(turn) || !Number.isFinite(maxTurns) || maxTurns <= 0) {
    generationProgress.textContent = '';
    return;
  }

  generationProgress.textContent = `Turn ${turn}/${maxTurns}\u2026`;
});

refineDarkModeBtn.addEventListener('click', async () => {
  if (isRefining) return;

  const feedback = feedbackText.value.trim();
  if (!feedback && feedbackImages.length === 0) {
    status.textContent = 'Enter feedback or attach a screenshot first';
    return;
  }

  isRefining = true;
  refineDarkModeBtn.disabled = true;
  const icon = refineDarkModeBtn.querySelector('.btn-icon');
  if (icon) icon.style.display = 'none';
  refineDarkModeBtn.lastChild.textContent = 'Refining\u2026';
  status.textContent = 'Refining dark mode\u2026';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!Number.isInteger(activeTab?.id)) {
      throw new Error('No active tab available');
    }

    const result = await chrome.runtime.sendMessage({
      type: 'refine-dark-mode',
      tabId: activeTab.id,
      provider: providerSelector.value,
      model: modelSelector.value,
      feedback,
      feedbackImages,
    });

    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.css) {
      throw new Error('No refined CSS was generated');
    }

    const saved = await chrome.runtime.sendMessage({
      type: 'save-stored-style',
      url: activeTab.url,
      css: result.css,
      scope: 'domain',
      provider: result.provider,
      model: result.model,
    });
    if (!saved?.ok) {
      throw new Error(saved?.error || 'Refined CSS generated but could not save it');
    }

    status.textContent = 'Refined and saved';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Failed to refine dark mode';
  } finally {
    isRefining = false;
    refineDarkModeBtn.disabled = false;
    if (icon) icon.style.display = '';
    refineDarkModeBtn.lastChild.textContent = 'Refine';
  }
});

function sanitizeFeedbackImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(
      (image) =>
        image &&
        typeof image === 'object' &&
        typeof image.id === 'string' &&
        typeof image.name === 'string' &&
        typeof image.mimeType === 'string' &&
        typeof image.dataUrl === 'string' &&
        typeof image.sizeBytes === 'number'
    )
    .slice(0, MAX_FEEDBACK_IMAGES);
}

function renderFeedbackImages() {
  feedbackImageList.innerHTML = '';
  for (const image of feedbackImages) {
    const item = document.createElement('div');
    item.className = 'feedback-image-item';

    const thumb = document.createElement('img');
    thumb.className = 'feedback-image-thumb';
    thumb.src = image.dataUrl;
    thumb.alt = image.name;

    const meta = document.createElement('div');
    meta.className = 'feedback-image-meta';

    const name = document.createElement('div');
    name.className = 'feedback-image-name';
    name.textContent = image.name;

    const size = document.createElement('div');
    size.className = 'feedback-image-size';
    size.textContent = formatBytes(image.sizeBytes);

    meta.append(name, size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'feedback-image-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      feedbackImages = feedbackImages.filter((candidate) => candidate.id !== image.id);
      renderFeedbackImages();
      await saveState({ feedbackImages });
    });

    item.append(thumb, meta, remove);
    feedbackImageList.appendChild(item);
  }
}

async function addFeedbackImageFiles(files) {
  for (const file of files) {
    if (feedbackImages.length >= MAX_FEEDBACK_IMAGES) {
      status.textContent = `Only ${MAX_FEEDBACK_IMAGES} screenshots can be attached`;
      break;
    }

    if (!file.type.startsWith('image/')) {
      status.textContent = 'Only image files are supported';
      continue;
    }

    let attachment;
    try {
      attachment = await createFeedbackImageAttachment(file);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Unable to attach image';
      continue;
    }

    feedbackImages.push(attachment);
  }

  renderFeedbackImages();
  await saveState({ feedbackImages });
}

async function createFeedbackImageAttachment(file) {
  const imageBitmap = await createImageBitmap(file);
  const { width, height } = imageBitmap;
  const scale = Math.min(1, MAX_FEEDBACK_IMAGE_DIMENSION / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to process screenshot');
  ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);
  imageBitmap.close();

  const blob = await canvasToBlob(canvas, 'image/webp', 0.85);
  if (!blob) throw new Error('Unable to encode screenshot');
  if (blob.size > MAX_FEEDBACK_IMAGE_BYTES) {
    throw new Error('Screenshot is too large after compression (max 1MB)');
  }

  return {
    id: getAttachmentId(),
    name: truncateName(file.name || 'screenshot.webp'),
    mimeType: blob.type || 'image/webp',
    sizeBytes: blob.size,
    dataUrl: await blobToDataUrl(blob),
  };
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mimeType, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read screenshot data'));
    reader.readAsDataURL(blob);
  });
}

function truncateName(name) {
  if (name.length <= IMAGE_NAME_MAX_LENGTH) return name;
  return `${name.slice(0, IMAGE_NAME_MAX_LENGTH - 3)}...`;
}

function getAttachmentId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

init();
