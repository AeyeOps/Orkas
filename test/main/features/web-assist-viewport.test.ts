import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { attachWebAssistViewport, configureWebAssistViewport, setWebAssistViewport } from '../../../src/main/features/web_assist_viewport';

vi.mock('electron', async () => ({ ipcMain: new (await import('node:events')).EventEmitter() }));

function page(send: (...args: any[]) => void = () => {}) {
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { frameToken: 'main' }, ipc: new EventEmitter(), isDestroyed: () => destroyed, send: vi.fn(send),
  });
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  attachWebAssistViewport(contents as unknown as WebContents, 0.5);
  return { contents, event, set: (factor: number) => setWebAssistViewport(contents as unknown as WebContents, factor),
    ready: () => contents.ipc.emit('web-assist:viewport-ready', event()),
    ack: (revision: number) => contents.ipc.emit('web-assist:viewport-applied', event(), revision),
    destroy: () => { destroyed = true; contents.emit('destroyed'); } };
}
afterEach(() => vi.useRealTimers());

describe('task browser temporary viewport zoom', () => {
  it('coalesces rapid resizing behind one receipt and restores the final full-width layout', async () => {
    const p = page(); p.ready();
    const narrow = p.set(0.5);
    const first = p.contents.send.mock.calls[0][1];
    for (let i = 0; i < 1000; i++) expect(p.set(0.5 + i / 2000)).toBe(narrow);
    const full = p.set(1);
    expect(p.contents.send).toHaveBeenCalledTimes(1);
    p.ack(first);
    await vi.waitFor(() => expect(p.contents.send).toHaveBeenCalledTimes(2));
    expect(p.contents.send.mock.calls[1]).toEqual(['web-assist:viewport', first + 1, 1]);
    p.ack(first + 1);
    await full;
    p.destroy();
  });

  it('ignores child, foreign and stale receipts and recovers from timeout with a fresh revision', async () => {
    vi.useFakeTimers();
    const p = page(); p.ready();
    const failed = p.set(0.5);
    const rejected = expect(failed).rejects.toMatchObject({ code: 'browser_viewport_timeout' });
    p.contents.ipc.emit('web-assist:viewport-applied', { ...p.event(), senderFrame: { frameToken: 'child' } }, 1);
    p.contents.ipc.emit('web-assist:viewport-applied', { ...p.event(), sender: {} }, 1);
    p.contents.ipc.emit('web-assist:viewport-applied', p.event(), undefined);
    p.ack(0);
    await vi.runAllTimersAsync(); await rejected;
    const recovered = p.set(0.6); p.ack(1); p.ack(2); await recovered;
    expect(p.contents.send.mock.calls.at(-1)).toEqual(['web-assist:viewport', 2, 0.6]);
    p.destroy();
    expect(p.contents.ipc.listenerCount('web-assist:viewport-applied')).toBe(0);
  });

  it('waits for a replacement document before completing an interrupted resize', async () => {
    const p = page(); p.ready();
    const updated = p.set(0.5);
    p.contents.emit('did-start-navigation', {}, 'https://example.com/', false, true);
    p.contents.mainFrame = { frameToken: 'replacement' };
    await Promise.resolve(); await Promise.resolve();
    p.ready();
    await vi.waitFor(() => expect(p.contents.send).toHaveBeenCalledTimes(2));
    p.ack(2); await updated; p.destroy();
  });

  it('serves a resize on the surviving document when a navigation never commits', async () => {
    vi.useFakeTimers();
    const p = page(); p.ready();
    // A download link, a blocked scheme or a 204 starts a navigation that never replaces the document.
    p.contents.emit('did-start-navigation', {}, 'https://example.com/report.zip', false, true);
    const update = p.set(0.6);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.contents.send).toHaveBeenCalledExactlyOnceWith('web-assist:viewport', 1, 0.6);
    p.ack(1);
    await update;
    p.destroy();
  });

  it('does not treat an uncommitted navigation as acknowledgement of an in-flight resize', async () => {
    vi.useFakeTimers();
    const p = page(); p.ready();
    let completed = false;
    const update = p.set(0.6).then(() => { completed = true; });
    p.contents.emit('did-start-navigation', {}, 'https://example.com/report.zip', false, true);
    await vi.advanceTimersByTimeAsync(0);
    try {
      // The old document still exists, but has not acknowledged any new zoom.
      // Observation and input callers must continue waiting for a real receipt.
      expect(completed).toBe(false);
      expect(p.contents.send).toHaveBeenCalledTimes(2);
      p.ack(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(false);
      p.ack(2);
      await update;
      expect(completed).toBe(true);
    } finally { p.destroy(); await update.catch(() => {}); }
  });

  it('releases the synchronous factor call of a session window without a viewport at full scale', () => {
    configureWebAssistViewport(); configureWebAssistViewport();
    expect(ipcMain.listenerCount('web-assist:viewport-factor')).toBe(1);
    // Electron answers a synchronous message through contents.ipc first, then ipcMain.
    const factorOf = (event: any) => {
      event.sender.ipc.emit('web-assist:viewport-factor', event);
      ipcMain.emit('web-assist:viewport-factor', event);
      return event.returnValue;
    };
    const tunnel = Object.assign(new EventEmitter(), { ipc: new EventEmitter(), mainFrame: { frameToken: 'tunnel' } });
    expect(factorOf({ sender: tunnel, senderFrame: tunnel.mainFrame })).toBe(1);
    const p = page();
    expect(factorOf(p.event())).toBe(0.5);
    p.destroy();
    expect(factorOf(p.event())).toBe(1);
  });

  it('rejects destruction while waiting for the document without sending input or leaking listeners', async () => {
    const p = page(); const update = p.set(0.5); p.destroy();
    await expect(update).rejects.toThrow('browser_viewport_unavailable');
    expect(p.contents.send).not.toHaveBeenCalled();
    expect(p.contents.ipc.eventNames()).toEqual([]);
  });

  it('sets renderer temporary zoom before page scripts and keeps the host channel isolated', () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const setZoomFactor = vi.fn(), send = vi.fn();
    vm.runInNewContext(readFileSync(path.join(__dirname, '../../../src/main/features/web_assist_activity_preload.js'), 'utf8'), {
      process: { isMainFrame: true }, window: { addEventListener: () => {} },
      require: () => ({ webFrame: { setZoomFactor }, ipcRenderer: {
        send, sendSync: () => 0.5, on: (name: string, handler: (...args: any[]) => void) => listeners.set(name, handler),
      } }),
    });
    expect(setZoomFactor).toHaveBeenCalledWith(0.5);
    expect(send).toHaveBeenCalledWith('web-assist:viewport-ready');
    for (const value of [0, -1, 2, Infinity, '0.5']) listeners.get('web-assist:viewport')!({}, 1, value);
    expect(setZoomFactor).toHaveBeenCalledTimes(1);
    listeners.get('web-assist:viewport')!({}, 2, 0.6);
    expect(setZoomFactor).toHaveBeenLastCalledWith(0.6);
    expect(send).toHaveBeenLastCalledWith('web-assist:viewport-applied', 2);
  });
});
