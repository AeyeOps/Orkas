import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, type Session, type WebContents, type IpcMainEvent } from 'electron';
import { hardenedWebPreferences } from '../util/window-security';

const sessions = new WeakMap<Session, Map<number, string>>();

export function safePasskeyTunnelUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'wss:' || !['cable.auth.com', 'cable.ua5v.com'].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !/^\/cable\/connect\/[A-F0-9]{6}\/[A-F0-9]{32}$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

/** Installed once alongside the browser Session's existing request readiness gate. */
export function configurePasskeyTransportSession(ses: Session): void {
  if (sessions.has(ses)) return;
  const urls = new Map<number, string>();
  sessions.set(ses, urls);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const tunnel = urls.get(details.webContentsId);
    if (tunnel && details.url === tunnel && details.resourceType === 'webSocket') {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'origin') delete headers[key];
      headers.Origin = new URL(tunnel).origin;
      callback({ requestHeaders: headers });
    } else callback({});
  });
}

/** A sandboxed, hidden Chromium WebSocket inherits the exact tab's Session,
 * including PAC, proxy authentication and certificate policy. No TCP listener. */
export function createPasskeyTransport(options: {
  session: Session;
  attachProxy: (contents: WebContents) => void;
  url: string;
  receive: (value: { type: string; hex?: string }) => void;
  unavailable: () => void;
}) {
  const url = safePasskeyTunnelUrl(options.url);
  if (!url || !sessions.has(options.session)) throw new Error('Passkey tunnel unavailable');
  const documentPath = path.join(__dirname, '../../renderer/views/browser-passkey/transport.html');
  const documentUrl = pathToFileURL(documentPath).href;
  const win = new BrowserWindow({ show: false, webPreferences: hardenedWebPreferences({
    session: options.session, preload: path.join(__dirname, 'web_assist_passkey_transport_preload.js'),
    devTools: false, backgroundThrottling: false,
  }) });
  options.attachProxy(win.webContents);
  sessions.get(options.session)!.set(win.webContents.id, url);
  let disposed = false;
  let opened = false;
  let total = 0;
  const owns = (event: IpcMainEvent) => !disposed && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame && event.senderFrame?.url === documentUrl;
  const fail = () => { if (!disposed) { destroy(); options.unavailable(); } };
  const ready = (event: IpcMainEvent) => {
    if (!owns(event) || opened) return;
    opened = true;
    win.webContents.send('web-assist-passkey-transport:open', url);
  };
  const receive = (event: IpcMainEvent, value: { type?: string; hex?: string }) => {
    if (!owns(event)) return;
    if (value?.type === 'ws-opened') options.receive({ type: 'ws-opened' });
    else if (value?.type === 'ws-message' && typeof value.hex === 'string'
      && value.hex.length <= 131_072 && /^(?:[a-f0-9]{2})+$/.test(value.hex)) {
      total += value.hex.length;
      if (total > 2 * 1024 * 1024) return fail();
      options.receive({ type: 'ws-message', hex: value.hex });
    } else fail();
  };
  function destroy() {
    if (disposed) return;
    disposed = true;
    sessions.get(options.session)?.delete(win.webContents.id);
    ipcMain.removeListener('web-assist-passkey-transport:ready', ready);
    ipcMain.removeListener('web-assist-passkey-transport:event', receive);
    if (!win.isDestroyed()) win.destroy();
  }
  ipcMain.on('web-assist-passkey-transport:ready', ready);
  ipcMain.on('web-assist-passkey-transport:event', receive);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', fail);
  win.on('closed', fail);
  void win.loadFile(documentPath).catch(fail);
  return {
    send(hex: string) {
      if (!disposed && hex.length <= 131_072 && /^(?:[a-f0-9]{2})+$/.test(hex)) {
        win.webContents.send('web-assist-passkey-transport:send', hex);
      } else fail();
    },
    close() { if (!disposed) win.webContents.send('web-assist-passkey-transport:close'); },
    destroy,
  };
}
