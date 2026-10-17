import * as path from 'path';
import { isPathAllowed, resolveSandboxRoot } from './path-sandbox';

const MAX_CLOUD_REL_PATH = 1024;

export function isSafeCloudRelPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (relPath.length > MAX_CLOUD_REL_PATH) return false;
  if (!relPath.startsWith('cloud/')) return false;
  if (relPath.includes('\\') || relPath.includes('\0')) return false;
  const parts = relPath.split('/');
  if (parts.length < 2) return false;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
    if (/^[A-Za-z]:/.test(part)) return false;
  }
  return true;
}

export function assertSafeCloudRelPath(relPath: string): string {
  if (!isSafeCloudRelPath(relPath)) {
    throw new Error(`unsafe cloud sync path: ${relPath}`);
  }
  return relPath;
}

/** Realpath a user cloud root once for a pass; see `resolveCloudRelPath`. */
export function resolveCloudRoot(root: string): string {
  return resolveSandboxRoot(path.resolve(root));
}

/**
 * Absolute on-disk path for a manifest rel_path, or a throw when the path
 * would leave `root` lexically or through a symlink. `resolvedRoot` is the
 * `resolveCloudRoot(root)` result; a pass that maps many paths supplies it so
 * the root's realpath walk is not repeated for every file. The candidate is
 * always resolved.
 */
export function resolveCloudRelPath(root: string, relPath: string, resolvedRoot?: string): string {
  assertSafeCloudRelPath(relPath);
  const base = path.resolve(root);
  const child = relPath.slice('cloud/'.length).split('/').join(path.sep);
  const abs = path.resolve(base, child);
  const rel = path.relative(base, abs);
  const contained = resolvedRoot
    ? isPathAllowed(abs, [resolvedRoot], { rootsResolved: true })
    : isPathAllowed(abs, [base]);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !contained) {
    throw new Error(`unsafe cloud sync path: ${relPath}`);
  }
  return abs;
}
