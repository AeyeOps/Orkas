import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    dead = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, send: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    show = vi.fn(); setMenu = vi.fn(); setTitle = vi.fn();
    loadFile = vi.fn(async (file: string) => { this.webContents.mainFrame.url = pathToFileURL(file).href; });
    constructor(public options: any) { super(); runtime.windows.push(this); }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter() };
});

import { BrowserWindow, ipcMain } from 'electron';
import { setCurrentLang } from '../../../src/main/i18n';
import { createWebAssistPasskeyDialog } from '../../../src/main/features/web_assist_passkey_dialog';

beforeEach(() => { runtime.windows.length = 0; setCurrentLang('zh'); });
afterEach(() => {
  for (const win of runtime.windows) win.destroy();
  expect(ipcMain.listenerCount('web-assist-passkey-dialog:ready')).toBe(0);
  expect(ipcMain.listenerCount('web-assist-passkey-dialog:cancel')).toBe(0);
  setCurrentLang('en');
});
function open() {
  const onCancel = vi.fn();
  const controller = createWebAssistPasskeyDialog({ parent: new BrowserWindow(), rpId: 'google.com', onCancel });
  const window = runtime.windows.at(-1);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { controller, window, event, onCancel };
}
function latest(window: any) { return window.webContents.send.mock.calls.at(-1)[1]; }

describe('phone passkey dialog ownership and recovery', () => {
  it('shows the latest QR on first paint and accepts only its trusted main document', () => {
    const { controller, window, event } = open();
    controller.setState('scan', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const forged of [
      { ...event, sender: {} },
      { ...event, senderFrame: { url: event.senderFrame.url } },
    ]) ipcMain.emit('web-assist-passkey-dialog:ready', forged);
    expect(window.show).not.toHaveBeenCalled();
    const original = event.senderFrame.url;
    event.senderFrame.url = 'https://accounts.google.com/';
    ipcMain.emit('web-assist-passkey-dialog:ready', event);
    expect(window.show).not.toHaveBeenCalled();
    event.senderFrame.url = original;
    ipcMain.emit('web-assist-passkey-dialog:ready', event);
    expect(window.show).toHaveBeenCalledOnce();
    expect(latest(window)).toMatchObject({ phase: 'scan', rpId: 'google.com', lang: 'zh-CN', dir: 'ltr' });
    expect(latest(window).copy.instruction).toContain('google.com');
    expect(latest(window).qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(window.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false });
    const preventDefault = vi.fn();
    window.webContents.emit('will-navigate', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    controller.destroy();
  });

  it('removes obsolete QR content when connected and refreshes locale without restarting authentication', () => {
    const { controller, window, event } = open();
    ipcMain.emit('web-assist-passkey-dialog:ready', event);
    controller.setState('scan', '<svg/>');
    controller.setState('confirm');
    expect(latest(window)).toMatchObject({ phase: 'confirm', qr: '' });
    expect(latest(window).copy.confirm).toContain('手机上确认');
    setCurrentLang('ar');
    controller.refreshLanguage();
    expect(latest(window)).toMatchObject({ phase: 'confirm', qr: '', lang: 'ar', dir: 'rtl' });
    expect(latest(window).copy.title).toBe('مفتاح المرور');
    controller.setState('verifying');
    expect(latest(window).copy.verifying).toBe('جارٍ العودة إلى الموقع…');
    controller.destroy();
  });

  it('ignores foreign cancellation, cancels once, and releases listeners before a retry', () => {
    const { controller, window, event, onCancel } = open();
    ipcMain.emit('web-assist-passkey-dialog:cancel', { ...event, sender: {} });
    expect(onCancel).not.toHaveBeenCalled();
    ipcMain.emit('web-assist-passkey-dialog:cancel', event);
    ipcMain.emit('web-assist-passkey-dialog:cancel', event);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('cancelled');
    expect(window.dead).toBe(true);
    controller.setState('scan', '<svg/>');
    expect(window.webContents.send).not.toHaveBeenCalled();
    const retry = open();
    ipcMain.emit('web-assist-passkey-dialog:ready', retry.event);
    expect(retry.window.show).toHaveBeenCalledOnce();
    retry.controller.destroy();
    expect(retry.onCancel).not.toHaveBeenCalled();
  });

  it('disposes a request before readiness without reopening or falsely cancelling completion', () => {
    const { controller, window, event, onCancel } = open();
    controller.destroy();
    ipcMain.emit('web-assist-passkey-dialog:ready', event);
    expect(window.show).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reports a crashed dialog as unavailable and leaves no live QR or IPC listener', () => {
    const { controller, window, onCancel } = open();
    controller.setState('scan', '<svg/>');
    window.webContents.emit('render-process-gone');
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('unavailable');
    expect(window.dead).toBe(true);
  });
});

describe('phone passkey renderer handback', () => {
  it('replaces the QR with phone-confirmation status, keeps cancel reachable and renders site copy as text', () => {
    const elements = Object.fromEntries(['dialog', 'camera', 'phone', 'title', 'heading', 'instruction', 'nearby', 'cancel', 'status', 'qr', 'waiting']
      .map(id => [id, { dataset: {}, hidden: false, textContent: '', innerHTML: '', disabled: false, src: '', alt: '',
        addEventListener: vi.fn(), removeAttribute: vi.fn(function(this: any) { this.src = ''; }), focus: vi.fn(),
      }]));
    const document = { body: {}, activeElement: null as any, documentElement: {}, getElementById: (id: string) => elements[id], addEventListener: vi.fn() };
    document.activeElement = document.body;
    let update: any;
    const cancel = vi.fn();
    const window = { uiIconHtml: (name: string) => `<svg data-icon="${name}"></svg>`, phonePasskeyDialog: { cancel, onUpdate: (cb: any) => { update = cb; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../src/renderer/views/browser-passkey/passkey.js'), 'utf8'), { window, document });
    const copy = { title: 'Passkey', heading: 'Use a phone', instruction: '<img src=x onerror=alert(1)>', nearby: 'Keep phone nearby', cancel: 'Cancel', qr_alt: 'Scan', scan: 'Scan', confirm: 'Confirm on your phone', verifying: 'Returning to website' };
    update({ copy, phase: 'scan', qr: 'data:image/svg+xml;base64,PHN2Zy8+', lang: 'en', dir: 'ltr' });
    expect(elements.qr.hidden).toBe(false);
    expect(elements.instruction.textContent).toBe(copy.instruction);
    expect(elements.instruction.innerHTML).toBe('');
    expect(elements.cancel.focus).toHaveBeenCalledOnce();
    update({ copy, phase: 'confirm', qr: '', lang: 'en', dir: 'ltr' });
    expect(elements.qr.hidden).toBe(true);
    expect(elements.qr.src).toBe('');
    expect(elements.waiting.hidden).toBe(false);
    expect(elements.status.textContent).toBe('Confirm on your phone');
    const keydown = document.addEventListener.mock.calls[0][1];
    keydown({ key: 'Escape', preventDefault() {} });
    elements.cancel.addEventListener.mock.calls[0][1]();
    expect(cancel).toHaveBeenCalledOnce();
    expect(elements.cancel.disabled).toBe(true);
  });
});
