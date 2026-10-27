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
  it('recognizes only an explicit publication refusal receipt', () => {
    const h = harness();
    expect(h.api.isFailure({ok:false, code:'E_COMMERCIAL_REQUIRED', feature:'web_apps'})).toBe(true);
    for (const value of ['Publish requires commercial Orkas', null, {ok:true,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'},
      {ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'other'}, {ok:false,code:'E_FAILED',feature:'web_apps'}]) expect(h.api.isFailure(value)).toBeFalsy();
  });
});
