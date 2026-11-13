import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { userLocalConfigDir } from '../paths';
import { writeTextAtomicSync } from '../storage';

export interface WorkingDirectory {
  id: string;
  path: string;
}

function registryFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'working-directories.json');
}

export function listWorkingDirectories(uid: string): WorkingDirectory[] {
  let text: string;
  try {
    text = fs.readFileSync(registryFile(uid), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string'
    || !/^wd_[0-9a-f-]{36}$/.test(row.id) || typeof row.path !== 'string' || !path.isAbsolute(row.path))) {
    throw new Error('Invalid saved working directories');
  }
  return rows;
}

export function requireWorkingDirectory(uid: string, id: string): WorkingDirectory {
  const directory = listWorkingDirectories(uid).find(row => row.id === id);
  if (!directory) throw new Error('Working directory is not saved on this device');
  return directory;
}

export function assertWorkingDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error('Working directory must be an absolute path');
  if (!fs.statSync(directory).isDirectory()) throw new Error('Working directory is not a directory');
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
}

export function addWorkingDirectory(uid: string, directory: string): WorkingDirectory {
  assertWorkingDirectory(directory);
  const resolved = fs.realpathSync(directory);
  const rows = listWorkingDirectories(uid);
  const existing = rows.find(row => row.path === resolved);
  if (existing) return existing;
  const added = { id: `wd_${randomUUID()}`, path: resolved };
  const file = registryFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomicSync(file, JSON.stringify([...rows, added], null, 2), 'utf8', { mode: 0o600 });
  return added;
}

export function workingDirectoriesContext(uid: string, currentPath: string, directoryIds?: readonly string[]): string {
  const directories = listWorkingDirectories(uid).filter(row => directoryIds === undefined || directoryIds.includes(row.id));
  if (!directories.length) return '';
  return [
    '## Saved working directories',
    `Current working directory: ${JSON.stringify(currentPath)}`,
    'These directories are saved on this device. Discover their project skills through skill search or the Orkas skills tools. Directory discovery does not change the current working directory. Use a saved directory id when setting an automation working_directory_id.',
    ...directories.map(directory => `- ${JSON.stringify(path.basename(directory.path))}: ${JSON.stringify(directory.path)} (id: ${directory.id})`),
  ].join('\n');
}
