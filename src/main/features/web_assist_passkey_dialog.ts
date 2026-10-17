import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { getCurrentLang, getLocaleMeta, t } from '../i18n';
import { hardenedWebPreferences } from '../util/window-security';

export type PhonePasskeyPhase = 'preparing' | 'scan' | 'connecting' | 'confirm' | 'verifying';

/** Trusted UI only. The caller owns WebAuthn validation, transport and lifetime. */
export function createWebAssistPasskeyDialog(options: {
  parent: BrowserWindow;
  rpId: string;
  onCancel: (reason: 'cancelled' | 'unavailable') => void;
}) {
  const documentPath = path.join(__dirname, '../../renderer/views/browser-passkey/index.html');
  const documentUrl = pathToFileURL(documentPath).href;
  const dialog = new BrowserWindow({
    parent: options.parent, modal: true, show: false,
    width: 448, height: 472, resizable: false, minimizable: false, maximizable: false,
    frame: false, backgroundColor: '#ffffff',
    webPreferences: hardenedWebPreferences({
      preload: path.join(__dirname, 'web_assist_passkey_dialog_preload.js'),
      devTools: false,
    }),
  });
  dialog.setMenu(null);
  let disposed = false;
  let ready = false;
  let phase: PhonePasskeyPhase = 'preparing';
  let qr = '';
  const owns = (event: IpcMainEvent) => !disposed
    && event.sender === dialog.webContents
    && event.senderFrame === dialog.webContents.mainFrame
    && event.senderFrame?.url === documentUrl;
  function publish() {
    if (!ready || disposed) return;
    const lang = getCurrentLang();
    const meta = getLocaleMeta(lang);
    const copy = Object.fromEntries(['title', 'heading', 'instruction', 'nearby', 'cancel', 'qr_alt',
      'preparing', 'scan', 'connecting', 'confirm', 'verifying'].map(key => [key, t(`web_assist.passkey.${key}`, { rpId: options.rpId })]));
    dialog.setTitle(copy.title);
    dialog.webContents.send('web-assist-passkey-dialog:update', {
      phase, qr, rpId: options.rpId, copy, lang: meta.htmlLang, dir: lang === 'ar' ? 'rtl' : 'ltr',
    });
  }
  function cleanup() {
    ipcMain.removeListener('web-assist-passkey-dialog:ready', onReady);
    ipcMain.removeListener('web-assist-passkey-dialog:cancel', onCancel);
  }
  function cancel(reason: 'cancelled' | 'unavailable') {
    if (disposed) return;
    destroy();
    options.onCancel(reason);
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    qr = '';
    cleanup();
    if (!dialog.isDestroyed()) dialog.destroy();
  }
  function onReady(event: IpcMainEvent) {
    if (!owns(event)) return;
    ready = true;
    publish();
    dialog.show();
  }
  function onCancel(event: IpcMainEvent) { if (owns(event)) cancel('cancelled'); }
  ipcMain.on('web-assist-passkey-dialog:ready', onReady);
  ipcMain.on('web-assist-passkey-dialog:cancel', onCancel);
  dialog.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dialog.webContents.on('will-navigate', event => event.preventDefault());
  dialog.webContents.on('will-frame-navigate', event => event.preventDefault());
  dialog.webContents.on('render-process-gone', () => cancel('unavailable'));
  dialog.on('closed', () => cancel('cancelled'));
  void dialog.loadFile(documentPath).catch(() => cancel('unavailable'));
  return {
    setState(next: PhonePasskeyPhase, svg?: string) {
      if (disposed) return;
      phase = next;
      // Only QR images enter this renderer; never challenges or assertions.
      qr = next === 'scan' && svg ? `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` : '';
      publish();
    },
    refreshLanguage: publish,
    destroy,
  };
}
