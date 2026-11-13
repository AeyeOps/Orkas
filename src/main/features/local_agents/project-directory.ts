/** Device-owned conversation cwd. Legacy cloud values need local provenance;
 * existence alone cannot establish that a path belongs to this conversation.
 * Synchronous atomic migration cannot interleave with another main-process writer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { localCliDirectoryFile, localCliSessionsFile, userAgentRuntimeConfigFile } from '../../paths';
import { writeTextAtomicSync } from '../../storage';
import { t } from '../../i18n';

interface DirectoryRecord {
  version: 1;
  directory: string;
  explicit: boolean;
  needs_confirmation?: boolean;
  working_directory?: string;
  directory_ids?: string[];
}

export interface CodingDirectoryState {
  working_directory?: string;
  directory_ids?: string[];
  coding_project_dir?: string;
  coding_project_dir_explicit?: boolean;
  coding_project_dir_pending?: string;
}

function readObject(file: string): Record<string, any> | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(t('errors.cli_directory_storage'));
  }
}

function writeRecord(uid: string, cid: string, record: DirectoryRecord): void {
  const file = localCliDirectoryFile(uid, cid);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeTextAtomicSync(file, JSON.stringify(record, null, 2), 'utf8', { mode: 0o600 });
  }
  catch { throw new Error(t('errors.cli_directory_storage')); }
}

function hasLocalProvenance(uid: string, cid: string, directory: string): boolean {
  if (!path.isAbsolute(directory)) return false;
  const canonical = path.resolve(directory);
  // These two existing device files are read-only migration evidence. Their
  // owning modules remain the sole writers of sessions and Agent settings.
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  const sessions = readObject(localCliSessionsFile(uid, cid));
  if (Object.values(sessions || {}).some((r: any) => r?.sessionId && r.cwdFingerprint === fingerprint)) return true;
  const settings = readObject(userAgentRuntimeConfigFile(uid));
  return Object.values(settings?.project_dirs || {}).some((r: any) => (
    typeof r?.path === 'string' && path.isAbsolute(r.path) && path.resolve(r.path) === canonical
  ));
}

export function readCodingDirectory(uid: string, cid: string, legacy?: CodingDirectoryState | (() => CodingDirectoryState)): CodingDirectoryState {
  let record = readObject(localCliDirectoryFile(uid, cid)) as DirectoryRecord | null;
  if (!record) {
    const source = typeof legacy === 'function' ? legacy() : legacy;
    const directory = typeof source?.coding_project_dir === 'string' ? source.coding_project_dir.trim() : '';
    record = {
      version: 1, directory, explicit: source?.coding_project_dir_explicit === true,
      ...(directory && !hasLocalProvenance(uid, cid, directory) ? { needs_confirmation: true } : {}),
    };
    // Even an empty record is a migration tombstone: a later remote upload
    // from an old client must never become new local selection authority.
    writeRecord(uid, cid, record);
  }
  if (record.version !== 1 || typeof record.directory !== 'string'
    || typeof record.explicit !== 'boolean'
    || (record.needs_confirmation !== undefined && typeof record.needs_confirmation !== 'boolean')
    || (record.directory && !record.needs_confirmation && !path.isAbsolute(record.directory))
    || (record.working_directory !== undefined && (typeof record.working_directory !== 'string' || !path.isAbsolute(record.working_directory)))
    || (record.directory_ids !== undefined && (!Array.isArray(record.directory_ids) || record.directory_ids.some(id => typeof id !== 'string')))) {
    throw new Error(t('errors.cli_directory_storage'));
  }
  const workingDirectory = {
    ...(record.working_directory ? { working_directory: record.working_directory } : {}),
    ...(record.directory_ids ? { directory_ids: record.directory_ids } : {}),
  };
  if (!record.directory) return workingDirectory;
  if (record.needs_confirmation) return { ...workingDirectory, coding_project_dir_pending: record.directory };
  return {
    ...workingDirectory,
    coding_project_dir: record.directory,
    ...(record.explicit ? { coding_project_dir_explicit: true } : {}),
  };
}

/** An unreadable migration source must remain retryable; never freeze an
 * empty choice merely because the normal cloud-state reader fell back. */
export function readCodingDirectoryFromStateFile(uid: string, cid: string, file: string): CodingDirectoryState {
  return readCodingDirectory(uid, cid, () => readObject(file) || {});
}

export function writeCodingDirectory(uid: string, cid: string, directory: string, explicit: boolean, needsConfirmation = false): void {
  if (directory && !needsConfirmation && !path.isAbsolute(directory)) throw new Error(t('errors.path_not_dir'));
  const existing = readObject(localCliDirectoryFile(uid, cid)) as DirectoryRecord | null;
  writeRecord(uid, cid, { version: 1, directory, explicit: !!directory && explicit,
    ...(existing?.working_directory ? { working_directory: existing.working_directory } : {}),
    ...(existing?.directory_ids ? { directory_ids: existing.directory_ids } : {}),
    ...(directory && needsConfirmation ? { needs_confirmation: true } : {}),
  });
}

export function writeWorkingDirectory(uid: string, cid: string, directory: string | undefined, directoryIds: string[]): void {
  if (directory !== undefined && !path.isAbsolute(directory)) throw new Error(t('errors.path_not_dir'));
  const record = readObject(localCliDirectoryFile(uid, cid)) as DirectoryRecord | null;
  writeRecord(uid, cid, { version: 1, directory: '', explicit: false, ...record,
    ...(directory ? { working_directory: directory } : {}), directory_ids: directoryIds });
}

/** Never serialize the effective local overlay into cloud state. */
export function cloudConversationState<T extends Record<string, any>>(state: T): T {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const keys = ['coding_project_dir', 'coding_project_dir_explicit', 'coding_project_dir_pending', 'working_directory', 'directory_ids'];
  if (!keys.some((key) => Object.prototype.hasOwnProperty.call(state, key))) return state;
  const cloud = { ...state };
  for (const key of keys) delete cloud[key];
  return cloud;
}

export function removeCodingDirectory(uid: string, cid: string): void {
  fs.rmSync(localCliDirectoryFile(uid, cid), { force: true });
}

export function inspectCodingDirectory(directory: string): { kind: 'available' | 'missing' | 'denied' | 'unavailable'; code?: string } {
  try { return fs.statSync(directory).isDirectory() ? { kind: 'available' } : { kind: 'missing', code: 'ENOTDIR' }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing'
      : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable', code };
  }
}
