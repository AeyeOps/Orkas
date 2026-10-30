import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.resolve('src/renderer/modules/commercial-entry.js'), 'utf8');
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  isConnected = true;
  textContent = '';
  className = '';
  focus = vi.fn();
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  querySelector() { return null; }
}
function harness(language = 'en') {
  const focus = new Element();
  const invoke = vi.fn(async () => ({ ok: true }));
  const confirm = vi.fn(async () => false);
  const alert = vi.fn(async () => {});
  const table = JSON.parse(fs.readFileSync(path.resolve(`src/renderer/locales/${language}.json`), 'utf8'));
  const context = { window: { orkas: { invoke } } as any, currentCid: 'task', URL,
    document: { activeElement: focus, createElement: () => new Element() },
    getLang: () => language, t: (key: string) => table[key] || key, uiConfirm: confirm, uiAlert: alert };
  vm.runInNewContext(source, context);
  return { api: context.window.OrkasCommercialEntry, invoke, confirm, alert, focus, table };
}
describe('unavailable vendor feature notices', () => {
  it('explains the unavailable feature and restores the invoking control', async () => {
    const h = harness();
    await h.api.show();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(h.table['app.vendor_services_unavailable']);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.focus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it.each(['zh', 'zh-tw', 'en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt', 'pt-pt', 'ru', 'es', 'es-419', 'th', 'tr', 'vi', 'ar'])('uses the localized notice without offering a vendor link (%s)', async language => {
    const h = harness(language);
    await h.api.show();
    expect(h.table['app.vendor_services_unavailable']).toEqual(expect.any(String));
    expect(h.table['app.vendor_services_unavailable'].trim()).not.toBe('');
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(h.table['app.vendor_services_unavailable']);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each(['rejection', 'exception'])('restores focus and allows another notice after an alert %s', async mode => {
    const h = harness();
    const error = new Error('Fixture alert failure');
    if (mode === 'exception') h.alert.mockImplementationOnce(() => { throw error; });
    else h.alert.mockRejectedValueOnce(error);
    await expect(h.api.show()).rejects.toBe(error);
    expect(h.focus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await h.api.show();
    expect(h.alert).toHaveBeenCalledTimes(2);
    expect(h.focus.focus).toHaveBeenCalledTimes(2);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous entry actions into one standard dialog', async () => {
    const h = harness(); let finish!: () => void;
    h.alert.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = h.api.show(), b = h.api.show();
    expect(a).toBe(b); expect(h.alert).toHaveBeenCalledOnce();
    finish(); await a; expect(h.invoke).not.toHaveBeenCalled();
  });
  it('shows one independent notice per turn for the structured rejected tool receipt', async () => {
    const h = harness();
    const receipt = { ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps', message: 'Model may omit this message' };
    const event = { stream: 'tool', data: { phase: 'end', name: 'create_artifact', isError: true, output: JSON.stringify(receipt) } };
    const first = new Element(), second = new Element();
    first.dataset.turnId = second.dataset.turnId = 'same-turn';
    h.api.observeToolResult(first, event); h.api.observeToolResult(first, event); h.api.observeToolResult(second, event);
    expect(first.children).toHaveLength(1); expect(second.children).toHaveLength(0);
    const row = first.children[0];
    expect(row.className).toBe('chat-app-nav-row');
    expect(row.children[0].textContent).toBe(h.table['app.vendor_services_unavailable']);
    expect(row.children[0].dataset.i18n).toBe('app.vendor_services_unavailable');
    expect(row.children).toHaveLength(1);
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    const next = new Element(); next.dataset.turnId = 'next-turn'; h.api.observeToolResult(next, event);
    expect(next.children).toHaveLength(1);
  });
  it('does not interpret model text, ordinary errors, successful tools or foreign features as authority', () => {
    const h = harness(); const message = new Element();
    for (const output of ['Web apps require commercial Orkas', '{bad JSON', JSON.stringify({ code: 'E_FAILED' }),
      JSON.stringify({ ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'other' }),
      JSON.stringify({ ok: true, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' }),
      JSON.stringify({ code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' })]) {
      h.api.observeToolResult(message, { stream: 'tool', data: { phase: 'end', name: 'create_artifact', isError: true, output } });
    }
    const output = JSON.stringify({ code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' });
    h.api.observeToolResult(message, { stream: 'tool', data: { phase: 'end', name: 'read_files', isError: true, output } });
    h.api.observeToolResult(message, { stream: 'tool', data: { phase: 'end', name: 'create_artifact', isError: false, output } });
    expect(message.children).toHaveLength(0); expect(h.invoke).not.toHaveBeenCalled();
  });
});
