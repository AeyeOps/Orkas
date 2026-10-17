// Trusted renderer adapter. Generated frames never receive window.orkas.
(function () {
  'use strict';
  const bindings = new Map();
  const opening = new WeakMap();
  function release(frame) {
    opening.delete(frame);
    const b = bindings.get(frame); if (!b) return;
    bindings.delete(frame);
    for (const stream of b.streams.values()) stream.cancel();
    window.orkas.invoke('webApps.close', { token: b.token }).catch(() => {});
  }
  function attach(frame, info) {
    release(frame);
    frame._orkasUsesSdk = !!info.token && !info.browserOnly;
    if (!info.token) { frame.src = info.url; return; }
    const parsed = new URL(info.url);
    const b = { sdk: frame._orkasUsesSdk, token: info.token, origin: parsed.protocol + '//' + parsed.host, streams: new Map() };
    bindings.set(frame, b);
    frame.src = info.url;
  }
  async function canSubmitArtifact(frame) {
    const b = bindings.get(frame);
    if (!b || !b.sdk || !frame.isConnected) return false;
    try {
      const result = await window.orkas.invoke('webApps.canSubmitArtifact', { token: b.token });
      return result?.ok === true && result.allowed === true && bindings.get(frame) === b && frame.isConnected;
    } catch { return false; }
  }
  async function open(frame, source) {
    release(frame);
    const generation = {}; opening.set(frame, generation);
    try {
      const r = await window.orkas.invoke('webApps.open', { source });
      if (opening.get(frame) !== generation || !frame.isConnected) {
        if (r.token) window.orkas.invoke('webApps.close', { token: r.token }).catch(() => {});
        return;
      }
      if (!r.ok) throw Object.assign(new Error(r.error || 'Application unavailable'), r);
      attach(frame, r);
    } catch (error) {
      if (opening.get(frame) !== generation || !frame.isConnected) return;
      frame.removeAttribute('src');
      // Fail closed for an invalid SDK manifest, never downgrade to the old origin.
      const commercial = window.OrkasCommercialEntry?.isFailure(error);
      const unhandled = frame.dispatchEvent(new CustomEvent('orkas-app-error', { detail: commercial ? error : error.message, cancelable: true }));
      if (unhandled && typeof uiAlert === 'function') uiAlert(error.message);
    }
  }
  window.addEventListener('message', event => {
    const d = event.data;
    if (!d || d.__orkasApp !== 1 || typeof d.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(d.id)) return;
    const entry = [...bindings.entries()].find(([frame, b]) => b.sdk && frame.isConnected && frame.contentWindow === event.source && b.origin === event.origin);
    if (!entry) return;
    const [frame, b] = entry;
    const reply = (type, extra) => {
      if (bindings.get(frame) !== b || !frame.isConnected) return;
      frame.contentWindow.postMessage({ __orkasApp: 1, id: d.id, type, ...extra }, b.origin);
    };
    if (d.type === 'cancel') {
      b.streams.get(d.id)?.cancel();
      window.orkas.invoke('webApps.cancel', { token: b.token, requestId: d.id }).catch(() => {});
      return;
    }
    if (d.type !== 'call' || typeof d.method !== 'string') return;
    if (b.streams.has(d.id)) {
      reply('result', { ok: false, value: { code: 'E_LIMIT' } }); return;
    }
    reply('ack', {});
    let terminal = false;
    const stream = window.orkas.stream('webApps.call', { token: b.token, requestId: d.id, method: d.method, args: d.args }, ev => {
      if (ev.type === 'progress') reply('progress', { value: ev.value });
      else if (ev.type === 'result') { terminal = true; reply('result', { ok: ev.ok, value: ev.value }); }
      else if (ev.type === 'error') { terminal = true; reply('result', { ok: false, value: { code: 'E_FAILED' } }); }
    });
    b.streams.set(d.id, stream);
    stream.promise.catch(() => {}).finally(() => {
      b.streams.delete(d.id);
      if (!terminal) reply('result', { ok: false, value: { code: 'E_CANCELLED' } });
    });
  });
  new MutationObserver(() => {
    for (const frame of bindings.keys()) if (!frame.isConnected || !frame.getAttribute('src')) release(frame);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  window.addEventListener('pagehide', () => { for (const frame of bindings.keys()) release(frame); });
  window.OrkasWebAppHost = { open, attach, release, canSubmitArtifact, isManaged: frame => !!frame._orkasUsesSdk };
})();
