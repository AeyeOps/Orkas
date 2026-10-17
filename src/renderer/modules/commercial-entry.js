(function () {
  const seenTurns = new Map();
  const seenMessages = new WeakSet();
  let dialog = null;
  const text = key => t(key);
  const isFailure = value => value?.ok === false && value?.code === 'E_COMMERCIAL_REQUIRED' && value?.feature === 'web_apps';
  function webLanguage() {
    const language = typeof getLang === 'function' ? getLang() : 'en';
    if (language === 'zh' || language === 'zh-tw') return 'zh';
    if (language === 'pt-pt') return 'pt';
    return ['en', 'ja', 'pt'].includes(language) ? language : 'en';
  }
  async function download() {
    const url = new URL('https://orkas.ai/download/');
    url.searchParams.set('lang', webLanguage());
    try {
      const result = await window.orkas.invoke('auth.openExternal', { url: url.href });
      if (!result?.ok) throw new Error('open_failed');
    } catch (_) { await uiAlert(text('apps.commercial_open_failed')); }
  }
  function show() {
    if (dialog) return dialog;
    const focus = document.activeElement;
    dialog = (async () => {
      if (await uiConfirm({ message: text('apps.commercial_required'),
        okLabel: text('apps.commercial_download'), cancelLabel: text('common.cancel') })) await download();
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
    label.dataset.i18n = 'apps.commercial_required';
    label.textContent = text('apps.commercial_required');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'chat-app-nav-btn';
    button.dataset.i18n = 'apps.commercial_download';
    button.textContent = text('apps.commercial_download');
    button.addEventListener('click', download);
    row.append(label, button); host.appendChild(row);
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
  window.OrkasCommercialEntry = { show, download, isFailure, appendNotice, observeToolResult };
})();
