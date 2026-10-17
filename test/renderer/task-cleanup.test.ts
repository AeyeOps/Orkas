import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';

function harness() {
  const listeners: Record<string, any> = {};
  const body = { innerHTML: '', addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, querySelector: () => null };
  const picker = { setOptions: vi.fn(), setAriaLabel: vi.fn(), close() {}, onChange(fn: any) { this.change = fn; }, change: null as any };
  const rows = [{ cid: 'one', title: '<unsafe title>', activeAt: '2020-01-01T00:00:00Z' },
    { cid: 'two', title: 'Second', activeAt: '2020-01-02T00:00:00Z' }];
  const invoke = vi.fn(async (channel: string, _payload?: any) => !channel.endsWith('remove')
    ? { ok: true, token: 'receipt', total: 2, rows, nextOffset: null }
    : { ok: true, status: 'deleted' });
  const store = new Map<string, string>();
  const refresh = vi.fn(); const forgot = vi.fn();
  const messages = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
  const scope: any = { currentUserId: 'u1', currentCid: '', conversations: [], currentView: 'settings',
    window: { orkas: { invoke }, TaskUnread: { list: () => [], isUnread: () => false },
      addEventListener() {}, initRecycleBin: refresh },
    document: { getElementById: (id: string) => id === 'settings-task-cleanup-body' ? body : {},
      querySelector: () => null },
    localStorage: { get length() { return store.size; }, key: (i: number) => [...store.keys()][i], getItem: (key: string) => store.get(key) ?? null },
    t: (key: string, vars: any = {}) => Object.entries(vars).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), messages[key] || key),
    escapeHtml: (v: string) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    _aiSelectMount: () => picker, _forgetConvLocal: forgot, loadConversations: refresh,
    _composerHoldsUnsentInput: () => false, _chatAttachList: () => [],
    createLogger: () => ({ warn: vi.fn() }), setTimeout, clearTimeout, Date,
  };
  vm.runInNewContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/task-cleanup.js'), 'utf8'), scope);
  const click = async (action: string, cid = '') => listeners.click({ target: { closest: () => ({ dataset: { cleanupAction: action, cid } }) } });
  const check = async (cid: string | null, checked: boolean) => listeners.change({ target: {
    checked, getAttribute: () => cid, hasAttribute: () => !cid,
  } });
  return { scope, body, invoke, store, picker, refresh, forgot, click, check,
    show: () => scope.window.initTaskCleanup() };
}
describe('inline history cleanup', () => {
  it('retries only failed tasks after a partial success', async () => {
    const h = harness(); await h.show();
    const original = h.invoke.getMockImplementation()!;
    let fail = true;
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove') && payload.cid === 'two' && fail) throw new Error('backup unavailable');
      return original(channel, payload);
    });
    await h.click('prepare'); await h.click('confirm');
    expect(h.body.innerHTML).toContain('Moved to recycle bin: 1. Skipped: 0. Failed: 1.');
    fail = false; await h.click('retry');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two', 'two']);
    expect(h.forgot.mock.calls.map(([cid]) => cid)).toEqual(['one', 'two']);
  });
  it('retains selection across pages and executes the frozen receipt once per selected task', async () => {
    const h = harness();
    const rows = Array.from({ length: 25 }, (_, n) => ({ cid: `task_${n}`, title: `Task ${n}`, activeAt: '2020-01-01' }));
    h.invoke.mockImplementation(async (channel, payload) => channel.endsWith('remove')
      ? { ok: true, status: 'deleted' } as any
      : { ok: true, token: 'frozen', total: 25, rows: rows.slice(payload.offset || 0, (payload.offset || 0) + 20), nextOffset: payload.offset === 20 ? null : 20 });
    await h.show(); await h.click('view'); await h.check('task_0', false);
    await h.click('next'); expect(h.body.innerHTML).toContain('Task 24');
    await h.check('task_24', false); await h.click('previous');
    expect(h.body.innerHTML).toContain('Selected tasks: 23');
    await h.click('prepare'); await h.click('confirm');
    const removals = h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p);
    expect(removals.map(p => p.cid)).toEqual(rows.slice(1, 24).map(row => row.cid));
    expect(removals.every(p => p.token === 'frozen')).toBe(true);
  });
  it('deselects all without fetching every page and cleans only a subsequent individual selection', async () => {
    const h = harness(); await h.show(); await h.check(null, false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await h.check('two', true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['two']);
  });
  it('stops between tasks and prevents duplicate confirmation while an item is being deleted', async () => {
    const h = harness(); await h.show();
    const original = h.invoke.getMockImplementation()!;
    let finish!: (value: any) => void;
    h.invoke.mockImplementation((channel, payload) => channel.endsWith('remove')
      ? new Promise(resolve => { finish = resolve; }) : original(channel, payload));
    await h.click('prepare'); const pending = h.click('confirm');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.body.innerHTML).toContain('Cleaning 0 / 2');
    expect(h.body.innerHTML.match(/role="status"/g)).toHaveLength(1);
    expect(h.body.innerHTML).not.toContain('Moved to recycle bin:');
    await h.click('confirm'); await h.click('stop');
    expect(h.body.innerHTML.match(/role="status"/g)).toHaveLength(1);
    finish({ ok: true, status: 'deleted' }); await pending;
    expect(h.body.innerHTML).toContain('Moved to recycle bin: 1. Skipped: 0. Failed: 0.');
    expect(h.body.innerHTML).not.toContain('Cleaning ');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(1);
    expect(h.forgot).toHaveBeenCalledWith('one');
  });
  it('shows a preview, confirms inline, cancels without deleting and escapes titles', async () => {
    const h = harness(); await h.show();
    expect(h.invoke.mock.calls[0][0]).toBe('conversations.cleanup.preview');
    expect(h.body.innerHTML).toContain('2');
    await h.click('view'); expect(h.body.innerHTML).toContain('&lt;unsafe title>');
    await h.click('prepare'); expect(h.body.innerHTML).toContain('data-cleanup-action="confirm"');
    await h.click('cancel'); expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.body.innerHTML).not.toContain('data-cleanup-action="confirm"');
  });
  it('cleans the selected snapshot and refreshes the recycle bin', async () => {
    const h = harness(); await h.show(); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two']);
    expect(h.forgot).toHaveBeenCalledWith('one'); expect(h.refresh).toHaveBeenCalled();
  });
  it('sends draft protection and rechecks newly unread tasks before deletion', async () => {
    const h = harness(); h.store.set('draft_other', JSON.stringify({ text: 'Keep me' })); await h.show();
    expect((h.invoke.mock.calls[0] as any)[1].protectedIds).toContain('other');
    await h.click('prepare'); h.scope.window.TaskUnread.isUnread = (cid: string) => cid === 'two';
    await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one']);
  });
  it('keeps failures visible and never reports a malformed response as success', async () => {
    const h = harness(); await h.show();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel: string, payload: any) => channel.endsWith('remove') ? { ok: true } as any : original(channel, payload));
    await h.click('prepare'); await h.click('confirm');
    expect(h.forgot).not.toHaveBeenCalled(); expect(h.body.innerHTML).toContain('2');
    expect(h.body.innerHTML).toContain('data-cleanup-action="retry"');
  });
  it('does not execute a previous account selection after an account switch', async () => {
    const h = harness(); await h.show(); await h.click('prepare'); h.scope.currentUserId = 'u2';
    await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
  });
  it('distinguishes a failed scan from an empty result and provides retry', async () => {
    const h = harness(); h.invoke.mockRejectedValueOnce(new Error('private path'));
    await h.show(); expect(h.body.innerHTML).toContain('data-cleanup-action="refresh"');
    expect(h.body.innerHTML).not.toContain('private path');
    expect(h.body.innerHTML).not.toContain('data-cleanup-action="prepare"');
  });
  it('translates every cleanup key in every supported locale', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
    const keys = Object.keys(en).filter(key => key.startsWith('settings.cleanup.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const { code } of LOCALES) {
      const messages = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${code}.json`), 'utf8'));
      for (const key of keys) expect(messages[key], `${code}: ${key}`).toBeTruthy();
    }
  });
});
