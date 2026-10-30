import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-model-ipc-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser('u_model_config');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function call(channel: string, payload: unknown = {}): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler(
    { sender: trustedIpcSender() },
    { channel, payload },
  );
}

describe('ipc › stored Orkas API credential', () => {
  it('deletes the shared key offline without exposing it or revoking remote connections', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const auth = await import('../../../src/main/features/auth');
    const registry = await import('../../../src/main/features/connectors/registry');
    const seedConnection = async () => registry.upsert('u_model_config', {
      id: 'gmail', display_name: 'Gmail', origin: 'catalog',
      transport: { kind: 'stdio', command: 'node', args: [] },
      enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
      status: { kind: 'connected' }, created_at: '', updated_at: '',
      composio_grant: {
        connection_id: 'legacy-connection', connection_token: 'a'.repeat(43),
        toolkit: 'gmail', auth_config_id: 'ac_legacy',
      },
    } as any);

    const firstKey = 'orkas-connector-key-xxxxxxxx';
    const paths = await import('../../../src/main/paths');
    const storeFile = paths.userAuthProfilesFile('u_model_config');
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 6,
      profiles: {},
      entries: [],
      orkasApiCredential: { key: firstKey },
    }));
    const saved = await call('orkasApi.getStatus');
    expect(saved).toMatchObject({ ok: true, configured: true, keyMasked: auth.maskKey(firstKey) });
    expect(JSON.stringify(saved)).not.toContain(firstKey);
    expect(auth.getOrkasApiKey()).toBe(firstKey);
    expect(await call('orkasApi.getStatus')).toMatchObject({
      ok: true, configured: true, keyMasked: saved.keyMasked,
    });

    await seedConnection();
    expect(await call('orkasApi.remove')).toMatchObject({ ok: true, removed: true });
    expect(await call('orkasApi.getStatus')).toMatchObject({ ok: true, configured: false });
    expect(registry.load('u_model_config').connections.gmail).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
