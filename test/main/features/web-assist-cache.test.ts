import * as fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userWebAssistCacheDir, userWebAssistProfileDir, WS_ROOT } from '../../../src/main/paths';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));
const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: warnings }) }));
const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let serial = 0;
let uid: string;
let profile: string;
let target: string;
let prepare: typeof import('../../../src/main/features/web_assist_cache').prepareWebAssistCache;
let sweep: typeof import('../../../src/main/features/web_assist_cache').sweepWebAssistCache;

async function put(file: string, value = 'retained') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
beforeEach(async () => {
  vi.resetModules();
  uid = `cache-${++serial}`;
  profile = userWebAssistProfileDir(uid);
  const sessionData = path.join(WS_ROOT, 'electron-cache-test');
  vi.mocked(app.getPath).mockReturnValue(sessionData);
  target = userWebAssistCacheDir(uid, sessionData);
  prepare = (await import('../../../src/main/features/web_assist_cache')).prepareWebAssistCache;
  sweep = (await import('../../../src/main/features/web_assist_cache')).sweepWebAssistCache;
  warnings.mockClear();
});

describe('startup HTTP cache retention', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const day = 86_400_000;
  const simpleHeader = Buffer.from('305c72a71b6dfbfc09000000000000000000000000000000', 'hex');
  const blockHeader = Buffer.from('c3ca03c10000030000000000000000000000000000000000', 'hex');
  let data: string;
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    data = path.join(profile, 'Cache/Cache_Data');
  });
  async function file(name: string, days = 8, content: string | Buffer = 'resource') {
    const pathname = path.join(data, name);
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, content);
    // Recent reads must not reset write age.
    await fs.utimes(pathname, new Date(now), new Date(now - days * day));
    return pathname;
  }
  async function seedSimple() {
    await file('index', 0, simpleHeader);
    await file('index-dir/the-real-index', 0, 'opaque index');
  }
  async function exists(name: string) {
    return fs.lstat(path.join(data, name)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  }

  it.each(['darwin', 'win32', 'linux'] as const)('%s deletes only wholly old simple entries and retains all website stores', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    await seedSimple();
    await file('0000000000000001_0');
    await file('0000000000000001_1');
    await file('0000000000000001_s');
    await file('0000000000000002_0');
    await file('0000000000000002_s', 1);
    await file('0000000000000003_0', 7);
    await file('0000000000000004_0', -1);
    await file('not-a-cache-entry', 100);
    const stores = ['Cookies', 'Local Storage/data', 'Session Storage/data', 'IndexedDB/data', 'Service Worker/CacheStorage/data', 'Shared Dictionary/cache/data', 'Code Cache/data'];
    for (const name of stores) await put(path.join(profile, name));
    const result = await sweep(uid);
    expect(result).toMatchObject({ status: 'complete', removedFiles: 3, removedBytes: 24 });
    expect(await exists('0000000000000001_0')).toBe(false);
    expect(await exists('0000000000000001_1')).toBe(false);
    expect(await exists('0000000000000001_s')).toBe(false);
    for (const name of ['0000000000000002_0', '0000000000000002_s', '0000000000000003_0', '0000000000000004_0', 'not-a-cache-entry', 'index']) expect(await exists(name)).toBe(true);
    expect(await exists('index-dir/the-real-index')).toBe(false);
    for (const name of stores) expect(await fs.readFile(path.join(profile, name), 'utf8')).toBe('retained');
    expect(warnings).not.toHaveBeenCalled();
  });

  it.skipIf(nativePlatform === 'win32')('cleans the published macOS HTTP target after restart without following other links', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await seedSimple();
    await file('0000000000000001_0');
    await prepare(uid);
    expect(await sweep(uid)).toMatchObject({ status: 'in-use', removedFiles: 0 });
    vi.resetModules();
    const restarted = await import('../../../src/main/features/web_assist_cache');
    expect(await restarted.sweepWebAssistCache(uid)).toMatchObject({ status: 'complete', removedFiles: 1 });
    expect(await exists('0000000000000001_0')).toBe(false);
    expect((await fs.lstat(path.join(profile, 'Cache'))).isSymbolicLink()).toBe(true);
  });

  it.each(nativePlatform === 'win32' ? ['win32'] : ['win32', 'darwin'])('%s keeps used profiles skipped for the process lifetime and isolates other accounts', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    await seedSimple();
    await file('0000000000000001_0');
    await prepare(uid);
    expect(await sweep(uid)).toMatchObject({ status: 'in-use', removedFiles: 0 });
    expect(await sweep(uid)).toMatchObject({ status: 'in-use', removedFiles: 0 });
    expect(await exists('0000000000000001_0')).toBe(true);
    expect(await sweep(`${uid}-unused`)).toMatchObject({ status: 'missing' });
  });

  it('lets an opening browser interrupt a sweep, finish its current entry and take exclusive ownership', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await seedSimple();
    for (const hash of ['0000000000000001', '0000000000000002']) {
      await file(`${hash}_0`); await file(`${hash}_s`);
    }
    const unlink = fs.unlink;
    let release!: () => void;
    let entered!: () => void;
    const reachedDelete = new Promise<void>(resolve => { entered = resolve; });
    const heldDelete = new Promise<void>(resolve => { release = resolve; });
    let deleting = '';
    vi.spyOn(fs, 'unlink').mockImplementation(async name => {
      if (!deleting && String(name).endsWith('_0')) {
        deleting = path.basename(String(name)).slice(0, 16);
        entered(); await heldDelete;
      }
      return unlink(name);
    });
    const cleanup = sweep(uid);
    expect(sweep(uid)).toBe(cleanup);
    await reachedDelete;
    let browserReady = false;
    const open = prepare(uid).then(() => { browserReady = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(browserReady).toBe(false);
    release();
    expect(await cleanup).toMatchObject({ status: 'interrupted', removedFiles: 2 });
    await open;
    expect(browserReady).toBe(true);
    const retained = deleting.endsWith('1') ? '0000000000000002' : '0000000000000001';
    expect(await exists(`${deleting}_s`)).toBe(false);
    expect(await exists(`${retained}_0`)).toBe(true);
    expect(await exists(`${retained}_s`)).toBe(true);
    expect(await sweep(uid)).toMatchObject({ status: 'in-use' });
  });

  it('does no filesystem work when the idle slice is already cancelled', async () => {
    await seedSimple(); await file('0000000000000001_0');
    const controller = new AbortController(); controller.abort();
    const scan = vi.spyOn(fs, 'opendir');
    expect(await sweep(uid, controller.signal)).toMatchObject({ status: 'interrupted', removedFiles: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect(await exists('index-dir/the-real-index')).toBe(true);
  });

  it.each(['unknown-backend', 'future-version', 'encrypted'])('preserves %s rather than guessing its layout', async variant => {
    const header = Buffer.from(simpleHeader);
    if (variant === 'unknown-backend') header.fill(0);
    if (variant === 'future-version') header.writeUInt32LE(10, 8);
    if (variant === 'encrypted') header.writeUInt32LE(1, 20);
    await file('index', 0, header); await file('0000000000000001_0');
    expect(await sweep(uid)).toMatchObject({ status: 'unsupported', removedFiles: 0 });
    expect(await exists('0000000000000001_0')).toBe(true);
  });

  it.skipIf(nativePlatform === 'win32').each(['entry', 'index', 'directory'])('does not follow a foreign %s symlink', async kind => {
    await seedSimple(); await file('0000000000000001_0');
    const outside = path.join(profile, 'Local Storage');
    await put(path.join(outside, 'retained'));
    const linked = kind === 'entry' ? '0000000000000001_s' : kind === 'index' ? 'index-dir' : '';
    if (kind === 'index') await fs.rm(path.join(data, linked), { recursive: true });
    if (kind === 'directory') await fs.rm(data, { recursive: true });
    await fs.symlink(outside, path.join(data, linked), 'dir');
    const result = await sweep(uid);
    expect(result.removedFiles).toBe(0);
    expect(await fs.readFile(path.join(outside, 'retained'), 'utf8')).toBe('retained');
    if (kind !== 'directory') expect(await exists('0000000000000001_0')).toBe(true);
    expect(warnings.mock.calls.length).toBe(kind === 'index' ? 1 : 0);
  });

  it.each(['index-dir/the-real-index', '0000000000000001_0'])('keeps entries on a Windows sharing violation at %s and permits opening', async denied => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await seedSimple(); await file('0000000000000001_0');
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async name => {
      if (String(name) === path.join(data, denied)) throw Object.assign(new Error('private path'), { code: 'EPERM' });
      return unlink(name);
    });
    expect(await sweep(uid)).toMatchObject({ status: 'failed', removedFiles: 0 });
    expect(await exists('0000000000000001_0')).toBe(true);
    await expect(prepare(uid)).resolves.toBeUndefined();
    expect(warnings).toHaveBeenCalledExactlyOnceWith('HTTP cache cleanup incomplete', { removedFiles: 0 });
  });

  it.each([1, 7, 8])('Windows blockfiles retain or retire the entire group when its newest file is %i days old', async newest => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await file('index', 8, blockHeader);
    await file('data_0', 8); await file('f_000001', newest);
    await put(path.join(profile, 'Cookies'));
    const result = await sweep(uid);
    expect(result).toMatchObject({ status: 'complete', removedFiles: newest > 7 ? 3 : 0 });
    expect(await exists('data_0')).toBe(newest <= 7);
    expect(await exists('f_000001')).toBe(newest <= 7);
    expect(await fs.readFile(path.join(profile, 'Cookies'), 'utf8')).toBe('retained');
  });

  it('recovers an interrupted blockfile purge without touching a newly created cache', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await file('index', 8, blockHeader); await file('data_0', 8);
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EPERM' }));
    expect(await sweep(uid)).toMatchObject({ status: 'failed' });
    expect(await exists('index')).toBe(false);
    await file('index', 0, blockHeader); await file('data_0', 0, 'new-cache');
    vi.mocked(fs.unlink).mockImplementation(unlink);
    vi.resetModules();
    const restarted = await import('../../../src/main/features/web_assist_cache');
    expect(await restarted.sweepWebAssistCache(uid)).toMatchObject({ status: 'complete', removedFiles: 2 });
    expect(await fs.readFile(path.join(data, 'data_0'), 'utf8')).toBe('new-cache');
    await expect(fs.stat(`${data}.orkas-expired`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a Windows shared cache intact when the directory is still locked', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await file('index', 8, blockHeader); await file('data_0', 8);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EPERM' }));
    expect(await sweep(uid)).toMatchObject({ status: 'failed', removedFiles: 0 });
    expect(await fs.readFile(path.join(data, 'index'))).toEqual(blockHeader);
    expect(await fs.readFile(path.join(data, 'data_0'), 'utf8')).toBe('resource');
    await expect(fs.stat(`${data}.orkas-expired`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(prepare(uid)).resolves.toBeUndefined();
    expect(warnings).toHaveBeenCalledExactlyOnceWith('HTTP cache cleanup incomplete', { removedFiles: 0 });
  });

  it('finishes old orphan streams on the next startup after a partial deletion failure', async () => {
    await seedSimple();
    await file('0000000000000001_0'); await file('0000000000000001_s');
    await file('0000000000000002_1', 1);
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async name => {
      if (String(name).endsWith('0000000000000001_s')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return unlink(name);
    });
    expect(await sweep(uid)).toMatchObject({ status: 'failed', removedFiles: 1 });
    expect(await exists('0000000000000001_0')).toBe(false);
    expect(await exists('0000000000000001_s')).toBe(true);
    vi.mocked(fs.unlink).mockImplementation(unlink);
    vi.resetModules();
    const restarted = await import('../../../src/main/features/web_assist_cache');
    expect(await restarted.sweepWebAssistCache(uid)).toMatchObject({ status: 'complete', removedFiles: 1 });
    expect(await exists('0000000000000001_s')).toBe(false);
    expect(await exists('0000000000000002_1')).toBe(true);
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
});

it.each(['win32', 'linux'] as const)('%s keeps native profile/cache paths without requesting link privileges', async platform => {
  Object.defineProperty(process, 'platform', { value: platform });
  await put(path.join(profile, 'Cache', 'entry'));
  await prepare(uid);
  expect((await fs.lstat(path.join(profile, 'Cache'))).isSymbolicLink()).toBe(false);
  expect(await fs.readFile(path.join(profile, 'Cache', 'entry'), 'utf8')).toBe('retained');
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

describe.skipIf(nativePlatform === 'win32')('macOS cache-only migration', () => {
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));

  it('preserves existing cache bytes and timestamps while leaving login and website stores in place', async () => {
    const stores = ['Cookies', 'Local Storage/leveldb/data', 'Session Storage/data', 'IndexedDB/data', 'Service Worker/CacheStorage/data', 'Shared Dictionary/db'];
    for (const name of stores) await put(path.join(profile, name), name);
    await put(path.join(profile, 'Cache/Cache_Data/entry'), 'http');
    await put(path.join(profile, 'Shared Dictionary/cache/entry'), 'dictionary');
    const old = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(path.join(profile, 'Cache/Cache_Data/entry'), old, old);
    const identities = await Promise.all(stores.map(name => fs.stat(path.join(profile, name))));
    await Promise.all([prepare(uid), prepare(uid)]);
    expect(await fs.readFile(path.join(target, 'http/Cache_Data/entry'), 'utf8')).toBe('http');
    expect((await fs.stat(path.join(target, 'http/Cache_Data/entry'))).mtime).toEqual(old);
    expect(await fs.readFile(path.join(target, 'dictionary/entry'), 'utf8')).toBe('dictionary');
    for (const [i, name] of stores.entries()) {
      expect(await fs.readFile(path.join(profile, name), 'utf8')).toBe(name);
      expect((await fs.stat(path.join(profile, name))).ino).toBe(identities[i].ino);
    }
    expect(await fs.realpath(path.join(profile, 'Cache'))).toBe(await fs.realpath(path.join(target, 'http')));
    expect((await fs.lstat(profile)).isSymbolicLink()).toBe(false);
    // A new process must recognize the published links, not migrate them again.
    vi.resetModules();
    await (await import('../../../src/main/features/web_assist_cache')).prepareWebAssistCache(uid);
    expect(await fs.readFile(path.join(profile, 'Cache/Cache_Data/entry'), 'utf8')).toBe('http');
  });

  it('isolates accounts and recreates only an externally removed cache target', async () => {
    await prepare(uid);
    await prepare(`${uid}-other`);
    await put(path.join(profile, 'Cache/account'), 'first');
    await expect(fs.stat(path.join(userWebAssistProfileDir(`${uid}-other`), 'Cache/account'))).rejects.toMatchObject({ code: 'ENOENT' });
    await put(path.join(profile, 'Local Storage/keep'));
    await fs.rm(path.join(target, 'http'), { recursive: true });
    vi.resetModules();
    await (await import('../../../src/main/features/web_assist_cache')).prepareWebAssistCache(uid);
    expect((await fs.stat(path.join(profile, 'Cache'))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(profile, 'Local Storage/keep'), 'utf8')).toBe('retained');
  });

  it.each(['after-backup', 'after-publish', 'after-link', 'lost-target', 'partial-staging'] as const)('resumes an interrupted migration %s without losing entries', async phase => {
    const backup = path.join(profile, 'Cache.orkas-migrating');
    await put(path.join(['after-backup', 'lost-target', 'partial-staging'].includes(phase) ? backup : path.join(target, 'http'), 'entry'));
    if (phase === 'partial-staging') await put(path.join(target, 'http.copying/incomplete'));
    if (phase === 'after-link' || phase === 'lost-target') {
      await put(path.join(backup, 'entry'));
      await fs.symlink(path.join(target, 'http'), path.join(profile, 'Cache'), 'dir');
    }
    await prepare(uid);
    expect(await fs.readFile(path.join(profile, 'Cache/entry'), 'utf8')).toBe('retained');
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(target, 'http.copying'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies across volumes asynchronously and retries a partial copy before publishing', async () => {
    await put(path.join(profile, 'Cache/entry'));
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.orkas-migrating')) throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const copy = fs.cp;
    const copySpy = vi.spyOn(fs, 'cp').mockImplementationOnce(async (_from, to) => {
      await put(path.join(String(to), 'partial'), 'incomplete');
      throw Object.assign(new Error('private-path'), { code: 'ENOSPC' });
    });
    await expect(prepare(uid)).rejects.toThrow('Browser cache preparation failed');
    expect(await fs.readFile(path.join(profile, 'Cache.orkas-migrating/entry'), 'utf8')).toBe('retained');
    await expect(fs.stat(path.join(profile, 'Cache'))).rejects.toMatchObject({ code: 'ENOENT' });
    copySpy.mockImplementation(copy);
    await prepare(uid);
    expect(await fs.readFile(path.join(profile, 'Cache/entry'), 'utf8')).toBe('retained');
    await expect(fs.stat(path.join(target, 'http/partial'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries link publication failure without replacing saved data', async () => {
    await put(path.join(profile, 'Cache/entry'));
    vi.spyOn(fs, 'symlink').mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EACCES' }));
    await expect(prepare(uid)).rejects.toThrow('Browser cache preparation failed');
    await prepare(uid);
    expect(await fs.readFile(path.join(profile, 'Cache/entry'), 'utf8')).toBe('retained');
  });

  it.each(['foreign-link', 'conflicting-target', 'file'] as const)('refuses %s without overwriting or following unrelated data', async kind => {
    const unrelated = path.join(WS_ROOT, `unrelated-${uid}`);
    await put(path.join(unrelated, 'keep'));
    await fs.mkdir(profile, { recursive: true });
    if (kind === 'foreign-link') await fs.symlink(unrelated, path.join(profile, 'Cache'), 'dir');
    if (kind === 'conflicting-target') {
      await put(path.join(profile, 'Cache/entry'));
      await put(path.join(target, 'http/foreign'));
    }
    if (kind === 'file') await put(path.join(profile, 'Cache'));
    await expect(prepare(uid)).rejects.toThrow('Browser cache preparation failed');
    expect(await fs.readFile(path.join(unrelated, 'keep'), 'utf8')).toBe('retained');
    if (kind === 'conflicting-target') expect(await fs.readFile(path.join(profile, 'Cache/entry'), 'utf8')).toBe('retained');
    if (kind === 'file') expect(await fs.readFile(path.join(profile, 'Cache'), 'utf8')).toBe('retained');
  });
});
