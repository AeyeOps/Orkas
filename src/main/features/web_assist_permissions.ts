/** Site-scoped native consent. Web pages cannot grant themselves device access. */
import { randomUUID } from 'node:crypto';
import { desktopCapturer, Menu, webContents, type BrowserWindow, type Session, type WebContents } from 'electron';
import { t } from '../i18n';
import { safeExternalHttpUrl } from '../util/window-security';

type Owner = (contents?: WebContents | null) => BrowserWindow | undefined;
export interface WebAssistPermissionRequest { id: string; origin: string; permission: string; message: string }
interface PendingConsent {
  id: string; origin: string; permission: string; promise: Promise<boolean>;
  finish: (allowed: boolean, remember?: boolean) => boolean;
}
const configured = new WeakMap<Session, { choices: Map<string, boolean>; devices: Map<string, any[]>; revisions: Map<string, number>; owner: Owner; pending: Map<WebContents, Map<string, PendingConsent>>; nativePages: Set<WebContents> }>();
interface NativeSelection { id: string; kind: string; origin: string; cancel: () => void }
const selections = new WeakMap<WebContents, NativeSelection>();
const originFor = (value: string) => { const url = safeExternalHttpUrl(value); return url ? new URL(url).origin : ''; };
const permissionKey = (origin: string, permission: string) => `${origin}\u0000${permission}`;
// A page cannot retain an unbounded consent queue while its tab is unattended.
const MAX_PENDING_CONSENTS_PER_PAGE = 32;
// Electron forwards Chromium permission names, including new or platform-only types.
const PERMISSION_NAMES: Record<string, string> = {
  'clipboard-read': 'clipboard', 'clipboard-sanitized-write': 'clipboard', 'deprecated-sync-clipboard-read': 'clipboard',
  media: 'media', geolocation: 'location', 'geolocation-approximate': 'approximate_location', notifications: 'notifications',
  fullscreen: 'fullscreen', 'automatic-fullscreen': 'automatic_fullscreen', 'display-capture': 'screen',
  usb: 'usb', hid: 'hid', serial: 'serial', 'local-network': 'local_network', 'local-network-access': 'local_network',
  'loopback-network': 'loopback_network', 'persistent-storage': 'persistent_storage',
  'storage-access': 'storage_access', 'top-level-storage-access': 'storage_access',
  'window-management': 'window_management', 'local-fonts': 'local_fonts', 'idle-detection': 'idle_detection',
  'screen-wake-lock': 'screen_wake_lock', 'system-wake-lock': 'system_wake_lock',
  pointerLock: 'pointer_lock', keyboardLock: 'keyboard_lock', fileSystem: 'filesystem',
  mediaKeySystem: 'protected_media', midi: 'midi', midiSysex: 'midi_sysex',
  'speaker-selection': 'speaker_selection', openExternal: 'external', sensors: 'sensors',
  'background-fetch': 'background_fetch', 'background-sync': 'background_sync', 'periodic-background-sync': 'background_sync',
  'captured-surface-control': 'surface_control', 'payment-handler': 'payment',
  ar: 'ar', vr: 'vr', 'hand-tracking': 'hand_tracking', nfc: 'nfc', 'smart-card': 'smart_card',
  'web-app-installation': 'installation', 'web-printing': 'printing',
};
const namedPermission = (permission: string) => Object.hasOwn(PERMISSION_NAMES, permission)
  ? t(`web_assist.permission.${PERMISSION_NAMES[permission]}`)
  : t('web_assist.permission.unknown', { permission });

function choose<T>(owner: BrowserWindow, rows: Array<{ label: string; value: T }>, contents: WebContents,
  kind: string, origin: string, changed: (contents: WebContents) => void): Promise<T | undefined> {
  return new Promise(resolve => {
    if (selections.has(contents) || contents.isDestroyed() || owner.isDestroyed() || !rows.length) { resolve(undefined); return; }
    const nativePages = configured.get(contents.session)?.nativePages;
    let settled = false;
    const finish = (value?: T) => {
      if (settled) return;
      settled = true;
      owner.removeListener('closed', closed);
      selections.delete(contents);
      nativePages?.delete(contents);
      changed(contents);
      resolve(value);
    };
    const menu = Menu.buildFromTemplate(rows.map(row => ({ label: row.label, click: () => finish(row.value) })));
    const closed = () => { finish(); try { menu.closePopup(owner); } catch { /* A destroyed window has no menu to close. */ } };
    selections.set(contents, { id: randomUUID(), kind, origin, cancel: closed });
    nativePages?.add(contents);
    changed(contents);
    owner.once('closed', closed);
    try { menu.popup({ window: owner, callback: () => finish() }); }
    catch { finish(); }
  });
}

export function webAssistNativeSelection(contents: WebContents): Omit<NativeSelection, 'cancel'> | undefined {
  const selection = selections.get(contents);
  if (!selection || contents.isDestroyed() || !configured.get(contents.session)?.owner(contents)) return;
  const { id, kind, origin } = selection;
  return { id, kind, origin };
}

export function cancelWebAssistNativeSelection(contents: WebContents, id: string): boolean {
  if (webAssistNativeSelection(contents)?.id !== id) return false;
  selections.get(contents)!.cancel();
  return true;
}

export function configureWebAssistPermissions(session: Session, owner: Owner, changed: (contents: WebContents) => void = () => {}): void {
  const choices = new Map<string, boolean>();
  const pending = new Map<WebContents, Map<string, PendingConsent>>();
  const devices = new Map<string, any[]>();
  const revisions = new Map<string, number>();
  const navigations = new WeakMap<WebContents, number>();
  const unchanged = (contents: WebContents, window: BrowserWindow, navigation: number, origin: string, revision: number) =>
    !contents.isDestroyed() && !window.isDestroyed() && owner(contents) === window
    && navigations.get(contents) === navigation && (revisions.get(origin) || 0) === revision;
  const stamp = (contents: WebContents) => {
    if (!navigations.has(contents)) {
      navigations.set(contents, 0);
      contents.on('did-start-navigation', () => navigations.set(contents, (navigations.get(contents) || 0) + 1));
      const cancel = () => {
        for (const request of [...(pending.get(contents)?.values() || [])]) request.finish(false);
        selections.get(contents)?.cancel();
      };
      contents.on('did-start-navigation', cancel);
      contents.on('render-process-gone', cancel);
      contents.once('destroyed', cancel);
    }
    return navigations.get(contents)!;
  };
  configured.set(session, { choices, devices, revisions, owner, pending, nativePages: new Set() });
  const consent = async (contents: WebContents, permission: string, url: string): Promise<boolean> => {
    const window = owner(contents);
    const origin = originFor(url);
    if (!window || !origin || contents.isDestroyed() || window.isDestroyed()) return false;
    const navigation = stamp(contents), revision = revisions.get(origin) || 0;
    const key = permissionKey(origin, permission);
    if (choices.has(key)) return choices.get(key)!;
    const requests = pending.get(contents) || new Map<string, PendingConsent>();
    let request = requests.get(key);
    if (!request) {
      if (requests.size >= MAX_PENDING_CONSENTS_PER_PAGE) return false;
      let resolve!: (allowed: boolean) => void;
      const promise = new Promise<boolean>(done => { resolve = done; });
      request = { id: randomUUID(), origin, permission, promise, finish: (allowed, remember = false) => {
        if (requests.get(key) !== request) return false;
        const valid = unchanged(contents, window, navigation, origin, revision);
        if (remember && valid) choices.set(key, allowed);
        requests.delete(key);
        if (!requests.size) pending.delete(contents);
        resolve(allowed && valid);
        changed(contents);
        return valid;
      } };
      requests.set(key, request);
      pending.set(contents, requests);
      changed(contents);
    }
    return await request.promise && unchanged(contents, window, navigation, origin, revision);
  };
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (!owner(contents)) return false;
    // These checks permit only displaying the native picker. Specific device
    // reuse is separately tied to the device that the user actually selected.
    if (['usb', 'hid', 'serial'].includes(permission)) return true;
    return permission === 'clipboard-sanitized-write' || choices.get(permissionKey(originFor(requestingOrigin), permission)) === true;
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') { callback(!!owner(contents)); return; }
    void consent(contents, permission, details.requestingUrl || contents.getURL()).then(callback);
  });
  session.setDevicePermissionHandler(details => {
    if (!owner()) return false;
    const selected = devices.get(permissionKey(details.origin, details.deviceType)) || [];
    return selected.some(device => {
      const value = details.device as any;
      for (const id of ['deviceId', 'portId', 'guid']) if (device[id] && value[id]) return device[id] === value[id];
      return Boolean(device.serialNumber && value.serialNumber && device.serialNumber === value.serialNumber
        && device.vendorId === value.vendorId && device.productId === value.productId);
    });
  });
  const selectDevice = (type: string) => (event: { preventDefault(): void }, details: any, callback: (id?: string) => void) => {
    event.preventDefault();
    const contents = details.frame && webContents.fromFrame(details.frame);
    const window = contents && owner(contents);
    if (!window) { callback(); return; }
    const origin = originFor(details.frame.url);
    const navigation = stamp(contents!), revision = revisions.get(origin) || 0;
    const rows = (details.deviceList || []).map((device: any) => ({ label: device.productName || device.displayName || device.deviceName || t('web_assist.permission.device'), value: device }));
    void choose<any>(window, rows, contents!, type, origin, changed).then(device => {
      if (!device || !unchanged(contents!, window, navigation, origin, revision) || originFor(details.frame.url) !== origin) { callback(); return; }
      const key = permissionKey(origin, type);
      devices.set(key, [...(devices.get(key) || []), device]);
      callback(device.deviceId || device.portId);
    }, () => callback());
  };
  session.on('select-usb-device', selectDevice('usb'));
  session.on('select-hid-device', selectDevice('hid'));
  session.on('select-serial-port', (event, list, contents, callback) => {
    const window = owner(contents);
    event.preventDefault();
    if (!window) { callback(''); return; }
    const origin = originFor(contents.getURL()), navigation = stamp(contents), revision = revisions.get(origin) || 0;
    void choose(window, list.map(port => ({ label: port.displayName || port.portName, value: port })), contents, 'serial', origin, changed).then(port => {
      if (!port || !unchanged(contents, window, navigation, origin, revision)) { callback(''); return; }
      const key = permissionKey(origin, 'serial');
      devices.set(key, [...(devices.get(key) || []), port]);
      callback(port.portId);
    }, () => callback(''));
  });
  session.setDisplayMediaRequestHandler((request, callback) => {
    const contents = request.frame && webContents.fromFrame(request.frame);
    const window = contents && owner(contents);
    if (!contents || !window) { callback({}); return; }
    const origin = originFor(request.securityOrigin), navigation = stamp(contents), revision = revisions.get(origin) || 0;
    void consent(contents, 'display-capture', request.securityOrigin).then(async allowed => {
      if (!allowed || !unchanged(contents, window, navigation, origin, revision)) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (!unchanged(contents, window, navigation, origin, revision)) return callback({});
      const source = await choose(window, sources.map(source => ({ label: source.name, value: source })), contents, 'screen', origin, changed);
      if (!source || !unchanged(contents, window, navigation, origin, revision)) return callback({});
      callback({ video: source });
    }).catch(() => callback({}));
  }, { useSystemPicker: true });
}

/** Expose only the first pending request; each response path enforces its authority. */
export function webAssistPermissionRequest(contents: WebContents): WebAssistPermissionRequest | undefined {
  if (contents.isDestroyed()) return undefined;
  const state = configured.get(contents.session);
  const request = state?.pending.get(contents)?.values().next().value;
  // Most snapshots have no requests: avoid scanning the tab-owner registry for each page.
  if (!request || !state?.owner(contents)) return undefined;
  const { id, origin, permission } = request;
  return { id, origin, permission, message: t('web_assist.permission_request', { origin, permission: namedPermission(permission) }) };
}

export function respondWebAssistPermission(contents: WebContents, id: unknown, allowed: unknown): boolean {
  const state = configured.get(contents.session);
  if (contents.isDestroyed() || !state?.owner(contents) || typeof id !== 'string' || typeof allowed !== 'boolean') return false;
  const request = state.pending.get(contents)?.values().next().value;
  return !!request && request.id === id && request.finish(allowed, true);
}

/** The host action caller owns task/run/snapshot validation. Screen wake lock
 * is the only model-grantable permission; other grants retain trusted user consent.
 * Model decisions resolve this request only, never a persistent site choice. */
export function respondModelWebAssistPermission(contents: WebContents, id: string, allowed: boolean): Record<string, unknown> {
  const state = configured.get(contents.session);
  const request = state?.pending.get(contents)?.values().next().value;
  if (contents.isDestroyed() || !state?.owner(contents) || !request || request.id !== id) {
    return { ok: false, code: 'stale_page', error: 'The permission request changed; observe the page again.' };
  }
  if (allowed && request.permission !== 'screen-wake-lock') {
    return { ok: false, code: 'user_action_required', permission: request.permission, origin: request.origin,
      error: 'This permission requires the user’s choice in the browser.' };
  }
  return request.finish(allowed) ? { ok: true, outcome: 'acted', allowed }
    : { ok: false, code: 'stale_page' };
}

/** Trusted browser chrome can clear a site's remembered decision and retry. */
export function resetWebAssistSitePermissions(contents: WebContents): boolean {
  const state = configured.get(contents.session);
  if (!state?.owner(contents)) return false;
  const origin = originFor(contents.getURL());
  state.revisions.set(origin, (state.revisions.get(origin) || 0) + 1);
  // Device/source menus do not enter the ordinary permission queue.
  for (const page of [...state.nativePages]) if (selections.get(page)?.origin === origin) selections.get(page)!.cancel();
  for (const requests of state.pending.values()) for (const request of [...requests.values()]) {
    if (request.origin === origin) request.finish(false);
  }
  for (const key of state.choices.keys()) if (key.startsWith(`${origin}\u0000`)) state.choices.delete(key);
  for (const key of state.devices.keys()) if (key.startsWith(`${origin}\u0000`)) state.devices.delete(key);
  return true;
}
