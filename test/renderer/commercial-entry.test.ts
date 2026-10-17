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
  type = '';
  focus = vi.fn();
  events = new Map<string, () => unknown>();
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  querySelector() { return null; }
  addEventListener(name: string, handler: () => unknown) { this.events.set(name, handler); }
  async click() { await this.events.get('click')?.(); }
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
describe('commercial entry actions', () => {
  it('cancels without opening a link and restores the invoking control', async () => {
    const h = harness();
    await h.api.show();
    expect(h.confirm).toHaveBeenCalledWith({ message: h.table['apps.commercial_required'],
      okLabel: h.table['apps.commercial_download'], cancelLabel: h.table['common.cancel'] });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.focus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it.each(['zh', 'zh-tw', 'en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt', 'pt-pt', 'ru', 'es', 'es-419', 'th', 'tr', 'vi', 'ar'])('opens the official download page only after confirmation (%s)', async language => {
    const h = harness(language);
    h.confirm.mockResolvedValue(true);
    expect(h.invoke).not.toHaveBeenCalled();
    await h.api.show();
    const webLanguage = language.startsWith('zh') ? 'zh' : language.startsWith('pt') ? 'pt' : language === 'ja' ? 'ja' : 'en';
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('auth.openExternal', { url: `https://orkas.ai/download/?lang=${webLanguage}` });
    for (const key of ['apps.commercial_required', 'apps.commercial_download', 'apps.commercial_open_failed']) {
      expect(typeof h.table[key]).toBe('string'); expect(h.table[key].trim()).not.toBe('');
    }
  });
  it.each(['rejection', 'exception'])('keeps a failed opener recoverable without app operations: %s', async mode => {
    const h = harness(); h.confirm.mockResolvedValue(true);
    if (mode === 'exception') h.invoke.mockRejectedValueOnce(new Error('Fixture opener failure'));
    else h.invoke.mockResolvedValueOnce({ ok: false });
    await h.api.show();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(h.table['apps.commercial_open_failed']);
    await h.api.show();
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual(['auth.openExternal', 'auth.openExternal']);
  });
  it('coalesces simultaneous entry actions into one standard dialog', async () => {
    const h = harness(); let finish!: (accepted: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = h.api.show(), b = h.api.show();
    expect(a).toBe(b); expect(h.confirm).toHaveBeenCalledOnce();
    finish(false); await a; expect(h.invoke).not.toHaveBeenCalled();
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
    expect(row.children[0].textContent).toBe(h.table['apps.commercial_required']);
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    await row.children[1].click();
    expect(h.invoke).toHaveBeenCalledOnce();
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
