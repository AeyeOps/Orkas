(() => {
  const find = id => document.getElementById(id);
  find('camera').innerHTML = window.uiIconHtml('camera');
  find('phone').innerHTML = window.uiIconHtml('smartphone', 'ui-icon passkey-phone');
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    find('cancel').disabled = true;
    window.phonePasskeyDialog.cancel();
  };
  find('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  window.phonePasskeyDialog.onUpdate(state => {
    find('dialog').dataset.phase = state.phase;
    document.documentElement.lang = state.lang;
    document.documentElement.dir = state.dir;
    document.title = state.copy.title;
    for (const id of ['title', 'heading', 'instruction', 'nearby', 'cancel']) find(id).textContent = state.copy[id];
    find('status').textContent = state.copy[state.phase];
    find('status').hidden = state.phase === 'scan';
    find('nearby').hidden = state.phase === 'scan';
    const showQr = state.phase === 'scan' && state.qr.startsWith('data:image/svg+xml;base64,');
    find('qr').hidden = !showQr;
    find('qr').alt = state.copy.qr_alt;
    if (showQr) find('qr').src = state.qr;
    else find('qr').removeAttribute('src');
    find('waiting').hidden = showQr;
    if (document.activeElement === document.body) find('cancel').focus();
  });
})();
