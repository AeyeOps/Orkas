import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ dialog: vi.fn(), menu: vi.fn(), sources: vi.fn(), fromFrame: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: native.dialog }, Menu: { buildFromTemplate: native.menu }, desktopCapturer: { getSources: native.sources }, webContents: { fromFrame: native.fromFrame } }));
import { setCurrentLang } from '../../../src/main/i18n';
import { configureWebAssistPermissions, resetWebAssistSitePermissions, webAssistPermissionRequest, respondWebAssistPermission, respondModelWebAssistPermission, webAssistNativeSelection, cancelWebAssistNativeSelection } from '../../../src/main/features/web_assist_permissions';
function fixture() {
  const session = Object.assign(new EventEmitter(), { check: null as any, request: null as any, device: null as any, display: null as any,
    setPermissionCheckHandler(f: any) { this.check = f; }, setPermissionRequestHandler(f: any) { this.request = f; }, setDevicePermissionHandler(f: any) { this.device = f; }, setDisplayMediaRequestHandler(f: any) { this.display = f; } });
  const contents = Object.assign(new EventEmitter(), { session, isDestroyed: () => false, getURL: () => 'https://website.example/page?private=fixture' });
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let current = true;
  const pages = new Set([contents]);
  const changed = vi.fn();
  configureWebAssistPermissions(session as any, wc => current && (!wc || pages.has(wc as any)) ? window as any : undefined, changed);
  native.fromFrame.mockReturnValue(contents);
  const request = (permission = 'media') => new Promise<boolean>(resolve => session.request(contents, permission, resolve, { requestingUrl: 'https://website.example/other' }));
  const prompt = () => webAssistPermissionRequest(contents as any);
  const answer = (allowed = true) => respondWebAssistPermission(contents as any, prompt()?.id, allowed);
  const ask = async (permission = 'media', allowed = true) => { const result = request(permission); if (prompt()) answer(allowed); return result; };
  const addPage = () => { const page = Object.assign(new EventEmitter(), { session, isDestroyed: () => false, getURL: contents.getURL }); pages.add(page); return page; };
  return { session, contents, window, request, prompt, answer, ask, addPage, changed, leave: () => { current = false; } };
}
beforeEach(() => { vi.clearAllMocks(); native.dialog.mockResolvedValue({ response: 0 }); native.menu.mockImplementation((items: any[]) => ({ popup: ({ callback }: any) => { items[0]?.click(); callback(); }, closePopup() {} })); native.sources.mockResolvedValue([{ id: 'selected-screen', name: 'Screen' }]); });
afterEach(() => expect(native.dialog).not.toHaveBeenCalled());
describe('task browser website consent', () => {
  it.each(['media', 'clipboard-read', 'geolocation', 'notifications', 'display-capture', 'usb', 'local-network', 'unknown-permission'])('retains user consent for %s while allowing request-only AI denial', async permission => {
    const f = fixture(); const result = f.request(permission);
    const id = f.prompt()!.id;
    expect(respondModelWebAssistPermission(f.contents as any, id, true)).toMatchObject({ ok: false, code: 'user_action_required' });
    expect(f.prompt()?.id).toBe(id);
    expect(respondModelWebAssistPermission(f.contents as any, id, false)).toMatchObject({ ok: true });
    expect(await result).toBe(false);
    const again = f.request(permission);
    expect(f.prompt()).toBeDefined();
    f.answer(); expect(await again).toBe(true);
  });
  it.each(['cancel', 'navigation', 'reset', 'close'] as const)('exposes device selection without device names and releases it on %s', async reason => {
    const f = fixture(), callback = vi.fn(), closePopup = vi.fn();
    native.menu.mockReturnValue({ popup() {}, closePopup });
    f.session.emit('select-usb-device', { preventDefault() {} }, { frame: { url: 'https://website.example/device?secret=hidden' },
      deviceList: [{ deviceId: 'private-id', productName: 'Private device' }] }, callback);
    const selection = webAssistNativeSelection(f.contents as any)!;
    expect(selection).toMatchObject({ kind: 'usb', origin: 'https://website.example' });
    expect(JSON.stringify(selection)).not.toMatch(/Private device|private-id|secret=hidden/);
    expect(cancelWebAssistNativeSelection(f.contents as any, 'wrong')).toBe(false);
    if (reason === 'cancel') expect(cancelWebAssistNativeSelection(f.contents as any, selection.id)).toBe(true);
    else if (reason === 'navigation') f.contents.emit('did-start-navigation');
    else if (reason === 'reset') resetWebAssistSitePermissions(f.contents as any);
    else {
      f.contents.isDestroyed = () => true;
      Object.defineProperty(f.contents, 'session', { get() { throw new Error('Object has been destroyed'); } });
      f.contents.emit('destroyed');
    }
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith());
    expect(closePopup).toHaveBeenCalledOnce();
    expect(webAssistNativeSelection(f.contents as any)).toBeUndefined();
    expect(f.session.device({ origin: selection.origin, deviceType: 'usb', device: { deviceId: 'private-id' } })).toBe(false);
  });

  it('exposes screen-source selection after user consent and supports cancellation without sharing', async () => {
    const f = fixture(), callback = vi.fn();
    native.menu.mockReturnValue({ popup() {}, closePopup() {} });
    f.session.display({ frame: {}, securityOrigin: 'https://website.example' }, callback);
    f.answer();
    await vi.waitFor(() => expect(webAssistNativeSelection(f.contents as any)?.kind).toBe('screen'));
    cancelWebAssistNativeSelection(f.contents as any, webAssistNativeSelection(f.contents as any)!.id);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith({}));
  });
  it('asks once per site and permission, never includes private URL query values', async () => {
    const f = fixture();
    expect(f.session.check(f.contents, 'media', 'https://website.example')).toBe(false);
    const result = f.request();
    expect(f.prompt()).toMatchObject({ origin: 'https://website.example', permission: 'media' });
    expect(JSON.stringify(f.prompt())).not.toContain('private=fixture');
    f.answer();
    expect(await result).toBe(true); expect(await f.request()).toBe(true);
    expect(f.prompt()).toBeUndefined();
    expect(f.session.check(f.contents, 'media', 'https://other.example')).toBe(false);
    expect(f.session.check(f.contents, 'media', 'https://website.example')).toBe(true);
    expect(f.session.check({}, 'media', 'https://website.example')).toBe(false);
  });
  it('remembers a refusal and lets trusted chrome reset it without reloading the form', async () => {
    const f = fixture();
    expect(await f.ask('clipboard-read', false)).toBe(false);
    expect(await f.request('clipboard-read')).toBe(false);
    expect(resetWebAssistSitePermissions(f.contents as any)).toBe(true);
    expect(await f.ask('clipboard-read')).toBe(true);
  });
  it.each(['navigation', 'account', 'reset', 'close', 'crash'])('rejects a stale approval after %s', async reason => {
    const f = fixture(); const result = f.request(); const id = f.prompt()!.id;
    if (reason === 'navigation') f.contents.emit('did-start-navigation');
    else if (reason === 'account') f.leave();
    else if (reason === 'close') f.contents.emit('destroyed');
    else if (reason === 'crash') f.contents.emit('render-process-gone');
    else resetWebAssistSitePermissions(f.contents as any);
    expect(respondWebAssistPermission(f.contents as any, id, true)).toBe(false);
    if (reason === 'account') f.contents.emit('destroyed');
    expect(await result).toBe(false);
    expect(f.session.check(f.contents, 'media', 'https://website.example')).toBe(false);
    expect(f.prompt()).toBeUndefined();
  });
  it('deduplicates a page request and queues different permissions without accepting undisplayed answers', async () => {
    const f = fixture();
    const first = f.request('media'), duplicate = f.request('media'), second = f.request('notifications');
    const id = f.prompt()!.id;
    expect(f.prompt()!.permission).toBe('media');
    expect(respondWebAssistPermission(f.contents as any, 'other-id', true)).toBe(false);
    expect(respondWebAssistPermission(f.contents as any, id, 'true')).toBe(false);
    expect(f.changed).toHaveBeenCalledTimes(2);
    f.answer(false);
    expect(await first).toBe(false); expect(await duplicate).toBe(false);
    expect(f.prompt()!.permission).toBe('notifications');
    expect(respondWebAssistPermission(f.contents as any, id, true)).toBe(false);
    f.answer(); expect(await second).toBe(true);
  });
  it('keeps simultaneous same-site requests attached to their own pages', async () => {
    const f = fixture(), other = f.addPage();
    const first = f.request('media');
    const second = new Promise<boolean>(resolve => f.session.request(other, 'media', resolve, { requestingUrl: other.getURL() }));
    const firstId = f.prompt()!.id, otherId = webAssistPermissionRequest(other as any)!.id;
    expect(firstId).not.toBe(otherId);
    expect(respondWebAssistPermission(other as any, firstId, true)).toBe(false);
    f.contents.emit('did-start-navigation'); expect(await first).toBe(false);
    expect(respondWebAssistPermission(other as any, otherId, true)).toBe(true);
    expect(await second).toBe(true);
  });
  it('bounds an unattended page queue, denies overflow, and releases every pending request on navigation', async () => {
    const f = fixture();
    const waiting = Array.from({ length: 32 }, (_, index) => f.request(`permission-${index}`));
    expect(await f.request('overflow')).toBe(false);
    expect(f.prompt()!.permission).toBe('permission-0');
    f.contents.emit('did-start-navigation');
    expect(await Promise.all(waiting)).toEqual(Array(32).fill(false));
    expect(f.prompt()).toBeUndefined();
    expect(await f.ask('retry')).toBe(true);
  });
  it.each(['en', 'zh'] as const)('names network, storage and unknown permissions in %s without exposing URL secrets', async language => {
    setCurrentLang(language);
    const f = fixture();
    for (const [permission, expected] of language === 'zh'
      ? [['local-network-access', '本地网络'], ['persistent-storage', '持久保存'], ['future-permission', 'future-permission']]
      : [['local-network-access', 'local network'], ['persistent-storage', 'persistent website storage'], ['future-permission', 'future-permission']]) {
      const result = f.request(permission);
      expect(f.prompt()!.message).toContain(expected);
      expect(f.prompt()!.message).not.toContain('此权限');
      f.answer(false); expect(await result).toBe(false);
    }
    setCurrentLang('en');
  });
  it('selects one explicit device and revokes its reuse when site permissions are reset', async () => {
    const f = fixture(); const callback = vi.fn();
    f.session.emit('select-usb-device', { preventDefault() {} }, { frame: { url: 'https://website.example/device' }, deviceList: [{ deviceId: 'chosen', productName: 'Device' }, { deviceId: 'other' }] }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('chosen'));
    expect(f.session.device({ origin: 'https://website.example', deviceType: 'usb', device: { deviceId: 'chosen' } })).toBe(true);
    expect(f.session.device({ origin: 'https://website.example', deviceType: 'usb', device: { deviceId: 'other' } })).toBe(false);
    resetWebAssistSitePermissions(f.contents as any);
    expect(f.session.device({ origin: 'https://website.example', deviceType: 'usb', device: { deviceId: 'chosen' } })).toBe(false);
  });
  it('shares only the screen or window explicitly selected by the user', async () => {
    const f = fixture(); const callback = vi.fn();
    f.session.display({ frame: {}, securityOrigin: 'https://website.example' }, callback);
    f.answer();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: { id: 'selected-screen', name: 'Screen' } }));
    expect(native.menu).toHaveBeenCalledOnce();
    resetWebAssistSitePermissions(f.contents as any);
    const denied = vi.fn(); f.session.display({ frame: {}, securityOrigin: 'https://website.example' }, denied);
    f.answer(false);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith({})); expect(native.sources).toHaveBeenCalledOnce();
  });
  it('leaves sanitized clipboard writes available while unowned pages cannot request permissions', async () => {
    const f = fixture(); expect(await f.request('clipboard-sanitized-write')).toBe(true);
    f.leave(); expect(await f.request()).toBe(false); expect(native.dialog).not.toHaveBeenCalled();
  });
});
