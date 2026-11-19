/**
 * User Workspace — manages the user-facing working directory(s).
 *
 * Each user can select a local directory as their "workspace" where agent
 * output, intermediate products, and final deliverables are stored. If no
 * directory has been chosen, the default `userWorkSpace/` folder (created at
 * startup by paths.ensureLayout) is used.
 *
 * **Scoped selection** (per CLAUDE.md §4 sync-domain split):
 *   - The default scope (no project) keeps using the existing
 *     `<uid>/local/workspace.json` config.
 *   - Each project optionally pins its own workspace; conversations under a
 *     project share that scope. Effective resolution:
 *       conv.project_id → projects[pid]?.selectedPath
 *                       ?? default.selectedPath
 *                       ?? DEFAULT_USER_WORKSPACE
 *
 * The on-disk file goes from a flat
 *   `{ selectedPath, recentPaths, updatedAt }`
 * to a scoped object
 *   `{ default: {selectedPath, recentPaths}, projects: {<pid>: {...}}, updatedAt }`
 * — `_normaliseConfig` migrates the legacy shape on first read (no
 * schema_version field; absence of `default` key is the migration signal).
 *
 * **Resolver shape**: `getWorkspacePath(uid, projectId?)` is **synchronous**.
 * Callers that have a cid (file-tools, group_chat bus, etc.) thread the
 * `project_id` through their opts pipeline rather than re-reading the conv
 * index per tool call — group_chat resolves the projectId once at the top
 * of `runTurn` and passes it down. IPC handlers that take `{cid?}` from the
 * renderer perform the cid → projectId lookup at the IPC boundary (async
 * there is fine — single hop) before calling the sync resolver.
 *
 * The Electron dialog for folder selection is triggered from IPC; this
 * module owns the config read/write + validation logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dialog, BrowserWindow, shell } from 'electron';

import { DEFAULT_USER_WORKSPACE, localCliDirectoryFile, userWorkspaceConfigFile } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { macosTccSensitivePath } from '../util/macos-tcc';
import { logErrorSummary, logPathRef, logPathRefs, maskId } from '../util/log-redact';
import { pruneOrphans } from './file_indexer';

const log = createLogger('user-workspace');

// ── Config persistence ──────────────────────────────────────────────────

/** A single workspace selection entry — used for both the default scope and
 *  per-project scopes. `selectedPath` empty means "fall back to next level"
 *  (project → default → DEFAULT_USER_WORKSPACE). */
interface ScopeEntry {
  selectedPath: string;
  recentPaths: string[];
  /** Persisted selection-time classification. A protected workspace remains
   *  usable, but passive workspace resolution must not probe it on macOS. */
  macosTccSensitive?: boolean;
  pinnedDefault?: boolean;
}

interface WorkspaceConfig {
  default: ScopeEntry;
  projects: Record<string, ScopeEntry>;
  conversations: Record<string, ScopeEntry>;
  updatedAt: string;
}

function configPath(userId: string): string {
  return userWorkspaceConfigFile(userId);
}

const MAX_RECENT = 5;
const EMPTY_ENTRY: ScopeEntry = { selectedPath: '', recentPaths: [] };
const _tccClassificationMigrationChecked = new Set<string>();

function _normaliseEntry(raw: any): ScopeEntry {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ENTRY };
  const selectedPath = typeof raw.selectedPath === 'string' ? raw.selectedPath : '';
  return {
    selectedPath,
    recentPaths: Array.isArray(raw.recentPaths)
      ? raw.recentPaths.filter((p: unknown) => typeof p === 'string')
      : [],
    ...(raw.macosTccSensitive === true
      ? { macosTccSensitive: true }
      : {}),
    ...(!selectedPath && raw.pinnedDefault === true
      ? { pinnedDefault: true }
      : {}),
  };
}

/** Promote legacy flat `{selectedPath, recentPaths}` → scoped shape. */
function _normaliseConfig(raw: any): WorkspaceConfig {
  if (!raw || typeof raw !== 'object') {
    return { default: { ...EMPTY_ENTRY }, projects: {}, conversations: {}, updatedAt: '' };
  }
  if (raw.default && typeof raw.default === 'object') {
    const projects: Record<string, ScopeEntry> = {};
    if (raw.projects && typeof raw.projects === 'object') {
      for (const [pid, entry] of Object.entries(raw.projects)) {
        if (typeof pid === 'string') projects[pid] = _normaliseEntry(entry);
      }
    }
    const conversations: Record<string, ScopeEntry> = {};
    if (raw.conversations && typeof raw.conversations === 'object') {
      for (const [cid, entry] of Object.entries(raw.conversations)) {
        if (typeof cid === 'string') conversations[cid] = _normaliseEntry(entry);
      }
    }
    return {
      default: _normaliseEntry(raw.default),
      projects,
      conversations,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  }
  // Legacy flat shape — promote into `default`.
  return {
    default: _normaliseEntry(raw),
    projects: {},
    conversations: {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function readConfig(userId: string): WorkspaceConfig {
  const p = configPath(userId);
  let cfg: WorkspaceConfig;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    cfg = _normaliseConfig(JSON.parse(raw));
  } catch {
    return { default: { ...EMPTY_ENTRY }, projects: {}, conversations: {}, updatedAt: '' };
  }
  // A short-lived release accepted symlink aliases into TCC roots before the
  // classification field existed. Resolve those legacy entries once, persist
  // only a positive classification, and avoid repeating that probe on every
  // workspace read or app launch.
  if (!_tccClassificationMigrationChecked.has(p)) {
    _tccClassificationMigrationChecked.add(p);
    if (_markMacosTccSensitiveSelections(cfg)) {
      try { writeConfig(userId, cfg); }
      catch (err) {
        log.warn('workspace TCC classification migration could not be persisted', {
          error_type: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }
  return cfg;
}

function writeConfig(userId: string, cfg: WorkspaceConfig): void {
  const p = configPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

// ── Scope helpers ────────────────────────────────────────────────────────

function _readEntry(cfg: WorkspaceConfig, projectId?: string): ScopeEntry {
  if (projectId) {
    return cfg.projects[projectId] || { ...EMPTY_ENTRY };
  }
  return cfg.default;
}

function _writeEntry(cfg: WorkspaceConfig, projectId: string | undefined, entry: ScopeEntry): WorkspaceConfig {
  if (projectId) {
    return {
      ...cfg,
      projects: { ...cfg.projects, [projectId]: entry },
      updatedAt: new Date().toISOString(),
    };
  }
  return { ...cfg, default: entry, updatedAt: new Date().toISOString() };
}

function _macosTccSensitiveWorkspacePath(
  dirPath: string,
): ReturnType<typeof macosTccSensitivePath> {
  return macosTccSensitivePath(path.resolve(dirPath), { recursive: true });
}

/** Classify an explicitly selected path before persisting it so a symlink or
 * case-variant alias cannot disguise a protected macOS root. The direct
 * lexical check runs first and therefore never probes a known TCC directory.
 * Protected selections are allowed; the classification tells passive callers
 * to use the stored path without touching the directory. */
function _resolveWorkspaceSelection(dirPath: string): {
  path: string;
  macosTccSensitive: boolean;
} {
  const lexicalPath = path.resolve(dirPath);
  const lexicalSensitivity = _macosTccSensitiveWorkspacePath(lexicalPath);
  if (lexicalSensitivity) return { path: lexicalPath, macosTccSensitive: true };
  let canonicalPath = lexicalPath;
  try { canonicalPath = fs.realpathSync.native(lexicalPath); }
  catch { /* setWorkspacePath/stat below returns the canonical missing-path error */ }
  return {
    // Preserve the user-facing spelling (including /var vs /private/var and
    // safe symlink aliases); canonicalPath is only security-comparison input.
    path: lexicalPath,
    macosTccSensitive: !!_macosTccSensitiveWorkspacePath(canonicalPath),
  };
}

function _entryIsMacosTccSensitive(entry: ScopeEntry): boolean {
  if (entry.macosTccSensitive === true) return true;
  if (_macosTccSensitiveWorkspacePath(entry.selectedPath)) return true;
  return _resolveWorkspaceSelection(entry.selectedPath).macosTccSensitive;
}

function _markMacosTccSensitiveSelections(cfg: WorkspaceConfig): boolean {
  let changed = false;
  const entries = [cfg.default, ...Object.values(cfg.projects), ...Object.values(cfg.conversations)];
  for (const entry of entries) {
    if (!entry.selectedPath || entry.macosTccSensitive === true) continue;
    if (_resolveWorkspaceSelection(entry.selectedPath).macosTccSensitive) {
      entry.macosTccSensitive = true;
      changed = true;
    }
  }
  return changed;
}

/** The coding directory a conversation created before workspace pinning
 *  inherited from the workspace on its first coding turn, or ''. */
function _inheritedCliDirectory(userId: string, cid: string): string {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(localCliDirectoryFile(userId, cid), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(t('errors.cli_directory_storage'), { cause: err });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(t('errors.cli_directory_storage'));
  }
  if (
    typeof data.directory === 'string'
    && data.directory
    && data.explicit === false
    && !data.needs_confirmation
    && path.isAbsolute(data.directory)
  ) {
    return path.resolve(data.directory);
  }
  return '';
}

function _resolveDirectoryOrFallback(
  dirPath: string,
  tccSensitive: boolean,
  onMissing?: () => void,
): string | null {
  if (tccSensitive) return path.resolve(dirPath);
  try {
    if (fs.statSync(dirPath).isDirectory()) return path.resolve(dirPath);
  } catch {
    if (onMissing) onMissing();
  }
  return null;
}

/** Effective path for a given scope: conversation's selection (if any) →
 *  project's selection (if any) → default's selection (if any) →
 *  DEFAULT_USER_WORKSPACE. A macOS privacy-protected selection is returned
 *  without stat: it came from the native picker, while background scanners
 *  independently opt out before walking TCC roots. */
function _effectivePath(cfg: WorkspaceConfig, projectId?: string, cid?: string, userId?: string): string {
  if (cid && userId) {
    const convEntry = cfg.conversations[cid];
    if (convEntry?.pinnedDefault) return DEFAULT_USER_WORKSPACE;
    if (convEntry?.selectedPath) {
      const resolved = _resolveDirectoryOrFallback(
        convEntry.selectedPath,
        _entryIsMacosTccSensitive(convEntry),
        () => log.warn('conversation workspace path missing — falling back', {
          cid: maskId(cid), path: logPathRef(convEntry.selectedPath),
        }),
      );
      if (resolved) return resolved;
    } else {
      const inherited = _inheritedCliDirectory(userId, cid);
      if (inherited) {
        const resolved = _resolveDirectoryOrFallback(inherited, !!_macosTccSensitiveWorkspacePath(inherited));
        if (resolved) return resolved;
      }
    }
  }
  if (projectId) {
    const entry = cfg.projects[projectId];
    if (entry?.selectedPath) {
      const resolved = _resolveDirectoryOrFallback(
        entry.selectedPath,
        _entryIsMacosTccSensitive(entry),
        () => log.warn('project workspace path missing — falling back to default', {
          project_id: maskId(projectId), path: logPathRef(entry.selectedPath),
        }),
      );
      if (resolved) return resolved;
    }
  }
  if (cfg.default.selectedPath) {
    const resolved = _resolveDirectoryOrFallback(
      cfg.default.selectedPath,
      _entryIsMacosTccSensitive(cfg.default),
      () => log.warn('default workspace path missing — using DEFAULT_USER_WORKSPACE', {
        path: logPathRef(cfg.default.selectedPath),
      }),
    );
    if (resolved) return resolved;
  }
  return DEFAULT_USER_WORKSPACE;
}

function _configuredDisplayPath(cfg: WorkspaceConfig, projectId?: string): string {
  if (projectId) {
    const projectSelected = cfg.projects[projectId]?.selectedPath;
    if (projectSelected) return projectSelected;
  }
  const selected = cfg.default.selectedPath;
  if (selected) return selected;
  return DEFAULT_USER_WORKSPACE;
}

function _isManagedWorkspaceRoot(dirPath: string): boolean {
  const root = path.resolve(DEFAULT_USER_WORKSPACE);
  const target = path.resolve(dirPath || '');
  return target === root || target.startsWith(root + path.sep);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Synchronous resolver. `projectId` is optional — when omitted the default
 * scope is used. Callers with a cid in scope should resolve cid → project_id
 * once via `chats.getConversation` (async) and pass `projectId` through
 * their downstream opts (group_chat does this at the top of runTurn,
 * threading through ChatOptions / LocalToolsOpts / FileToolsOpts).
 */
export function getWorkspacePath(userId: string, projectId?: string, cid?: string): string {
  const cfg = readConfig(userId);
  return _effectivePath(cfg, projectId, cid, userId);
}

/**
 * Native file pickers should always be seeded with a safe Orkas-owned default
 * path. The historical marker file is ignored now; keeping the function name
 * avoids churn in IPC call sites while preventing macOS from restoring a
 * process-wide last-used Photos/Desktop/Library location.
 */
export function consumePickerFirstOpenDefault(userId: string): string | undefined {
  if (!userId) return undefined;
  try {
    const workspacePath = getWorkspacePath(userId);
    return _macosTccSensitiveWorkspacePath(workspacePath)
      ? DEFAULT_USER_WORKSPACE
      : workspacePath;
  }
  catch { return undefined; }
}

/**
 * Async helper that does the cid → project_id lookup before calling the
 * sync resolver. IPC handlers that take `{cid?}` from the renderer use
 * this; main-side feature code that already knows the projectId should
 * call `getWorkspacePath` directly.
 */
export async function resolveProjectIdForCid(userId: string, cid?: string): Promise<string | undefined> {
  if (!cid) return undefined;
  try {
    const { getConversation } = await import('./chats');
    const conv = await getConversation(userId, cid);
    const pid = (conv as any)?.project_id;
    return typeof pid === 'string' && pid ? pid : undefined;
  } catch (err) {
    log.warn('resolve project id for conversation failed', {
      cid: maskId(cid),
      error: logErrorSummary(err),
    });
    return undefined;
  }
}

function _nextScopeRecents(oldEntry: ScopeEntry, nextSelectedPath?: string): string[] {
  const recents = (oldEntry.recentPaths || []).slice();
  if (oldEntry.selectedPath && oldEntry.selectedPath !== nextSelectedPath) {
    const idx = recents.indexOf(oldEntry.selectedPath);
    if (idx !== -1) recents.splice(idx, 1);
    recents.unshift(oldEntry.selectedPath);
  }
  if (nextSelectedPath) {
    const newIdx = recents.indexOf(nextSelectedPath);
    if (newIdx !== -1) recents.splice(newIdx, 1);
  }
  return recents.slice(0, MAX_RECENT);
}

function _withParentRecent(
  cfg: WorkspaceConfig,
  projectId: string | undefined,
  recentPath: string | undefined,
): WorkspaceConfig {
  if (!recentPath) return cfg;
  const parentEntry = _readEntry(cfg, projectId);
  if (
    recentPath === parentEntry.selectedPath
    || path.resolve(recentPath) === path.resolve(DEFAULT_USER_WORKSPACE)
  ) {
    return cfg;
  }
  const parentRecents = (parentEntry.recentPaths || []).filter((p) => p !== recentPath);
  parentRecents.unshift(recentPath);
  return _writeEntry(cfg, projectId, {
    ...parentEntry,
    recentPaths: parentRecents.slice(0, MAX_RECENT),
  });
}

/**
 * Persist a user-chosen workspace path for a given scope. Ordinary paths are
 * validated on disk. A macOS TCC-sensitive path comes from NSOpenPanel and is
 * persisted without another probe so selection itself does not cause a second
 * authorization attempt. Returns `{ ok: true, path }` or `{ ok: false, error }`.
 */
export function setWorkspacePath(
  userId: string,
  dirPath: string,
  projectId?: string,
  cid?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const selection = _resolveWorkspaceSelection(dirPath);
  const resolved = selection.path;
  if (!selection.macosTccSensitive) {
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) return { ok: false, error: t('errors.path_not_dir') };
    } catch {
      return { ok: false, error: t('errors.dir_not_exists') };
    }
  }

  const cfg = readConfig(userId);
  if (cid) {
    const oldConv = cfg.conversations[cid] || { ...EMPTY_ENTRY };
    const nextParentCfg = _withParentRecent(cfg, projectId, resolved);
    const next: WorkspaceConfig = {
      ...nextParentCfg,
      conversations: {
        ...nextParentCfg.conversations,
        [cid]: {
          selectedPath: resolved,
          recentPaths: _nextScopeRecents(oldConv, resolved),
          ...(selection.macosTccSensitive ? { macosTccSensitive: true } : {}),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    writeConfig(userId, next);
    log.info('workspace path updated', {
      user_id: maskId(userId),
      project_id: projectId ? maskId(projectId) : '(default)',
      cid: maskId(cid),
      path: logPathRef(resolved),
    });
    return { ok: true, path: resolved };
  }

  const oldEntry = _readEntry(cfg, projectId);
  const next = _writeEntry(cfg, projectId, {
    selectedPath: resolved,
    recentPaths: _nextScopeRecents(oldEntry, resolved),
    ...(selection.macosTccSensitive ? { macosTccSensitive: true } : {}),
  });
  writeConfig(userId, next);
  log.info('workspace path updated', {
    user_id: maskId(userId),
    project_id: projectId ? maskId(projectId) : '(default)',
    path: logPathRef(resolved),
  });
  _sweepFileCacheForWorkspace(userId, resolved);
  return { ok: true, path: resolved };
}

/**
 * Reset the given scope's selection. After reset, the effective path falls
 * through to the parent scope (project → default → DEFAULT_USER_WORKSPACE),
 * or pins DEFAULT_USER_WORKSPACE when resetting a conversation scope.
 */
export function resetWorkspacePath(userId: string, projectId?: string, cid?: string): { ok: true; path: string } {
  const cfg = readConfig(userId);
  if (cid) {
    const oldConv = cfg.conversations[cid] || { ...EMPTY_ENTRY };
    const nextParentCfg = _withParentRecent(cfg, projectId, oldConv.selectedPath);
    const next: WorkspaceConfig = {
      ...nextParentCfg,
      conversations: {
        ...nextParentCfg.conversations,
        [cid]: {
          selectedPath: '',
          recentPaths: _nextScopeRecents(oldConv),
          pinnedDefault: true,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    writeConfig(userId, next);

    const effective = DEFAULT_USER_WORKSPACE;
    log.info('workspace path reset', {
      user_id: maskId(userId),
      project_id: projectId ? maskId(projectId) : '(default)',
      cid: maskId(cid),
      effective: logPathRef(effective),
    });
    return { ok: true, path: effective };
  }

  const oldEntry = _readEntry(cfg, projectId);
  const next = _writeEntry(cfg, projectId, {
    selectedPath: '',
    recentPaths: _nextScopeRecents(oldEntry),
  });
  writeConfig(userId, next);

  const effective = _effectivePath(next, projectId);
  log.info('workspace path reset', {
    user_id: maskId(userId),
    project_id: projectId ? maskId(projectId) : '(default)',
    effective: logPathRef(effective),
  });
  _sweepFileCacheForWorkspace(userId, effective);
  return { ok: true, path: effective };
}

/** Pin a newly created conversation's workspace so later default/project
 *  changes do not shift it. */
export function pinConversationWorkspace(userId: string, cid: string, projectId?: string): void {
  const cfg = readConfig(userId);
  const sourceEntry = (projectId && cfg.projects[projectId]?.selectedPath)
    ? cfg.projects[projectId]
    : cfg.default;
  writeConfig(userId, {
    ...cfg,
    conversations: {
      ...cfg.conversations,
      [cid]: sourceEntry.selectedPath
        ? {
          selectedPath: sourceEntry.selectedPath,
          recentPaths: [],
          ...(sourceEntry.macosTccSensitive ? { macosTccSensitive: true } : {}),
        }
        : { selectedPath: '', recentPaths: [], pinnedDefault: true },
    },
    updatedAt: new Date().toISOString(),
  });
}

function _sweepFileCacheForWorkspace(userId: string, workspacePath: string): void {
  pruneOrphans(userId, { workspacePath })
    .then((r) => {
      if (r.deleted > 0) {
        log.info('file cache sweep on workspace switch completed', {
          user_id: maskId(userId),
          deleted: r.deleted,
          workspace_path: logPathRef(workspacePath),
        });
      }
    })
    .catch((err) => {
      log.warn('file cache sweep on workspace switch failed', {
        user_id: maskId(userId),
        workspace_path: logPathRef(workspacePath),
        error: logErrorSummary(err),
      });
    });
}

/**
 * Return full workspace info for rendering the dropdown. `scope` tells the
 * UI which bucket the chip is acting on so the chip tooltip can show
 * context.
 */
export function getWorkspaceInfo(userId: string, projectId?: string, cid?: string): {
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  recentPaths: string[];
  scope: 'default' | 'project' | 'conversation';
  projectId?: string;
  cid?: string;
} {
  const cfg = readConfig(userId);
  if (cid) {
    const convEntry = cfg.conversations[cid];
    const inherited = convEntry?.pinnedDefault || convEntry?.selectedPath ? '' : _inheritedCliDirectory(userId, cid);
    let currentPath: string;
    let isDefault: boolean;
    if (convEntry?.pinnedDefault) {
      currentPath = DEFAULT_USER_WORKSPACE;
      isDefault = true;
    } else if (convEntry?.selectedPath) {
      currentPath = convEntry.selectedPath;
      isDefault = false;
    } else if (inherited) {
      currentPath = inherited;
      isDefault = path.resolve(currentPath) === path.resolve(DEFAULT_USER_WORKSPACE);
    } else {
      currentPath = _configuredDisplayPath(cfg, projectId);
      isDefault = !(projectId && cfg.projects[projectId]?.selectedPath) && !cfg.default.selectedPath;
    }
    const parentEntry = projectId ? cfg.projects[projectId] : cfg.default;
    const rawRecents = [
      ...(convEntry?.recentPaths || []),
      ...(parentEntry?.selectedPath ? [parentEntry.selectedPath] : []),
      ...(parentEntry?.recentPaths || []),
    ];
    const recentPaths: string[] = [];
    const seenRecents = new Set<string>();
    for (const p of rawRecents) {
      if (!p || p === currentPath || p === DEFAULT_USER_WORKSPACE || seenRecents.has(p)) continue;
      if (_macosTccSensitiveWorkspacePath(p)) continue;
      seenRecents.add(p);
      recentPaths.push(p);
      if (recentPaths.length >= MAX_RECENT) break;
    }
    return {
      currentPath,
      defaultPath: DEFAULT_USER_WORKSPACE,
      isDefault,
      recentPaths,
      scope: 'conversation',
      ...(projectId ? { projectId } : {}),
      cid,
    };
  }

  const entry = _readEntry(cfg, projectId);
  // This runs on renderer boot to paint the workspace chip. It uses configured
  // strings only and never touches external directories.
  const currentPath = _configuredDisplayPath(cfg, projectId);
  const isDefault = !entry.selectedPath;
  const recentPaths = (entry.recentPaths || [])
    .filter((p) => p !== currentPath && p !== DEFAULT_USER_WORKSPACE)
    // Re-select protected recents through NSOpenPanel so the action carries
    // fresh user intent instead of causing a passive filesystem probe.
    .filter((p) => !_macosTccSensitiveWorkspacePath(p))
    .slice(0, MAX_RECENT);
  return {
    currentPath,
    defaultPath: DEFAULT_USER_WORKSPACE,
    isDefault,
    recentPaths,
    scope: projectId ? 'project' : 'default',
    ...(projectId ? { projectId } : {}),
  };
}

function _safeDirectoryPickerDefault(): string | undefined {
  const abs = path.resolve(DEFAULT_USER_WORKSPACE);
  if (_macosTccSensitiveWorkspacePath(abs)) return undefined;
  try { fs.mkdirSync(abs, { recursive: true }); } catch { /* best-effort; stat below decides */ }
  try { return fs.statSync(abs).isDirectory() ? abs : undefined; }
  catch { return undefined; }
}

/**
 * Open a native folder picker dialog and return the selected path, or
 * `null` if the user cancelled. Must be called from the main process.
 */
export async function selectDirectory(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win ? win : undefined as any, {
    title: t('workspace.picker_title'),
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: _safeDirectoryPickerDefault(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * Sweep every workspace root the user has selected (default + each
 * per-project), removing any empty top-level subdirectory. Existing empty
 * per-conversation slug dirs (legacy from before bash's cold-path
 * rmdir-if-empty was added in `local-tools.ts`, or any future tool that
 * mkdir'd then produced nothing) get cleaned up on every boot. Best-effort:
 * any rmdir failure (non-empty / EACCES / concurrent in-flight bash) is
 * silently swallowed.
 *
 * Only the immediate top level of each workspace is scanned; deeper empty
 * subdirs are the user's own scaffolding and out of scope.
 */
export function sweepEmptyConvDirs(userId: string): { swept: number } {
  const cfg = readConfig(userId);
  const roots = new Set<string>();
  const addManagedRoot = (root: string | undefined) => {
    if (root && _isManagedWorkspaceRoot(root)) roots.add(path.resolve(root));
  };
  roots.add(path.resolve(DEFAULT_USER_WORKSPACE));
  addManagedRoot(cfg.default.selectedPath);
  for (const entry of Object.values(cfg.projects)) {
    addManagedRoot(entry?.selectedPath);
  }
  for (const entry of Object.values(cfg.conversations)) {
    addManagedRoot(entry?.selectedPath);
  }
  let swept = 0;
  for (const root of roots) {
    let entries: string[];
    try { entries = fs.readdirSync(root); }
    catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;  // .DS_Store, .git, etc.
      const sub = path.join(root, name);
      try {
        const st = fs.statSync(sub);
        if (!st.isDirectory()) continue;
        if (fs.readdirSync(sub).length !== 0) continue;
        fs.rmdirSync(sub);
        swept++;
      } catch { /* best-effort */ }
    }
  }
  if (swept > 0) log.info('swept empty workspace subdirs', {
    user_id: maskId(userId),
    swept,
    roots: logPathRefs(Array.from(roots)),
  });
  return { swept };
}

/**
 * Reveal a user's current workspace directory in the OS file manager
 * (Finder / Explorer / Nautilus). Falls back to the default directory if the
 * selection is gone.
 */
export async function openWorkspaceInFileManager(
  userId: string,
  projectId?: string,
  cid?: string,
): Promise<
  | {
    ok: true;
    path: string;
    fallbackUsed?: true;
    fallbackReason?: 'selected_unavailable';
  }
  | { ok: false; error: string }
> {
  const cfg = readConfig(userId);
  let configuredPath = '';
  if (cid) {
    const convEntry = cfg.conversations[cid];
    configuredPath = (convEntry?.pinnedDefault ? DEFAULT_USER_WORKSPACE : convEntry?.selectedPath)
      || _inheritedCliDirectory(userId, cid)
      || (projectId && cfg.projects[projectId]?.selectedPath
        ? cfg.projects[projectId].selectedPath
        : cfg.default.selectedPath);
  } else {
    // A project with no explicit selection normally inherits the default
    // workspace. That is not a degradation. Only mark a fallback when the
    // first configured candidate for this scope differs from the effective
    // path because the configured candidate can no longer be used.
    configuredPath = projectId && cfg.projects[projectId]?.selectedPath
      ? cfg.projects[projectId].selectedPath
      : cfg.default.selectedPath;
  }
  const target = _effectivePath(cfg, projectId, cid, userId);
  const fallbackUsed = !!configuredPath
    && path.resolve(configuredPath) !== path.resolve(target);
  // This is an explicit user action. Delegate availability and directory
  // handling to the OS instead of probing first: a preflight stat can trigger
  // macOS Files & Folders authorization before Finder opens.
  const err = await shell.openPath(target);
  if (err) {
    log.warn('failed to open workspace path', {
      user_id: maskId(userId),
      path: logPathRef(target),
      error: logErrorSummary(new Error(err)),
    });
    return { ok: false, error: err };
  }
  if (fallbackUsed) {
    return {
      ok: true,
      path: target,
      fallbackUsed: true,
      fallbackReason: 'selected_unavailable',
    };
  }
  return { ok: true, path: target };
}

/** Drop a project's per-project workspace entry from this user's
 *  workspace.json. Called by `projects.deleteProject` cascade so deleting a
 *  project doesn't leave a dangling pid → path entry on disk. */
export function purgeProjectWorkspace(userId: string, projectId: string): void {
  const cfg = readConfig(userId);
  if (!cfg.projects[projectId]) return;
  const next: WorkspaceConfig = { ...cfg, projects: { ...cfg.projects }, updatedAt: new Date().toISOString() };
  delete next.projects[projectId];
  try { writeConfig(userId, next); }
  catch (err) {
    log.warn('purge project workspace failed', {
      user_id: maskId(userId),
      project_id: maskId(projectId),
      error: logErrorSummary(err),
    });
  }
}

/** Drop a deleted conversation's workspace entry from workspace.json. */
export function purgeConversationWorkspace(userId: string, cid: string): void {
  if (!cid) return;
  const cfg = readConfig(userId);
  if (!cfg.conversations[cid]) return;
  const next: WorkspaceConfig = {
    ...cfg,
    conversations: { ...cfg.conversations },
    updatedAt: new Date().toISOString(),
  };
  delete next.conversations[cid];
  try { writeConfig(userId, next); }
  catch (err) {
    log.warn('purge conversation workspace failed', {
      user_id: maskId(userId),
      cid: maskId(cid),
      error: logErrorSummary(err),
    });
  }
}
