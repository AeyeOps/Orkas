/** HTTP cache maintenance and macOS sandbox repair. Never redirect the profile itself. */
import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { userRoot, userLocalRoot, userWebAssistCacheDir, userWebAssistProfileDir } from '../paths';
import { safeId } from '../storage';
import { createLogger } from '../logger';

const prepared = new Map<string, Promise<void>>();
const usedProfiles = new Set<string>();
const sweeps = new Map<string, { controller: AbortController; promise: Promise<CacheSweepResult> }>();
const log = createLogger('web-assist-cache');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheSweepResult {
  status: 'complete' | 'in-use' | 'interrupted' | 'missing' | 'unsupported' | 'failed';
  removedFiles: number;
  removedBytes: number;
}

async function stat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function directory(file: string): Promise<void> {
  await fs.mkdir(file, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(file)).isDirectory()) throw new Error('Invalid browser cache directory');
}

async function publishBackup(backup: string, target: string): Promise<void> {
  const staging = `${target}.copying`;
  try { await fs.rename(backup, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const partial = await stat(staging);
    if (partial && !partial.isDirectory()) throw new Error('Invalid browser cache staging');
    await fs.rm(staging, { recursive: true, force: true });
    // A cache should contain regular files/directories only. Do not copy
    // links that could expose website data outside these two cache trees.
    await fs.cp(backup, staging, {
      recursive: true, preserveTimestamps: true,
      filter: async file => {
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Unexpected browser cache entry');
        return true;
      },
    });
    await fs.rename(staging, target);
  }
}

async function redirect(source: string, target: string): Promise<void> {
  // The backup is also the recovery journal: no network context is opened until
  // both links are ready. Cross-volume copying never blocks the main event loop.
  const backup = `${source}.orkas-migrating`;
  await directory(path.dirname(source));
  await directory(path.dirname(target));
  const current = await stat(source);
  const saved = await stat(backup);
  const destination = await stat(target);
  if (saved && !saved.isDirectory()) throw new Error('Invalid browser cache migration');
  if (destination && !destination.isDirectory()) throw new Error('Invalid browser cache target');
  if (current?.isSymbolicLink()) {
    if (path.resolve(path.dirname(source), await fs.readlink(source)) !== target) {
      throw new Error('Unexpected browser cache link');
    }
    // Reconstructible caches may have been removed by the OS while closed.
    if (!destination && saved) await publishBackup(backup, target);
    else await directory(target);
  } else {
    if (current) {
      if (!current.isDirectory() || saved || destination) throw new Error('Conflicting browser cache migration');
      await fs.rename(source, backup);
    }
    if (!destination) {
      if (current || saved) {
        await publishBackup(backup, target);
      } else await directory(target);
    }
    await fs.symlink(target, source, 'dir');
  }
  // Remove only the duplicate after publication; this is not age-based eviction.
  await fs.rm(backup, { recursive: true, force: true });
  await fs.rm(`${target}.copying`, { recursive: true, force: true });
}

export async function prepareWebAssistCache(userId: string): Promise<void> {
  if (!safeId(userId)) throw new Error('Invalid browser cache owner');
  const profile = userWebAssistProfileDir(userId);
  // Reserve before the first await. Closing a view never releases its Session,
  // so this mark lasts until process exit, including failed open attempts.
  usedProfiles.add(profile);
  const sweep = sweeps.get(profile);
  sweep?.controller.abort();
  if (sweep) await sweep.promise;
  // Windows uses Chromium's native sandbox ACL grants; no junctions, symlink
  // privilege, drive migration or macOS sandbox workaround is needed there.
  if (process.platform !== 'darwin') return;
  const target = userWebAssistCacheDir(userId, app.getPath('sessionData'));
  const key = `${profile}\0${target}`;
  const existing = prepared.get(key);
  if (existing) return existing;
  const pending = (async () => {
    await directory(profile);
    await redirect(path.join(profile, 'Cache'), path.join(target, 'http'));
    await redirect(path.join(profile, 'Shared Dictionary', 'cache'), path.join(target, 'dictionary'));
  })().catch(() => {
    prepared.delete(key);
    // Native filesystem errors contain account paths. Keep the caller's existing
    // bounded failure signal and allow another open to retry the migration.
    throw new Error('Browser cache preparation failed');
  });
  prepared.set(key, pending);
  return pending;
}

async function cacheDirectory(userId: string): Promise<string | undefined> {
  const profile = userWebAssistProfileDir(userId);
  // Follow only our published macOS cache link, never a website-data link or
  // a junction replacing an account/profile subtree.
  for (const dir of [userRoot(userId), userLocalRoot(userId), path.dirname(profile), profile]) {
    const info = await stat(dir);
    if (!info) return undefined;
    if (!info.isDirectory()) throw new Error('Unexpected browser cache directory');
  }
  let cache = path.join(profile, 'Cache');
  const info = await stat(cache);
  if (!info) return undefined;
  if (info.isSymbolicLink()) {
    const target = userWebAssistCacheDir(userId, app.getPath('sessionData'));
    const expected = path.join(target, 'http');
    if (process.platform !== 'darwin' || path.resolve(path.dirname(cache), await fs.readlink(cache)) !== expected) {
      throw new Error('Unexpected browser cache link');
    }
    for (const dir of [path.dirname(target), target, expected]) {
      if (!(await stat(dir))?.isDirectory()) throw new Error('Unexpected browser cache target');
    }
    cache = expected;
  } else if (!info.isDirectory()) throw new Error('Unexpected browser cache directory');
  return cache;
}

async function cacheHeader(directory: string): Promise<Buffer | undefined> {
  const file = path.join(directory, 'index');
  if (!(await stat(file))?.isFile()) return undefined;
  // The blockfile index can be large. Only read its fixed backend identifier.
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(24);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length ? bytes : undefined;
  } finally { await handle.close(); }
}

function oldFile(info: Awaited<ReturnType<typeof stat>>, cutoff: number): boolean {
  return !!info?.isFile() && Number.isFinite(info.mtimeMs) && info.mtimeMs > 0 && info.mtimeMs < cutoff;
}

async function pruneSimpleCache(directory: string, cutoff: number, stopped: () => boolean, result: CacheSweepResult): Promise<void> {
  let indexInvalidated = false;
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (stopped()) return;
    if (!entry.isFile() || !/^[0-9a-f]{16}_[01s]$/.test(entry.name)) continue;
    const hash = entry.name.slice(0, 16);
    const files = ['0', '1', 's'].map(suffix => path.join(directory, `${hash}_${suffix}`));
    const infos = await Promise.all(files.map(file => stat(file)));
    // All streams belong to one entry; a recently written side stream keeps
    // the entire entry. Access times and index last-use times are not age.
    // Process each group through its first surviving stream, including an
    // orphan left when a previous process failed partway through unlinking.
    const first = infos.findIndex(info => !!info);
    if (first < 0 || files[first] !== path.join(directory, entry.name)
      || infos.some(info => info && !oldFile(info, cutoff))) continue;
    if (stopped()) return;
    if (!indexInvalidated) {
      const indexDir = path.join(directory, 'index-dir');
      const indexInfo = await stat(indexDir);
      if (indexInfo && !indexInfo.isDirectory()) throw new Error('Unexpected browser cache index');
      const index = path.join(indexDir, 'the-real-index');
      const info = await stat(index);
      if (info && !info.isFile()) throw new Error('Unexpected browser cache index');
      // Chromium rebuilds a missing real index from surviving entry files.
      // Invalidate BEFORE unlink so an interruption cannot publish stale sizes.
      // Keep the separate "index" backend/version marker intact.
      if (info) await fs.unlink(index);
      indexInvalidated = true;
    }
    if (stopped()) return;
    // Finish the current entry before handing the directory to Session creation.
    // An I/O failure stops the sweep; only already-eligible files can be lost.
    for (const [i, file] of files.entries()) {
      if (!infos[i]) continue;
      await fs.unlink(file);
      result.removedFiles++;
      result.removedBytes += infos[i]!.size;
    }
  }
}

async function allBlockFilesOld(directory: string, cutoff: number, stopped: () => boolean): Promise<boolean> {
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (stopped()) return false;
    if (!entry.isFile() || !/^(?:index|data_[0-9]+|f_[0-9a-f]{6,})$/.test(entry.name)
      || !oldFile(await stat(path.join(directory, entry.name)), cutoff)) return false;
  }
  return true;
}

async function purgeRetiredBlockCache(directory: string, cutoff: number, stopped: () => boolean, result: CacheSweepResult): Promise<void> {
  const info = await stat(directory);
  if (!info) return;
  if (!info.isDirectory() || !await allBlockFilesOld(directory, cutoff, stopped)) return;
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (stopped()) return;
    const file = path.join(directory, entry.name);
    const info = await stat(file);
    if (!oldFile(info, cutoff)) return;
    await fs.unlink(file);
    result.removedFiles++;
    result.removedBytes += info!.size;
  }
  await fs.rmdir(directory);
}

/** One startup attempt, before this profile has ever been reserved for a Session.
 * HTTP Cache_Data only: never scan cookies, dictionaries, Code Cache or website
 * CacheStorage. Formats verified against Chromium 148's simple_version_upgrade,
 * simple_util, simple_index_file and blockfile/disk_format. Unknown formats stay.
 */
export function sweepWebAssistCache(userId: string, signal?: AbortSignal): Promise<CacheSweepResult> {
  if (!safeId(userId)) return Promise.reject(new Error('Invalid browser cache owner'));
  const profile = userWebAssistProfileDir(userId);
  const result: CacheSweepResult = { status: 'complete', removedFiles: 0, removedBytes: 0 };
  if (usedProfiles.has(profile)) return Promise.resolve({ ...result, status: 'in-use' });
  const existing = sweeps.get(profile);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const stopped = () => controller.signal.aborted || !!signal?.aborted;
  const cutoff = Date.now() - WEEK_MS;
  const promise = (async () => {
    try {
      if (stopped()) { result.status = 'interrupted'; return result; }
      const cache = await cacheDirectory(userId);
      if (!cache) { result.status = 'missing'; return result; }
      const directory = path.join(cache, 'Cache_Data');
      const retired = path.join(cache, 'Cache_Data.orkas-expired');
      // Resume only our detached, old blockfile group after an interrupted purge.
      await purgeRetiredBlockCache(retired, cutoff, stopped, result);
      if (stopped()) { result.status = 'interrupted'; return result; }
      const info = await stat(directory);
      if (!info) { result.status = 'missing'; return result; }
      if (!info.isDirectory()) { result.status = 'unsupported'; return result; }
      const header = await cacheHeader(directory);
      if (header?.readBigUInt64LE(0) === 0xfcfb6d1ba7725c30n
        && header.readUInt32LE(8) === 9 && header.subarray(12).every(byte => byte === 0)) {
        await pruneSimpleCache(directory, cutoff, stopped, result);
      } else if (header?.readUInt32LE(0) === 0xc103cac3 && header.readUInt32LE(4) === 0x30000) {
        // Windows defaults to shared blockfiles. Never tear individual entries
        // out of them: retire only when EVERY file (including index) is old.
        if (!await stat(retired) && await allBlockFilesOld(directory, cutoff, stopped) && !stopped()) {
          await fs.rename(directory, retired);
          await purgeRetiredBlockCache(retired, cutoff, stopped, result);
        }
      } else result.status = 'unsupported';
      if (stopped()) result.status = 'interrupted';
    } catch {
      result.status = 'failed';
      log.warn('HTTP cache cleanup incomplete', { removedFiles: result.removedFiles });
    }
    return result;
  })();
  sweeps.set(profile, { controller, promise });
  return promise;
}
