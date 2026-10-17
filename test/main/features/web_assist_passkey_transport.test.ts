import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let next = 1;
  class Window extends EventEmitter {
    dead = false; setMenu = vi.fn();
    webContents = Object.assign(new EventEmitter(), { id: next++, mainFrame: { url: '' }, send: vi.fn(), setWindowOpenHandler: vi.fn() });
    constructor(public options: any) { super(); runtime.windows.push(this); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadFile(file: string) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter() };
});
import { ipcMain } from 'electron';
import { configurePasskeyTransportSession, createPasskeyTransport, safePasskeyTunnelUrl } from '../../../src/main/features/web_assist_passkey_transport';
const url = 'wss://cable.auth.com/cable/connect/010203/00000000000000000000000000000000';
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); runtime.windows.length = 0;
  expect(ipcMain.listenerCount('web-assist-passkey-transport:event')).toBe(0); });
function open() {
  let headers: any;
  const session = { webRequest: { onBeforeSendHeaders: vi.fn((fn: any) => { headers = fn; }) } };
  configurePasskeyTransportSession(session as any);
  configurePasskeyTransportSession(session as any);
  expect(session.webRequest.onBeforeSendHeaders).toHaveBeenCalledOnce();
  const options = { session: session as any, url, receive: vi.fn(), unavailable: vi.fn(), attachProxy: vi.fn() };
  const transport = createPasskeyTransport(options); disposers.push(transport.destroy);
  const window = runtime.windows.at(-1);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { session, options, transport, window, event, headers };
}
describe('Session-bound phone passkey tunnel', () => {
  it('rejects tunnel URL look-alikes, non-TLS endpoints and arbitrary requests', () => {
    expect(safePasskeyTunnelUrl(url)).toBe(url);
    for (const raw of [url.replace('wss:', 'ws:'), url.replace('cable.auth.com', 'cable.auth.com.evil.test'), `${url}?secret=1`,
      url.replace('/connect/', '/new/'), url.replace('cable.auth.com', 'user@cable.auth.com'), url.replace('cable.auth.com', 'cable.auth.com:444')]) expect(safePasskeyTunnelUrl(raw)).toBeNull();
  });
  it('inherits proxy policy and credentials, changes Origin only for its owned WebSocket and leaves page headers alone', () => {
    const { session, options, window, headers, transport } = open();
    expect(window.options.webPreferences).toMatchObject({ session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(options.attachProxy).toHaveBeenCalledWith(window.webContents);
    const details = { webContentsId: window.webContents.id, url, resourceType: 'webSocket', requestHeaders: { origin: 'null', 'Sec-WebSocket-Protocol': 'fido.cable' } };
    const callback = vi.fn(); headers(details, callback);
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: { Origin: 'wss://cable.auth.com', 'Sec-WebSocket-Protocol': 'fido.cable' } });
    for (const variation of [{ ...details, webContentsId: 9999 }, { ...details, url: `${url}other` }, { ...details, resourceType: 'xhr' }]) {
      headers(variation, callback); expect(callback).toHaveBeenLastCalledWith({});
    }
    transport.destroy(); headers(details, callback); expect(callback).toHaveBeenLastCalledWith({});
  });
  it('rejects foreign/frame IPC, relays encrypted bytes and tears down an unavailable transport without leaking listeners', () => {
    const { options, window, event, transport } = open();
    ipcMain.emit('web-assist-passkey-transport:ready', { ...event, senderFrame: {} });
    expect(window.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit('web-assist-passkey-transport:ready', event);
    expect(window.webContents.send).toHaveBeenCalledWith('web-assist-passkey-transport:open', url);
    ipcMain.emit('web-assist-passkey-transport:event', event, { type: 'ws-message', hex: '010203' });
    expect(options.receive).toHaveBeenCalledWith({ type: 'ws-message', hex: '010203' });
    transport.send('0102'); expect(window.webContents.send).toHaveBeenLastCalledWith('web-assist-passkey-transport:send', '0102');
    ipcMain.emit('web-assist-passkey-transport:event', event, { type: 'ws-message', hex: 'wrong' });
    expect(options.unavailable).toHaveBeenCalledOnce(); expect(window.dead).toBe(true);
    transport.send('0102'); expect(options.unavailable).toHaveBeenCalledOnce();
  });
});
