import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const start = source.indexOf('function _bindPersistedProcessPages(');
const end = source.indexOf('// ─── Quote-reply', start);
const binder = source.slice(start, end);
function harness(parts: unknown[]) {
  const rendered: string[] = [];
  const more: any = { attributes: {}, setAttribute(name: string, value: string) { this.attributes[name] = value; },
    classList: { add: vi.fn(), remove: vi.fn() }, addEventListener: vi.fn() };
  const context: any = { currentCid: 'task', document: { createElement: () => more },
    t: (key: string) => key, _createProcessDisplayContext: () => ({}), _projectIdForConversation: () => 'owner',
    _processItemsForDisplay: (items: unknown[]) => items,
    _projectProcessRow: (_event: unknown, _context: unknown, text: string) => text,
    _appendProjectedProcessRowToBody: (_body: unknown, text: string) => rendered.push(text),
    _convLog: { warn: vi.fn() }, encodeURIComponent };
  vm.createContext(context);
  vm.runInContext(binder, context);
  const details = { isConnected: true, appendChild() {} };
  const next = context._bindPersistedProcessPages({}, details, {}, parts);
  return { next, more, context, rendered, details };
}
const part = { ref: 'a'.repeat(64), message_id: 'message', count: 400 };
const response = (text: string, next_cursor: number | null) => ({ json: async () => ({ ok: true, items: [{ type: 'progress', text }], next_cursor }) });

describe('paged execution disclosure', () => {
  it('retries a failed page at the same cursor and preserves order across inline and deferred segments', async () => {
    const h = harness([{ ...part, leading_items: [{ type: 'progress', text: 'Earlier commentary' }] }, { items: [{ type: 'progress', text: 'Later segment' }] }]);
    const urls: string[] = [];
    h.context.apiFetch = async (url: string) => { urls.push(url); throw new Error('Unavailable'); };
    await h.next();
    expect(h.rendered).toEqual([]);
    expect(h.more.textContent).toBe('chat.history_retry_newer');
    h.context.apiFetch = async (url: string) => { urls.push(url); return response(url.includes('cursor=0') ? 'First page' : 'Second page', url.includes('cursor=0') ? 1 : null); };
    await h.next();
    await h.next();
    await h.next();
    expect(h.rendered).toEqual(['Earlier commentary', 'First page', 'Second page', 'Later segment']);
    expect(urls[0]).toBe(urls[1]);
    expect(h.more.hidden).toBe(true);
  });
  it('admits only one page at a time and retires a response when its task closes', async () => {
    const h = harness([part]);
    let resolve!: (value: unknown) => void;
    h.context.apiFetch = vi.fn(() => new Promise(r => { resolve = r; }));
    const loading = h.next();
    expect(h.more.attributes['aria-busy']).toBe('true');
    await h.next();
    expect(h.context.apiFetch).toHaveBeenCalledOnce();
    h.context.currentCid = 'another-task';
    resolve(response('Old task detail', null));
    await loading;
    expect(h.more.attributes['aria-busy']).toBe('false');
    expect(h.rendered).toEqual([]);
  });
  it('rejects a non-advancing cursor instead of duplicating the page', async () => {
    const h = harness([part]);
    h.context.apiFetch = async () => response('Duplicate detail', 0);
    await h.next();
    expect(h.rendered).toEqual([]);
    expect(h.more.textContent).toBe('chat.history_retry_newer');
    expect(h.more.disabled).toBe(false);
  });
});

const toggleStart = source.indexOf('async function _toggleToolResultRow(');
const toggle = source.slice(toggleStart, source.indexOf('async function _onToolResultRowClick', toggleStart));
function resultHarness() {
  function element() {
    const node: any = { className: '', isConnected: true, textContent: '', children: [], attributes: {}, listeners: {},
      appendChild(child: any) { this.children.push(child); },
      insertBefore(child: any, before: any) { this.children.splice(this.children.indexOf(before), 0, child); },
      addEventListener(name: string, listener: Function) { this.listeners[name] = listener; },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      remove() { this.isConnected = false; row.nextElementSibling = null; } };
    node.classList = { contains: (name: string) => node.className.split(' ').includes(name),
      add(name: string) { node.className += ` ${name}`; }, remove(name: string) { node.className = node.className.replace(` ${name}`, ''); } };
    return node;
  }
  const row: any = { dataset: { toolResultRef: 'bash.0123456789abcdef' }, isConnected: true,
    insertAdjacentElement(_position: string, pre: any) { this.nextElementSibling = pre; } };
  const context: any = { currentCid: 'task', document: { createElement: element }, window: { orkas: { invoke: vi.fn() } },
    t: (key: string) => key, _setExpandableProcessRowSemantics: vi.fn(), _compactAdjacentProcessRows: vi.fn() };
  vm.createContext(context); vm.runInContext(toggle, context);
  return { row, context, expand: () => context._toggleToolResultRow(row), invoke: context.window.orkas.invoke };
}

describe('paged complete tool output', () => {
  it('retains literal body chunks, retries at the same byte cursor and never admits duplicate concurrent reads', async () => {
    const h = resultHarness();
    const head = '🌟<script>window.leaked=true</script>';
    h.invoke.mockResolvedValueOnce({ ok: true, content: head, truncated: true, next_cursor: 256 });
    await h.expand();
    const pre = h.row.nextElementSibling;
    const more = pre.children[0];
    expect(pre.textContent).toBe(head);
    h.invoke.mockRejectedValueOnce(new Error('storage unavailable'));
    await more.listeners.click();
    expect(more.textContent).toBe('chat.history_retry_newer');
    expect(pre.textContent).toBe(head);
    expect(pre.children).toHaveLength(1);
    let release!: (res: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = more.listeners.click();
    await more.listeners.click();
    expect(h.invoke).toHaveBeenCalledTimes(3);
    expect(more.attributes['aria-busy']).toBe('true');
    release({ ok: true, content: '工具尾部🌟', truncated: false, next_cursor: null }); await pending;
    expect(h.invoke.mock.calls.slice(1).map((call: any[]) => call[1])).toEqual([
      { ref: 'bash.0123456789abcdef', cursor: 256 }, { ref: 'bash.0123456789abcdef', cursor: 256 }]);
    expect(pre.children[0].textContent).toBe('工具尾部🌟');
    expect(pre.children[0].innerHTML).toBeUndefined();
    expect(more.hidden).toBe(true);
    expect(more.attributes['aria-busy']).toBe('false');
  });
  it.each(['collapse', 'navigate'])('retires delayed output when the disclosure changes: %s', async change => {
    const h = resultHarness(); let release!: (res: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = h.expand(); const pre = h.row.nextElementSibling;
    if (change === 'collapse') await h.expand(); else h.context.currentCid = 'another-task';
    release({ ok: true, content: 'stale output', next_cursor: 200, truncated: true }); await pending;
    expect(pre.textContent).toBe(''); expect(pre.children).toEqual([]);
  });
  it('rejects a non-advancing continuation before displaying duplicate content', async () => {
    const h = resultHarness();
    h.invoke.mockResolvedValueOnce({ ok: true, content: 'duplicate', next_cursor: 0 });
    await h.expand();
    expect(h.row.nextElementSibling.textContent).toBe('');
    expect(h.row.nextElementSibling.children[0].textContent).toBe('chat.history_retry_newer');
  });
});
