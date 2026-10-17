// Sandboxed, isolated frame preload. No page API, input text or key data crosses IPC.
const { ipcRenderer, webFrame } = require('electron');
if (process.isMainFrame) {
  ipcRenderer.on('web-assist:viewport', (_event, revision, factor) => {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(factor) || factor <= 0 || factor > 1) return;
    webFrame.setZoomFactor(factor);
    ipcRenderer.send('web-assist:viewport-applied', revision);
  });
  // Renderer zoom is temporary and tab-scoped. Apply it before page scripts
  // see the viewport; the page receives no API or IPC access.
  const factor = ipcRenderer.sendSync('web-assist:viewport-factor');
  if (Number.isFinite(factor) && factor > 0 && factor <= 1) webFrame.setZoomFactor(factor);
  ipcRenderer.send('web-assist:viewport-ready');
}
let composing = false;
const report = (event, active) => {
  if (!event.isTrusted || composing === active) return;
  composing = active;
  ipcRenderer.send('web-assist:composition', active);
};
window.addEventListener('compositionstart', event => report(event, true), true);
window.addEventListener('compositionend', event => report(event, false), true);
// Chromium can commit text through a trusted input without a trusted
// compositionend (for example via its native text-insertion path).
window.addEventListener('input', event => {
  if (event.isComposing === false) report(event, false);
}, true);
window.addEventListener('pagehide', event => report(event, false), true);
// Electron's before-mouse-event does not cover native wheel events on macOS.
// Observe the input, not scroll: script-driven scrolling is not human activity.
window.addEventListener('wheel', event => {
  if (event.isTrusted) ipcRenderer.send('web-assist:wheel');
}, { capture: true, passive: true });
