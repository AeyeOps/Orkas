import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: (scope: string) => Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level =>
    [level, (...args: unknown[]) => console[level as 'info' | 'debug' | 'warn' | 'error'](`[${scope}]`, ...args)])),
}));
let root: string;
let previousRoot: string | undefined;
let previousMarker: string | undefined;
let replyMode: 'valid' | 'missing-dependency' | 'constant' | 'missing-vector';
let channels: number;
let smoke: typeof import('../../../src/main/features/library_smoke');
let embed: typeof import('../../../src/main/features/kb_embed');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-smoke-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousMarker = process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'workspace');
  process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE = path.join(root, 'ready.json');
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser('library-smoke-fixture');
  embed = await import('../../../src/main/features/kb_embed');
  replyMode = 'valid'; channels = 0;
  // This layer protects the acceptance oracle and real storage/revision path.
  // The release launch uses no factory override and loads the actual worker.
  embed._setEmbedChannelFactoryForTest(() => {
    channels++;
    let receive: (message: unknown) => void;
    return {
      onMessage: cb => { receive = cb; }, onExit: () => {}, kill: () => {},
      postMessage: (message: any) => queueMicrotask(() => {
        if (replyMode === 'missing-dependency') {
          receive({ id: message.id, ok: false, error: 'Cannot find module fixture-tokenizer' });
          return;
        }
        const texts: string[] = replyMode === 'missing-vector' ? message.texts.slice(1) : message.texts;
        const vectors = texts.map(text => {
          const vector = new Array(512).fill(0);
          const value = replyMode === 'constant' ? 1 : (text.includes('Global') ? 2 : 3);
          vector[0] = value / Math.sqrt(value * value + 1);
          vector[1] = 1 / Math.sqrt(value * value + 1);
          return vector;
        });
        receive({ id: message.id, ok: true, vectors });
      }),
    };
  });
  smoke = await import('../../../src/main/features/library_smoke');
});

afterEach(async () => {
  vi.restoreAllMocks();
  embed._setEmbedChannelFactoryForTest(null);
  (await import('../../../src/main/features/project_library_indexer'))._resetQueuesForTests();
  (await import('../../../src/main/features/vec_store')).closeAllVecStores();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  if (previousMarker === undefined) delete process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE;
  else process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE = previousMarker;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('packaged Library acceptance oracle', () => {
  it('requires search/read, replacement, persistence and scope isolation, and respawns its worker', async () => {
    expect(await smoke.runPackagedLibrarySmoke()).toEqual({
      embeddingDimensions: 512, workerRespawn: true, projectReady: true, projectSearchRead: true,
      revisionPersisted: true, staleRevisionRejected: true, globalSearchRead: true, scopeIsolated: true,
    });
    expect(channels).toBe(2);
  });

  it('refuses an ordinary installation before writing fixture documents or spawning a worker', async () => {
    delete process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE;
    await expect(smoke.runPackagedLibrarySmoke()).rejects.toThrow(/isolated launch marker/);
    expect(channels).toBe(0);
    expect(fs.existsSync(path.join(root, 'workspace/library-smoke-work'))).toBe(false);
  });

  it('refuses a marker paired with a different workspace', async () => {
    process.env.ORKAS_PACKAGED_LAUNCH_SMOKE_FILE = path.join(root, 'other/ready.json');
    await expect(smoke.runPackagedLibrarySmoke()).rejects.toThrow(/isolated storage/);
    expect(channels).toBe(0);
  });

  it.each(['missing-dependency', 'missing-vector', 'constant'] as const)(
    'cannot certify a shipped worker with %s output', async mode => {
      replyMode = mode;
      await expect(smoke.runPackagedLibrarySmoke()).rejects.toThrow(
        mode === 'missing-dependency' ? /Cannot find module/ : mode === 'constant' ? /constant placeholder/ : /count mismatch/,
      );
    },
  );

  it('rejects an acknowledged replacement that leaves the old Library bytes and chunks', async () => {
    const files = await import('../../../src/main/features/project_files');
    vi.spyOn(files, 'replaceProjectFileFromPath').mockResolvedValue({ ok: true } as any);
    await expect(smoke.runPackagedLibrarySmoke()).rejects.toThrow(/reopened current chunks/);
  });
});
