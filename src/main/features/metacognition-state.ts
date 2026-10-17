/** Shared deterministic contract for reflection and sync. Only these small
 * notes receive automatic text merging; other Markdown retains its own policy. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { userCloudRoot, userMetacognitionDraftsDir } from '../paths';
import { writeTextAtomicGuardedSync, writeBytesAtomic, writeJsonSync } from '../storage';
import { mergeThreeWayText } from '../util/three-way-text';

export const COMPETENCE_CHAR_LIMIT = 3000;
export const STRATEGIES_CHAR_LIMIT = 4000;
export const MAX_METACOGNITION_BYTES = 32 * 1024;

export function metacognitionLimit(relPath: string): number | null {
  const match = /^cloud\/agents\/[A-Za-z0-9_-]+\/meta\/(COMPETENCE|LEARNING_STRATEGIES)\.md$/.exec(relPath);
  return match ? match[1] === 'COMPETENCE' ? COMPETENCE_CHAR_LIMIT : STRATEGIES_CHAR_LIMIT : null;
}

export function textSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readSmallText(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_METACOGNITION_BYTES) return null;
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_METACOGNITION_BYTES) return null;
    const text = bytes.toString('utf8');
    return Buffer.from(text).equals(bytes) ? text : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function mergeMetacognition(relPath: string, base: string | null, local: string, remote: string): string | null {
  const limit = metacognitionLimit(relPath);
  if (limit === null) return null;
  const merged = local === remote ? local : base === null ? null : mergeThreeWayText(base, local, remote);
  return merged !== null && merged.length <= limit ? merged : null;
}

export function publishMetacognition(uid: string, relPath: string, expected: string | null, content: string): boolean {
  if (metacognitionLimit(relPath) === null) throw new Error('invalid metacognition target');
  const file = path.join(userCloudRoot(uid), relPath.slice('cloud/'.length));
  return writeTextAtomicGuardedSync(file, content, () => {
    // A missing file is distinct from an existing empty or unreadable file.
    if (expected === null) return !fs.existsSync(file);
    return readSmallText(file) === expected;
  });
}

/** Sync keeps temporary-file I/O and Windows retry delays off the event loop.
 * The shared storage helper performs the guard and rename synchronously. */
export async function publishMetacognitionAsync(uid: string, relPath: string, expected: string | null, content: string): Promise<boolean> {
  if (metacognitionLimit(relPath) === null) throw new Error('invalid metacognition target');
  const file = path.join(userCloudRoot(uid), relPath.slice('cloud/'.length));
  let published = false;
  await writeBytesAtomic(file, Buffer.from(content), { shouldCommit: () => {
    published = expected === null ? !fs.existsSync(file) : readSmallText(file) === expected;
    return published;
  } });
  return published;
}

/** Keep at most 16 private candidates per note, deduplicated by exact bytes.
 * Drafts are recovery data, never synced or projected into model prompts. */
export function retainMetacognitionDraft(uid: string, relPath: string, base: string | null, candidate: string): void {
  if (metacognitionLimit(relPath) === null) throw new Error('invalid metacognition target');
  const folder = path.join(userMetacognitionDraftsDir(uid), textSha(relPath));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${textSha((base ?? '') + '\0' + candidate)}.json`);
  writeJsonSync(file, { version: 1, rel_path: relPath, base, candidate, created_at_ms: Date.now() });
  const files = fs.readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(folder, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
  for (const old of files.slice(16)) fs.rmSync(path.join(folder, old.name), { force: true });
}
