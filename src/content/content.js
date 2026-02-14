// Darkside content script
// Injected into all pages; handles style extraction and CSS injection

const STYLE_ELEMENT_ID = 'darkside-styles';

function injectCSS(css) {
  let el = document.getElementById(STYLE_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function removeCSS() {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.remove();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'apply-css': (msg) => { injectCSS(msg.css); return { applied: true }; },
    'remove-css': () => { removeCSS(); return { removed: true }; },
    'extract-dom': () => extractDOM(),
  };

  const handler = handlers[message.type];
  if (handler) {
    sendResponse(handler(message));
  }
});

function extractDOM() {
  // Placeholder: will be implemented in darkside2-b53.2
  return {
    url: location.href,
    hostname: location.hostname,
    title: document.title,
  };
}
