/* Inline Settings > Data cleanup. Preview receipts belong to one account;
 * selection stays frozen while confirming and executing. */
(() => {
  let owner = '', days = 90, token = '', total = 0, rows = [], offset = 0, nextOffset = null;
  let expanded = false, confirming = false, busy = false, loading = false, stopped = false;
  let allSelected = true, excluded = new Set(), result = null, failed = [], error = false, picker = null, bound = false;
  const log = createLogger('task-cleanup');
  const user = () => typeof currentUserId === 'string' ? currentUserId : '';
  const body = () => document.getElementById('settings-task-cleanup-body');
  const selectedCount = () => allSelected ? total - excluded.size : excluded.size;
  const isSelected = cid => allSelected !== excluded.has(cid);
  const aliases = { retry: 'chat.retry_btn', stop: 'chat.task_stop', loading: 'common.loading', refresh: 'common.refresh', view: 'settings.recycle.view', collapse: 'settings.recycle.collapse', cancel: 'common.cancel', confirm_title: 'settings.cleanup.title' };
  const tr = (key, values) => key === 'all' ? `${t('chat.message_select_all')} (${values.n})`
    : key === 'page' ? `${values.from}–${values.to} / ${values.n}`
      : t(aliases[key] || `settings.cleanup.${key}`, values);
  const esc = value => escapeHtml(String(value));
  const button = (action, label, disabled = false, danger = false) =>
    `<button type="button" class="btn btn-sm${danger ? ' btn-danger' : ''}" data-cleanup-action="${action}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
  const options = () => [30, 90, 180].map(n => ({ value: String(n), label: tr('days', { n }) }));
  function protectedIds() {
    const ids = new Set((window.TaskUnread?.list?.() || []).map(row => row.cid));
    // Drafts are owned by the composer and may belong to unloaded task pages.
    // Storage failure blocks cleanup rather than treating unknown as empty.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const match = /^draft_([A-Za-z0-9_-]+)(:queue-edit)?$/.exec(key || '');
      if (!match) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let draft;
      try { draft = JSON.parse(raw); } catch (_) { ids.add(match[1]); continue; }
      if (match[2] || draft?.text?.trim() || draft?.references?.length) ids.add(match[1]);
    }
    if (typeof _chatAttachments !== 'undefined') {
      for (const [cid, items] of _chatAttachments) if (items.length) ids.add(cid);
    }
    if (typeof currentCid === 'string' && currentCid && typeof _composerHoldsUnsentInput === 'function'
        && _composerHoldsUnsentInput(currentCid)) ids.add(currentCid);
    return [...ids].filter(cid => /^[A-Za-z0-9_-]+$/.test(cid));
  }
  function protectedNow(cid) {
    return window.TaskUnread?.isUnread?.(cid)
      || (typeof _composerHoldsUnsentInput === 'function' && _composerHoldsUnsentInput(cid))
      || (typeof _chatAttachList === 'function' && _chatAttachList(cid).length);
  }
  async function invoke(action, payload) {
    if (!owner || owner !== user()) throw new Error('cleanup_account_changed');
    const expectedOwner = owner;
    const response = await window.orkas.invoke(`conversations.cleanup.${action}`, { ...payload, expectedUserId: expectedOwner });
    if (expectedOwner !== user() || owner !== expectedOwner) throw new Error('cleanup_account_changed');
    if (!response || response.ok !== true) throw new Error('cleanup_failed');
    return response;
  }
  function render() {
    const host = body(); if (!host) return;
    picker?.setOptions(options(), { value: String(days) });
    picker?.setAriaLabel(tr('age'));
    const trigger = document.getElementById('settings-task-cleanup-age')?.querySelector?.('.ai-select-trigger');
    if (trigger) trigger.disabled = busy || loading || confirming;
    const selected = Math.max(0, selectedCount());
    let html = '';
    if (result && !busy) html += `<div class="settings-row" role="status"><span class="settings-row-desc">${esc(tr('result', result))}</span>${failed.length && !busy ? button('retry', tr('retry')) : ''}</div>`;
    if (busy) {
      html += `<div class="settings-row" role="status"><span>${esc(tr('progress', { done: result.done, total: result.total }))}</span>${button('stop', tr('stop'), stopped)}</div>`;
    } else if (loading) {
      html += `<div class="settings-row" role="status">${esc(tr('loading'))}</div>`;
    } else if (error) {
      html += `<div class="settings-row" role="alert"><span class="settings-row-desc">${esc(tr('error'))}</span>${button('refresh', tr('refresh'))}</div>`;
    } else {
      html += `<div class="settings-row"><span class="settings-row-desc" role="status">${esc(total ? tr('count', { n: selected }) : tr('empty'))}</span><div class="settings-cleanup-actions">${total ? button('view', tr(expanded ? 'collapse' : 'view'), confirming) : ''}${button('prepare', tr('clean'), !selected || confirming, true)}</div></div>`;
      if (expanded && total) {
        html += `<div class="settings-cleanup-list"><label class="settings-cleanup-item"><input type="checkbox" data-cleanup-all${selectedCount() === total ? ' checked' : ''}${confirming ? ' disabled' : ''}><span>${esc(tr('all', { n: total }))}</span></label>`;
        for (const row of rows) html += `<label class="settings-cleanup-item"><input type="checkbox" data-cleanup-cid="${esc(row.cid)}"${isSelected(row.cid) ? ' checked' : ''}${confirming ? ' disabled' : ''}><span class="settings-cleanup-title">${esc(row.title)}</span><time class="settings-row-desc">${esc(new Date(row.activeAt).toLocaleDateString())}</time></label>`;
        html += `</div><div class="settings-sheet-foot"><span>${esc(tr('page', { from: offset + 1, to: offset + rows.length, n: total }))}</span><div class="settings-cleanup-actions">${button('previous', tr('previous'), offset === 0 || confirming)}${button('next', tr('next'), nextOffset === null || confirming)}</div></div>`;
      }
      if (confirming) html += `<div class="settings-row settings-row-stack" role="group" aria-label="${esc(tr('confirm_title'))}"><p class="settings-row-desc">${esc(tr('confirm', { n: selected }))}</p><div class="settings-cleanup-actions">${button('cancel', tr('cancel'))}${button('confirm', tr('move', { n: selected }), !selected, true)}</div></div>`;
    }
    host.innerHTML = html;
  }
  async function refresh(keepResult = false) {
    if (busy || loading) return;
    loading = true; error = false; confirming = false;
    if (!keepResult) { result = null; failed = []; }
    render();
    try {
      const p = await invoke('preview', { days, protectedIds: protectedIds() });
      if (!Array.isArray(p.rows) || !Number.isSafeInteger(p.total) || typeof p.token !== 'string') throw new Error('invalid_preview');
      token = p.token; total = p.total; rows = p.rows; offset = 0; nextOffset = p.nextOffset; excluded = new Set(); allSelected = true;
    } catch (_) { error = true; token = ''; total = 0; rows = []; }
    finally { loading = false; render(); }
  }
  async function changePage(next) {
    if (loading || busy || confirming) return;
    loading = true; render();
    try {
      const p = await invoke('page', { token, offset: next });
      rows = p.rows; offset = next; nextOffset = p.nextOffset;
    } catch (_) { error = true; }
    finally { loading = false; render(); }
  }
  async function run(retry = false) {
    if (busy || loading || owner !== user() || (!retry && !confirming)) return;
    busy = true; confirming = false; stopped = false; error = false;
    const operationOwner = owner;
    const retryIds = failed.slice(); failed = [];
    result = { deleted: 0, skipped: 0, failed: 0, done: 0, total: retry ? retryIds.length : selectedCount() };
    render();
    try {
      // Page the frozen receipt, never a live query that could add new tasks.
      let next = 0;
      do {
        const p = retry ? { rows: retryIds.map(cid => ({ cid })), nextOffset: null }
          : await invoke('page', { token, offset: next });
        for (const row of p.rows) {
          if (stopped || operationOwner !== user()) break;
          if (!retry && !isSelected(row.cid)) continue;
          try {
            if (protectedNow(row.cid)) { result.skipped++; }
            else {
              const response = await invoke('remove', { token, cid: row.cid });
              if (!['deleted', 'skipped'].includes(response.status)) throw new Error('invalid_cleanup_result');
              result[response.status]++;
              if (response.status === 'deleted' && typeof _forgetConvLocal === 'function') _forgetConvLocal(row.cid);
            }
          } catch (_) { result.failed++; failed.push(row.cid); }
          result.done++; render();
        }
        next = p.nextOffset;
      } while (!retry && next !== null && !stopped && operationOwner === user());
    } catch (_) { error = true; }
    finally {
      busy = false;
      if (operationOwner === user()) {
        window.initRecycleBin?.();
        if (typeof loadConversations === 'function') {
          try { await loadConversations(); } catch (_) { log.warn('cleanup navigation refresh failed'); }
        }
        // Preserve the receipt for failed-only retries. A fresh filter or
        // explicit refresh creates a new receipt after the user sees results.
        if (!failed.length && !error) await refresh(true);
        else render();
      } else { owner = ''; token = ''; total = 0; rows = []; result = null; failed = []; render(); }
    }
  }
  async function click(event) {
    const action = event.target.closest('[data-cleanup-action]')?.dataset.cleanupAction;
    if (action === 'stop') { stopped = true; render(); return; }
    if (busy || loading) return;
    if (action === 'view') { expanded = !expanded; render(); }
    if (action === 'prepare' && token && selectedCount() > 0) { confirming = true; render(); body().querySelector('[data-cleanup-action="cancel"]')?.focus(); }
    if (action === 'cancel') { confirming = false; render(); body().querySelector('[data-cleanup-action="prepare"]')?.focus(); }
    if (action === 'confirm') await run();
    if (action === 'retry') await run(true);
    if (action === 'refresh') await refresh();
    if (action === 'previous') await changePage(Math.max(0, offset - 20));
    if (action === 'next' && nextOffset !== null) await changePage(nextOffset);
  }
  async function change(event) {
    if (busy || loading || confirming) return;
    const cid = event.target.getAttribute('data-cleanup-cid');
    if (cid) {
      if (event.target.checked === allSelected) excluded.delete(cid); else excluded.add(cid);
    } else if (event.target.hasAttribute('data-cleanup-all')) {
      allSelected = event.target.checked; excluded.clear();
    }
    render();
  }

  window.initTaskCleanup = async function () {
    if (!body() || !user()) return;
    if (!bound) {
      body().addEventListener('click', click); body().addEventListener('change', change); bound = true;
      picker = _aiSelectMount(document.getElementById('settings-task-cleanup-age'), {
        options: options(), value: String(days), ariaLabel: tr('age'),
      });
      picker.onChange(value => { if (!busy && !loading && !confirming) { days = Number(value); refresh(); } });
    }
    if (owner !== user()) { owner = user(); token = ''; excluded.clear(); result = null; failed = []; confirming = false; }
    if (!busy && !loading && !confirming) await refresh();
  };
  window.addEventListener('i18n-change', render);
  if (document.querySelector('[data-settings-tab="data"].is-active')) window.initTaskCleanup();
})();
