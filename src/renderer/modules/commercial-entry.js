(function () {
  const seenTurns = new Map();
  const seenMessages = new WeakSet();
  let dialog = null;
  const text = key => t(key);
  const isFailure = value => value?.ok === false && value?.code === 'E_COMMERCIAL_REQUIRED' && value?.feature === 'web_apps';
  function show() {
    if (dialog) return dialog;
    const focus = document.activeElement;
    dialog = (async () => {
      await uiAlert(text('app.vendor_services_unavailable'));
    })().finally(() => {
      dialog = null;
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    });
    return dialog;
  }
  function receipt(value, depth = 0) {
    if (depth > 3) return null;
    if (isFailure(value)) return value;
    if (typeof value === 'string' && value.length <= 65536) {
      try { return receipt(JSON.parse(value), depth + 1); } catch (_) { return null; }
    }
    if (value && typeof value === 'object') {
      if (typeof value.content === 'string') return receipt(value.content, depth + 1);
      if (Array.isArray(value.content)) {
        for (const part of value.content.slice(0, 8)) {
          if (part?.type === 'text') { const found = receipt(part.text, depth + 1); if (found) return found; }
        }
      }
    }
    return null;
  }
  function appendNotice(host) {
    const row = document.createElement('div');
    row.className = 'chat-app-nav-row';
    const label = document.createElement('span');
    label.dataset.i18n = 'app.vendor_services_unavailable';
    label.textContent = text('app.vendor_services_unavailable');
    row.append(label); host.appendChild(row);
    return row;
  }
  function observeToolResult(message, event) {
    const data = event?.data;
    if (event?.stream !== 'tool' || data?.phase !== 'end' || data.name !== 'create_artifact'
      || data.isError !== true || !receipt(data.output) || !message) return;
    const cid = message.dataset?.cid || (typeof currentCid === 'string' ? currentCid : '');
    const turn = message.dataset?.turnId;
    const key = turn ? JSON.stringify([cid, turn]) : null;
    if (key ? seenTurns.has(key) : seenMessages.has(message)) return;
    if (key) {
      seenTurns.set(key, true);
      if (seenTurns.size > 128) seenTurns.delete(seenTurns.keys().next().value);
    } else seenMessages.add(message);
    appendNotice(message.querySelector('.chat-bubble') || message);
  }
  window.OrkasCommercialEntry = { show, isFailure, appendNotice, observeToolResult };
})();
