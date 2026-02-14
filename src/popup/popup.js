const toggle = document.getElementById('toggle-dark-mode');
const autoToggle = document.getElementById('toggle-auto-mode');
const label = document.getElementById('toggle-label');
const autoLabel = document.getElementById('auto-toggle-label');
const modelSelector = document.getElementById('model-selector');
const modelStrongerBtn = document.getElementById('model-stronger-btn');
const modelResetBtn = document.getElementById('model-reset-btn');
const generateDarkModeBtn = document.getElementById('generate-dark-mode-btn');
const modelHint = document.getElementById('model-hint');
const feedbackText = document.getElementById('feedback-text');
const feedbackImageBtn = document.getElementById('feedback-image-btn');
const feedbackImageInput = document.getElementById('feedback-image-input');
const feedbackImageList = document.getElementById('feedback-image-list');
const status = document.getElementById('status');
let feedbackSaveTimer = null;
let feedbackImages = [];
let isGenerating = false;

const DEFAULT_MODEL = 'gpt-4.1-mini';
const MAX_FEEDBACK_IMAGES = 3;
const MAX_FEEDBACK_IMAGE_BYTES = 1000000;
const MAX_FEEDBACK_IMAGE_DIMENSION = 1600;
const IMAGE_NAME_MAX_LENGTH = 80;
const MODEL_STRENGTH_ORDER = [
  'gpt-4.1-mini',
  'gemini-2.0-flash',
  'gpt-4.1',
  'claude-3-5-sonnet-latest',
];
const MODEL_ALIASES = {
  'claude-3-5-sonnet': 'claude-3-5-sonnet-latest',
};

function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

function getSelectedModelLabel() {
  return modelSelector.options[modelSelector.selectedIndex]?.text || modelSelector.value;
}

function updateModelHint() {
  modelHint.textContent = `Current: ${getSelectedModelLabel()}`;
}

function setSelectedModel(model) {
  const normalizedModel = normalizeModel(model);
  modelSelector.value = normalizedModel;
  updateModelHint();
}

function setGenerateInFlight(inFlight) {
  isGenerating = inFlight;
  generateDarkModeBtn.disabled = inFlight;
  generateDarkModeBtn.textContent = inFlight ? 'Generating...' : 'Generate dark mode';
}

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-popup-state' });
    toggle.checked = Boolean(response.enabled);
    autoToggle.checked = Boolean(response.autoMode);
    label.textContent = response.enabled ? 'On' : 'Off';
    autoLabel.textContent = response.autoMode ? 'On' : 'Off';
    setSelectedModel(response.selectedModel);
    feedbackText.value = response.feedbackText || '';
    feedbackImages = sanitizeFeedbackImages(response.feedbackImages);
    renderFeedbackImages();
    status.textContent = '';
  } catch (error) {
    status.textContent = 'Unable to load popup state';
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

modelSelector.addEventListener('change', async () => {
  setSelectedModel(modelSelector.value);
  await saveState({ selectedModel: normalizeModel(modelSelector.value) });
});

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

modelStrongerBtn.addEventListener('click', async () => {
  const currentModel = normalizeModel(modelSelector.value);
  const currentIndex = MODEL_STRENGTH_ORDER.indexOf(currentModel);
  const nextModel =
    currentIndex === -1
      ? MODEL_STRENGTH_ORDER[MODEL_STRENGTH_ORDER.length - 1]
      : MODEL_STRENGTH_ORDER[Math.min(currentIndex + 1, MODEL_STRENGTH_ORDER.length - 1)];

  if (nextModel === currentModel) {
    status.textContent = 'Already using strongest quick-switch model';
    return;
  }

  setSelectedModel(nextModel);
  await saveState({ selectedModel: nextModel });
});

modelResetBtn.addEventListener('click', async () => {
  const currentModel = normalizeModel(modelSelector.value);
  if (currentModel === DEFAULT_MODEL) {
    status.textContent = 'Already using default model';
    return;
  }

  setSelectedModel(DEFAULT_MODEL);
  await saveState({ selectedModel: DEFAULT_MODEL });
});

generateDarkModeBtn.addEventListener('click', async () => {
  if (isGenerating) return;

  setGenerateInFlight(true);
  status.textContent = 'Generating dark mode...';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!Number.isInteger(activeTab?.id)) {
      throw new Error('No active tab available');
    }

    const result = await chrome.runtime.sendMessage({
      type: 'generate-dark-mode',
      tabId: activeTab.id,
      model: normalizeModel(modelSelector.value),
    });

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
    });
    if (!saved?.ok) {
      throw new Error(saved?.error || 'Generated CSS but could not save it');
    }

    status.textContent = 'Generated and saved';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Failed to generate dark mode';
  } finally {
    setGenerateInFlight(false);
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
