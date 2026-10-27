(function () {
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
  window.OrkasCommercialEntry = { show, isFailure };
})();
