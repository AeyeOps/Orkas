import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ handlers: new Map<string, Function>(), children: [] as any[], dialogs: [] as any[], transports: [] as any[] }));
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: Object.assign(new EventEmitter(), {
  handle: (name: string, fn: Function) => runtime.handlers.set(name, fn),
}) }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (file: any) => path.basename(String(file)) === 'orkas-phone-passkey' || actual.existsSync(file) };
});
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  runtime.children.push(child); return child;
}) }));
vi.mock('../../../src/main/features/web_assist_passkey_dialog', () => ({ createWebAssistPasskeyDialog: vi.fn((options: any) => {
  const dialog = { options, setState: vi.fn(), refreshLanguage: vi.fn(), destroy: vi.fn() };
  runtime.dialogs.push(dialog); return dialog;
}) }));
vi.mock('../../../src/main/features/web_assist_passkey_transport', () => ({ createPasskeyTransport: vi.fn((options: any) => {
  const transport = { options, send: vi.fn(), close: vi.fn(), destroy: vi.fn() };
  runtime.transports.push(transport); return transport;
}) }));

import { ipcMain } from 'electron';
import { attachWebAssistPasskeys, cancelWebAssistPasskey, webAssistPasskeyRequest, cancelModelWebAssistPasskey } from '../../../src/main/features/web_assist_passkey';
import { normalizePhonePasskeyRequest, passkeyOrigin, validPhonePasskeyCredential } from '../../../src/main/features/web_assist_passkey_validation';

const challenge = Buffer.from('independent request nonce').toString('base64url');
const request = { challenge, rpId: 'google.com', userVerification: 'required', allowCredentials: [] };
const id = '11111111-1111-4111-8111-111111111111';
const disposers: Array<() => void> = [];
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  // Exercise the macOS request protocol with mocked native dependencies on
  // every host; the real Windows attachment policy has its own case below.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  runtime.children.length = 0; runtime.dialogs.length = 0; runtime.transports.length = 0;
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', hostPlatform);
});
function open() {
  const frame = { url: 'https://accounts.google.com/signin/fixture' };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, session: {}, getURL: () => frame.url, isDestroyed: () => false });
  const owner = { parent: { isDestroyed: () => false }, attachProxy: vi.fn(), eligible: () => true };
  disposers.push(attachWebAssistPasskeys(contents as any, owner as any).dispose);
  const event = { sender: contents, senderFrame: frame };
  const get = (input = request, requestId = id, sender = event) => runtime.handlers.get('web-assist-passkey:get')!(sender, { id: requestId, publicKey: input });
  return { contents, frame, owner, event, get };
}
function credential() {
  const auth = Buffer.alloc(37); createHash('sha256').update('google.com').digest().copy(auth); auth[32] = 5;
  return { type: 'public-key', id: 'AQ', rawId: 'AQ', extensions: {}, response: {
    clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: 'https://accounts.google.com', challenge, crossOrigin: false })).toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: 'AQ', userHandle: null,
  } };
}
function emit(value: unknown) { runtime.children.at(-1).stdout.write(`${JSON.stringify(value)}\n`); }

describe('Google phone passkey authority and request binding', () => {
  it('accepts the observed long challenge and rejects malformed limits, credentials and RP look-alikes', () => {
    for (const size of [16, 3193, 8192]) expect(normalizePhonePasskeyRequest({ ...request, challenge: Buffer.alloc(size).toString('base64url') })).not.toBeNull();
    for (const input of [null, { ...request, rpId: 'google.com.evil.test' }, { ...request, challenge: `${challenge}=` },
      ...[15, 8193].map(size => ({ ...request, challenge: Buffer.alloc(size).toString('base64url') })),
      { ...request, allowCredentials: null }, { ...request, allowCredentials: [{ type: 'public-key', id: 'bad=' }] },
      { ...request, timeout: Infinity }, { ...request, userVerification: 'unknown' }]) expect(normalizePhonePasskeyRequest(input)).toBeNull();
    expect(passkeyOrigin('https://accounts.google.com/any')).toBe('https://accounts.google.com');
    for (const url of ['http://accounts.google.com', 'https://accounts.google.com.evil.test', 'https://accounts.google.com:444', 'https://user@accounts.google.com']) expect(passkeyOrigin(url)).toBeNull();
  });
  it('rejects returned credentials for another challenge, origin, RP, credential or missing verification', () => {
    const normalized = normalizePhonePasskeyRequest(request)!;
    expect(validPhonePasskeyCredential(credential(), normalized, 'https://accounts.google.com')).toBe(true);
    expect(validPhonePasskeyCredential(credential(), { ...normalized, challenge: 'different' }, 'https://accounts.google.com')).toBe(false);
    expect(validPhonePasskeyCredential(credential(), normalized, 'https://accounts.google.com/')).toBe(false);
    expect(validPhonePasskeyCredential(credential(), { ...normalized, rpId: 'accounts.google.com' }, 'https://accounts.google.com')).toBe(false);
    const noUV = credential(); const bytes = Buffer.from(noUV.response.authenticatorData, 'base64url'); bytes[32] = 1; noUV.response.authenticatorData = bytes.toString('base64url');
    expect(validPhonePasskeyCredential(noUV, normalized, 'https://accounts.google.com')).toBe(false);
    expect(validPhonePasskeyCredential(credential(), { ...normalized, allowCredentials: [{ type: 'public-key', id: 'Ag' }] }, 'https://accounts.google.com')).toBe(false);
  });
  it('starts no helper or dialog for an iframe, foreign contents or inactive owner', async () => {
    const { get, event, owner } = open();
    for (const sender of [{ ...event, senderFrame: { url: event.senderFrame.url } }, { ...event, sender: {} }]) {
      expect(await get(request, id, sender as any)).toEqual({ ok: false, code: 'SecurityError' });
    }
    owner.eligible = () => false;
    expect(await get()).toEqual({ ok: false, code: 'SecurityError' });
    expect(runtime.children).toHaveLength(0); expect(runtime.dialogs).toHaveLength(0);
  });
  it('leaves Windows phone authentication with its native browser route', async () => {
    open(); // A pre-existing bridge must still reject an unowned Windows page.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { get } = open();
    expect(await get()).toEqual({ ok: false, code: 'SecurityError' });
    expect(runtime.children).toHaveLength(0);
    expect(runtime.dialogs).toHaveLength(0);
    expect(runtime.transports).toHaveLength(0);
  });
});

describe('phone authentication lifetime and Session handback', () => {
  it('exposes only the pending origin and an opaque cancellation id, never authentication material', async () => {
    const { get, contents } = open(); const result = get();
    const prompt = webAssistPasskeyRequest(contents as any)!;
    expect(prompt).toMatchObject({ origin: 'https://accounts.google.com' });
    expect(prompt.id).not.toBe(id);
    expect(JSON.stringify(prompt)).not.toContain(challenge);
    expect(cancelModelWebAssistPasskey(contents as any, 'stale')).toBe(false);
    expect(runtime.children[0].kill).not.toHaveBeenCalled();
    expect(cancelModelWebAssistPasskey(contents as any, prompt.id)).toBe(true);
    expect(await result).toEqual({ ok: false, code: 'AbortError' });
    expect(webAssistPasskeyRequest(contents as any)).toBeUndefined();
    expect(runtime.children[0].kill).toHaveBeenCalledOnce();
  });
  it('routes encrypted frames through the page Session and returns only a bound assertion once', async () => {
    const { get, contents, owner } = open();
    const result = get();
    emit({ type: 'qr', svg: '<svg/>' });
    expect(runtime.dialogs[0].setState).toHaveBeenLastCalledWith('scan', '<svg/>');
    emit({ type: 'ws-open', url: 'wss://cable.auth.com/cable/connect/010203/00000000000000000000000000000000' });
    expect(runtime.transports[0].options.session).toBe(contents.session);
    expect(runtime.transports[0].options.attachProxy).toBe(owner.attachProxy);
    emit({ type: 'ws-send', hex: '010203' });
    expect(runtime.transports[0].send).toHaveBeenCalledWith('010203');
    const value = credential(); emit({ type: 'result', credential: value });
    expect(await result).toEqual({ ok: true, credential: value });
    runtime.children[0].emit('exit', 0);
    expect(runtime.dialogs[0].destroy).toHaveBeenCalledOnce();
    expect(runtime.children[0].kill).toHaveBeenCalledOnce();
    expect(runtime.transports[0].destroy).toHaveBeenCalledOnce();
  });
  it('keeps cancellation scoped to its request and releases all resources for retry', async () => {
    const { get, event } = open(); const result = get();
    ipcMain.emit('web-assist-passkey:cancel', { ...event, senderFrame: {} }, id);
    ipcMain.emit('web-assist-passkey:cancel', event, '22222222-2222-4222-8222-222222222222');
    expect(runtime.children[0].kill).not.toHaveBeenCalled();
    ipcMain.emit('web-assist-passkey:cancel', event, id);
    expect(await result).toEqual({ ok: false, code: 'AbortError' });
    const retry = get(); runtime.dialogs[1].options.onCancel('cancelled');
    expect(await retry).toEqual({ ok: false, code: 'AbortError' });
    expect(runtime.children).toHaveLength(2);
  });
  it('cancels navigation and account/tab teardown before an old phone result reaches a new document', async () => {
    const { get, contents, frame } = open(); const result = get();
    frame.url = 'https://accounts.google.com/signin/replacement';
    contents.emit('did-start-navigation', {}, frame.url, false, true);
    emit({ type: 'result', credential: credential() });
    expect(await result).toEqual({ ok: false, code: 'AbortError' });
    const retry = get(); cancelWebAssistPasskey(contents as any);
    expect(await retry).toEqual({ ok: false, code: 'AbortError' });
  });
  it('fails closed on invalid native output, timeout and tunnel failure, allowing a clean retry', async () => {
    vi.useFakeTimers(); const { get } = open();
    const malformed = get(); emit({ type: 'result', credential: { id: 'fake-success' } });
    expect(await malformed).toEqual({ ok: false, code: 'NotAllowedError' });
    const timed = get({ ...request, timeout: 1000 } as any); await vi.advanceTimersByTimeAsync(1001);
    expect(await timed).toEqual({ ok: false, code: 'NotAllowedError' });
    const retry = get(); emit({ type: 'ws-open', url: 'fixture' }); runtime.transports.at(-1).options.unavailable();
    expect(await retry).toEqual({ ok: false, code: 'NotAllowedError' });
    expect(runtime.children).toHaveLength(3);
  });
});
