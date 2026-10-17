import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'src/main/features/web_assist_passkey_preload.js'), 'utf8');
function load(platform = 'darwin', origin = 'https://accounts.google.com', mainFrame = true) {
  const native = vi.fn(async function(this: unknown) { return 'native-result'; });
  const ipc = { invoke: vi.fn(), send: vi.fn() };
  const context = vm.createContext({ native, process: { platform, isMainFrame: mainFrame },
    location: new URL(origin), DOMException, AbortController, structuredClone,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
  });
  vm.runInContext(`window = globalThis; class CredentialsContainer {};
    CredentialsContainer.prototype.get = native;
    navigator = { credentials: new CredentialsContainer() };`, context);
  context.require = () => ({ ipcRenderer: ipc, contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => { context[name] = value; },
    executeInMainWorld: ({ func }: { func: Function }) => vm.runInContext(`(${func.toString()})()`, context),
  } });
  vm.runInContext(source, context);
  return { context, native, ipc, run: (code: string) => vm.runInContext(code, context) };
}

describe('phone passkey preload compatibility and cancellation', () => {
  it('leaves foreign origins, child frames and Windows on the original browser route', async () => {
    for (const args of [['win32', 'https://accounts.google.com', true], ['darwin', 'https://example.test', true],
      ['darwin', 'https://accounts.google.com', false]] as const) {
      const h = load(...args);
      expect(h.context.__orkasPhonePasskey).toBeUndefined();
      expect(await h.run('navigator.credentials.get({ publicKey: {} })')).toBe('native-result');
      expect(h.ipc.invoke).not.toHaveBeenCalled();
    }
  });
  it('delegates conditional, extended, non-public-key and foreign receiver requests without starting phone authentication', async () => {
    const h = load();
    for (const options of ["{mediation:'conditional',publicKey:{}}", "{publicKey:{extensions:{appid:'fixture'}}}", "{password:true}"]) {
      expect(await h.run(`navigator.credentials.get(${options})`)).toBe('native-result');
    }
    expect(await h.run('CredentialsContainer.prototype.get.call({foreign:true},{publicKey:{}})')).toBe('native-result');
    expect(h.native).toHaveBeenCalledTimes(4);
    expect(h.native.mock.contexts[3]).toMatchObject({ foreign: true });
    expect(h.ipc.invoke).not.toHaveBeenCalled();
  });
  it('serializes only a typed-view range and scopes abort to its own pending request', async () => {
    const h = load();
    let resolve!: (value: unknown) => void;
    h.ipc.invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = h.run(`controller = new AbortController();
      navigator.credentials.get({signal:controller.signal, publicKey:{
        challenge:new Uint8Array(new Uint8Array([99,1,2,3,99]).buffer,1,3),rpId:'google.com'
      }}).then(()=> 'unexpected-success', error=>error.name)`);
    expect(h.ipc.invoke).toHaveBeenCalledWith('web-assist-passkey:get', {
      id: '11111111-1111-4111-8111-111111111111', publicKey: {
        challenge: 'AQID', rpId: 'google.com', timeout: undefined, userVerification: 'preferred', allowCredentials: [],
      },
    });
    h.run('controller.abort()');
    expect(h.ipc.send).toHaveBeenCalledWith('web-assist-passkey:cancel', '11111111-1111-4111-8111-111111111111');
    resolve({ ok: false, code: 'AbortError' });
    expect(await result).toBe('AbortError');
    expect(await h.run(`controller = new AbortController();controller.abort();
      navigator.credentials.get({signal:controller.signal,publicKey:{challenge:new Uint8Array(32)}})
      .catch(error=>error.name)`)).toBe('AbortError');
    expect(h.ipc.invoke).toHaveBeenCalledOnce();
  });
});
