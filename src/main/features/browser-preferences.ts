import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { shell } from 'electron';
import { resolveBackgroundNodeRuntime } from '../util/background-node';
import { userBrowserPreferenceFile } from '../paths';
import { writeTextAtomicSync } from '../storage';
import { getActiveUserId } from './users';

export interface BrowserProfile {
  executable: string;
  userDataDir: string;
  profileDirectory: string;
  label: string;
}

function readOptionalFile(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function profileNames(userDataDir: string): Array<{ directory: string; name: string }> {
  const source = readOptionalFile(path.join(userDataDir, 'Local State'));
  if (source === null) return [];
  const cache = JSON.parse(source).profile?.info_cache || {};
  return Object.entries(cache).map(([directory, info]: [string, { name?: string }]) => ({
    directory,
    name: info.name || directory,
  }));
}

function executableOnPath(names: string[]): string | null {
  for (const name of names) {
    const directories = path.isAbsolute(name) ? [''] : (process.env.PATH || '').split(path.delimiter);
    for (const directory of directories) {
      const candidate = path.isAbsolute(name) ? name : path.join(directory, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
      catch (error) {
        if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code)) throw error;
      }
    }
  }
  return null;
}

function desktopArguments(command: string): string[] {
  const args: string[] = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  for (const char of command) {
    if (escaped) { token += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (/\s/.test(char) && !quoted) {
      if (token) args.push(token);
      token = '';
    } else token += char;
  }
  if (quoted || escaped) return [];
  if (token) args.push(token);
  return args;
}

export function listBrowserProfiles(): BrowserProfile[] {
  const home = os.homedir();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programs = process.env.ProgramFiles || 'C:\\Program Files';
  const definitions = process.platform === 'darwin' ? [
    ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Library/Application Support/Google/Chrome')],
    ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium', path.join(home, 'Library/Application Support/Chromium')],
    ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(home, 'Library/Application Support/Microsoft Edge')],
    ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')],
  ] : process.platform === 'win32' ? [
    ['Google Chrome', path.join(programs, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/User Data')],
    ['Chromium', path.join(local, 'Chromium/Application/chrome.exe'), path.join(local, 'Chromium/User Data')],
    ['Microsoft Edge', path.join(process.env['ProgramFiles(x86)'] || programs, 'Microsoft/Edge/Application/msedge.exe'), path.join(local, 'Microsoft/Edge/User Data')],
    ['Brave', path.join(programs, 'BraveSoftware/Brave-Browser/Application/brave.exe'), path.join(local, 'BraveSoftware/Brave-Browser/User Data')],
  ] : [
    ['Google Chrome', 'google-chrome-stable|google-chrome', path.join(config, 'google-chrome')],
    ['Chromium', 'chromium|chromium-browser', path.join(config, 'chromium')],
    ['Microsoft Edge', 'microsoft-edge-stable|microsoft-edge', path.join(config, 'microsoft-edge')],
    ['Brave', 'brave-browser|brave', path.join(config, 'BraveSoftware/Brave-Browser')],
  ];
  const installations: Array<{ label: string; executable: string; userDataDir: string; directory?: string }> = [];
  for (const [label, candidates, userDataDir] of definitions) {
    const executable = executableOnPath(candidates.split('|'));
    if (executable) installations.push({ label, executable, userDataDir });
  }
  if (process.platform === 'linux') {
    const applications = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications');
    let entries: string[];
    try { entries = fs.readdirSync(applications); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }
    for (const entry of entries.filter(name => name.endsWith('.desktop'))) {
      const text = fs.readFileSync(path.join(applications, entry), 'utf8');
      const section = text.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0];
      const command = section?.match(/^Exec=(.*)$/m)?.[1];
      if (!command || !command.includes('--user-data-dir')) continue;
      const args = desktopArguments(command);
      if (args.some(arg => arg === '--app' || arg.startsWith('--app=') || arg === '--app-id' || arg.startsWith('--app-id=') || /^https?:\/\//.test(arg))) continue;
      const option = (name: string) => {
        const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
        return index < 0 ? undefined : args[index] === name ? args[index + 1] : args[index].slice(name.length + 1);
      };
      const userDataDir = option('--user-data-dir');
      const executable = args.length ? executableOnPath([args[0]]) : null;
      if (!executable || !userDataDir || !path.isAbsolute(userDataDir)) continue;
      installations.push({
        label: section.match(/^Name=(.*)$/m)?.[1] || entry.slice(0, -8),
        executable, userDataDir, directory: option('--profile-directory'),
      });
    }
  }
  const profiles: BrowserProfile[] = [];
  for (const install of installations) {
    for (const profile of profileNames(install.userDataDir)) {
      if (install.directory && install.directory !== profile.directory) continue;
      if (profiles.some(row => row.userDataDir === install.userDataDir && row.profileDirectory === profile.directory)) continue;
      profiles.push({
        executable: install.executable,
        userDataDir: install.userDataDir,
        profileDirectory: profile.directory,
        label: `${install.label} · ${profile.name}`,
      });
    }
  }
  return profiles;
}

function parseBrowserProfile(input: unknown): BrowserProfile {
  const profile = input as BrowserProfile;
  if (!profile || typeof profile.executable !== 'string' || !path.isAbsolute(profile.executable)
    || typeof profile.userDataDir !== 'string' || !path.isAbsolute(profile.userDataDir)
    || typeof profile.profileDirectory !== 'string' || !profile.profileDirectory
    || ['.', '..'].includes(profile.profileDirectory)
    || path.basename(profile.profileDirectory) !== profile.profileDirectory
    || typeof profile.label !== 'string' || !profile.label) {
    throw new Error('Invalid browser profile');
  }
  return { executable: profile.executable, userDataDir: profile.userDataDir, profileDirectory: profile.profileDirectory, label: profile.label };
}

function requireBrowserProfile(profile: BrowserProfile): void {
  if (!fs.statSync(profile.executable).isFile()) throw new Error('Browser executable is not a file');
  fs.accessSync(profile.executable, fs.constants.X_OK);
  if (!fs.statSync(profile.userDataDir).isDirectory()) throw new Error('Browser data path is not a directory');
  if (!profileNames(profile.userDataDir).some(row => row.directory === profile.profileDirectory)) {
    throw new Error('Browser profile was not found in the selected data directory');
  }
}

export function getBrowserPreference(uid: string): BrowserProfile | null {
  const source = readOptionalFile(userBrowserPreferenceFile(uid));
  if (source === null) return null;
  const value = JSON.parse(source);
  return value === null ? null : parseBrowserProfile(value);
}

export function setBrowserPreference(uid: string, input: unknown): BrowserProfile | null {
  const profile = input === null ? null : parseBrowserProfile(input);
  if (profile) requireBrowserProfile(profile);
  const file = userBrowserPreferenceFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomicSync(file, JSON.stringify(profile, null, 2), 'utf8', { mode: 0o600 });
  return profile;
}

export function customBrowserProfile(executable: string, userDataDir: string, profileName: string): BrowserProfile {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)
    || typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)
    || typeof profileName !== 'string' || !profileName) throw new Error('Enter an absolute browser executable path, an absolute data directory and a profile name');
  const profiles = profileNames(userDataDir);
  const matches = profiles.filter(row => row.directory === profileName || row.name === profileName);
  if (matches.length !== 1) throw new Error(matches.length ? 'More than one profile has that name; enter its folder name' : 'Profile name was not found in this browser data directory');
  return parseBrowserProfile({ executable, userDataDir, profileDirectory: matches[0].directory, label: `${path.basename(executable)} · ${matches[0].name}` });
}

function browserArgs(profile: BrowserProfile): string[] {
  return [`--user-data-dir=${profile.userDataDir}`, `--profile-directory=${profile.profileDirectory}`, '--new-window'];
}

export async function openBrowserUrl(url: string, uid = getActiveUserId()): Promise<void> {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) { await shell.openExternal(url); return; }
  const profile = getBrowserPreference(uid);
  if (!profile) { await shell.openExternal(url); return; }
  requireBrowserProfile(profile);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(profile.executable, [...browserArgs(profile), url], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function browserLoginEnvironment(uid: string, env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const profile = getBrowserPreference(uid);
  if (!profile || process.platform !== 'linux') return { env, cleanup: () => {} };
  requireBrowserProfile(profile);
  const runtime = resolveBackgroundNodeRuntime();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-browser-'));
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const helper = path.join(directory, 'open.cjs');
  fs.writeFileSync(helper, [
    "const { spawn } = require('node:child_process');",
    `const env = { ...process.env, PATH: ${JSON.stringify(env.PATH)} };`,
    'delete env.ELECTRON_RUN_AS_NODE;',
    env.BROWSER ? `env.BROWSER = ${JSON.stringify(env.BROWSER)};` : 'delete env.BROWSER;',
    `const child = spawn(${JSON.stringify(profile.executable)}, [...${JSON.stringify(browserArgs(profile))}, ...process.argv.slice(2)], { detached: true, stdio: 'ignore', env });`,
    "child.once('error', () => { process.exitCode = 1; });",
    "child.once('spawn', () => child.unref());",
  ].join('\n'));
  fs.writeFileSync(path.join(directory, 'orkas-browser'), `#!/bin/sh\nexec ${runtime.electronAsNode ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(runtime.executable)} ${quote(helper)} "$@"\n`, { mode: 0o700 });
  return {
    env: { ...env, BROWSER: 'orkas-browser', PATH: `${directory}${path.delimiter}${env.PATH || ''}` },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
