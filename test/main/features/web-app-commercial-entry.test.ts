import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

vi.mock('electron', () => ({ app: { isPackaged: false }, dialog: {} }));
const uid = 'commercial-boundary';
const receipt = { ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' };
let root: string, previous: string | undefined, closeLogs: () => Promise<void>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-commercial-entry-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  await closeLogs();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function seed(dir: string, appType: string | undefined, manifest = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>Retained app</h1>');
  fs.writeFileSync(path.join(dir, '__orkas-meta.json'), JSON.stringify({
    title: 'Retained app', appType, entry: 'index.html', savedAt: '2026-10-01T00:00:00Z',
    sourceCid: 'historic', sourceArtifactId: 'historic',
  }));
  if (manifest) fs.writeFileSync(path.join(dir, 'orkas-app.json'), JSON.stringify({ sdkVersion: 1, capabilities: [] }));
}
function snapshot(dir: string): unknown {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
describe('commercial web application boundary', () => {
  it('inherits a web task binding even when a caller claims local or stored type is absent', async () => {
    const chats = await import('../../../src/main/features/chats');
    const conversation = await chats.createConversation(uid, { assistance: { kind: 'app_creation', appType: 'web' } });
    const cid = conversation.conversation_id;
    const paths = await import('../../../src/main/paths');
    const dir = path.join(paths.chatArtifactCidDir(uid, cid), 'historic');
    seed(dir, undefined);
    const before = snapshot(paths.userChatArtifactsDir(uid));
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    expect(await artifacts.createArtifact(uid, cid, 'commander', { appType: 'local', files: [] })).toMatchObject(receipt);
    const saved = await import('../../../src/main/features/saved_apps');
    expect(await saved.saveFromArtifact(uid, cid, 'historic')).toMatchObject(receipt);
    expect(await saved.saveFromPath(uid, path.join(dir, 'index.html'))).toMatchObject(receipt);
    const { previewBundle } = await import('../../../src/main/features/web_apps/preview');
    await expect(previewBundle(path.join(dir, 'index.html'))).rejects.toMatchObject(receipt);
    expect(snapshot(paths.userChatArtifactsDir(uid))).toEqual(before);
  });

  it.each(['{ damaged', '[]', '{"assistance":{"kind":"app_creation","appType":"unexpected"}}'])
  ('does not turn an unreadable task binding into local permission (%s)', async content => {
    const chats = await import('../../../src/main/features/chats');
    const { conversationLayout } = await import('../../../src/main/util/project-layout');
    const conversation = await chats.createConversation(uid, { assistance: { kind: 'app_creation', appType: 'web' } });
    const cid = conversation.conversation_id;
    fs.writeFileSync(conversationLayout(uid, cid).metaFile, content);
    vi.spyOn(chats, 'getConversationMetadata').mockResolvedValue(null);
    try {
      const artifacts = await import('../../../src/main/features/chat_artifacts');
      const paths = await import('../../../src/main/paths');
      const before = snapshot(paths.userChatArtifactsDir(uid));
      expect(await artifacts.createArtifact(uid, cid, 'commander', { appType: 'local', files: [{ path: 'index.html', content: '<h1>No grant</h1>' }] }))
        .toMatchObject({ ok: false });
      expect(snapshot(paths.userChatArtifactsDir(uid))).toEqual(before);
      expect(fs.readFileSync(conversationLayout(uid, cid).metaFile, 'utf8')).toBe(content);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['web', 'cloud'])('refuses direct %s SDK and preview acquisition', async appType => {
    const { WebAppRuntime } = await import('../../../src/main/features/web_apps/runtime');
    const called = vi.fn();
    const runtime = new WebAppRuntime({ activeUser: () => uid, language: () => 'en', modelAvailable: () => true,
      pick: called, save: called, generate: called, tools: called });
    const bundle = { key: 'direct', appType, entry: 'index.html', title: 'Retained',
      manifest: { sdkVersion: 1, capabilities: [] }, resolve: called } as any;
    expect(() => runtime.open(uid, 1, bundle)).toThrowError(expect.objectContaining(receipt));
    const { createPreviewSdk } = await import('../../../src/main/features/web_apps/preview');
    await expect(createPreviewSdk({} as any, {} as any, bundle)).rejects.toMatchObject(receipt);
    expect(called).not.toHaveBeenCalled();
  });
  it.each(['web', 'cloud'])('refuses explicit %s authoring before allocating artifact files', async appType => {
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    const paths = await import('../../../src/main/paths');
    const pool = paths.userChatArtifactsDir(uid), before = snapshot(pool);
    for (const files of [[], [{ path: 'index.html', content: '<h1>Must not be created</h1>' }]]) {
      expect(await artifacts.createArtifact(uid, 'new-task', 'commander', { appType, files })).toMatchObject(receipt);
      expect(snapshot(pool)).toEqual(before);
    }
  });

  it.each(['web', 'cloud'])('keeps the specific %s tool failure and never finalizes, smoke-tests or announces an artifact', async appType => {
    const { createLocalTools } = await import('../../../src/main/model/core-agent/local-tools');
    const paths = await import('../../../src/main/paths');
    const callback = vi.fn(), smoke = vi.fn();
    const tool = createLocalTools({ userId: uid, cid: 'tool-task', onArtifactCreated: callback, artifactInteractionSmoke: smoke })
      .find(tool => tool.name === 'create_artifact')!;
    const before = snapshot(paths.userChatArtifactsDir(uid));
    const result = await tool.execute({ appType, files: [{ path: 'index.html', content: '<h1>Refused</h1>' }] }, { workingDir: root, state: new Map() } as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content))).toMatchObject(receipt);
    expect(callback).not.toHaveBeenCalled(); expect(smoke).not.toHaveBeenCalled();
    expect(snapshot(paths.userChatArtifactsDir(uid))).toEqual(before);
  });

  it('preserves web edit journals and snapshots during local listing and background cleanup', async () => {
    const paths = await import('../../../src/main/paths');
    const edit = path.join(paths.userAppEditsDir(uid), 'historic-edit');
    seed(path.join(edit, 'snapshot'), 'web');
    seed(paths.savedAppDir(uid, 'historic-app'), 'web');
    seed(paths.savedAppDir(uid, 'historic-app.tmp-01234567'), 'web');
    fs.writeFileSync(path.join(edit, 'context.json'), JSON.stringify({ version: 1, appId: 'historic-app',
      appType: 'web', title: 'Retained app', fingerprint: '0'.repeat(64) }));
    fs.writeFileSync(path.join(edit, 'save-journal.json'), JSON.stringify({ version: 1, appId: 'historic-app',
      temporary: 'historic-app.tmp-01234567', before: '0'.repeat(64), after: '1'.repeat(64) }));
    const beforeEdits = snapshot(paths.userAppEditsDir(uid));
    const beforeApps = snapshot(paths.userSavedAppsDir(uid));
    const saved = await import('../../../src/main/features/saved_apps');
    saved.listSavedApps(uid);
    await saved.cleanupEditSnapshots(uid);
    expect(snapshot(paths.userAppEditsDir(uid))).toEqual(beforeEdits);
    expect(snapshot(paths.userSavedAppsDir(uid))).toEqual(beforeApps);
  });

  it.each(['web', 'cloud'])('preserves existing %s bundles when save, edit, open and preview are refused', async appType => {
    const paths = await import('../../../src/main/paths');
    const savedDir = paths.savedAppDir(uid, 'historic-app');
    const artifactDir = path.join(paths.chatArtifactCidDir(uid, 'historic'), 'historic');
    seed(savedDir, appType); seed(artifactDir, appType);
    const saved = await import('../../../src/main/features/saved_apps');
    const beforeSaved = snapshot(paths.userSavedAppsDir(uid));
    const beforeArtifact = snapshot(paths.userChatArtifactsDir(uid));
    const beforeEdits = snapshot(paths.userAppEditsDir(uid));
    expect(await saved.saveFromArtifact(uid, 'historic', 'historic')).toMatchObject(receipt);
    expect(await saved.saveFromArtifact(uid, 'historic', 'historic', 'update')).toMatchObject(receipt);
    expect(await saved.saveFromPath(uid, path.join(artifactDir, 'index.html'))).toMatchObject(receipt);
    expect(await saved.openForEditing(uid, 'historic-app')).toMatchObject(receipt);
    expect(await saved.appDataImpact(uid, 'historic', 'historic')).toMatchObject(receipt);
    const destination = path.join(root, 'export-refused');
    expect(await saved.exportAppData(uid, 'historic', 'historic', destination)).toMatchObject(receipt);
    expect(fs.existsSync(destination)).toBe(false);
    const { openApp } = await import('../../../src/main/features/web_apps/host');
    await expect(openApp(uid, 4, { appId: 'historic-app' })).rejects.toMatchObject(receipt);
    await expect(openApp(uid, 4, { cid: 'historic', artifactId: 'historic' })).rejects.toMatchObject(receipt);
    const { previewBundle } = await import('../../../src/main/features/web_apps/preview');
    await expect(previewBundle(path.join(artifactDir, 'index.html'))).rejects.toMatchObject(receipt);
    fs.unlinkSync(path.join(artifactDir, 'orkas-app.json'));
    await expect(previewBundle(path.join(artifactDir, 'index.html'))).rejects.toMatchObject(receipt);
    fs.writeFileSync(path.join(artifactDir, 'orkas-app.json'), JSON.stringify({ sdkVersion: 1, capabilities: [] }));
    expect(snapshot(paths.userSavedAppsDir(uid))).toEqual(beforeSaved);
    expect(snapshot(paths.userChatArtifactsDir(uid))).toEqual(beforeArtifact);
    expect(snapshot(paths.userAppEditsDir(uid))).toEqual(beforeEdits);
  });

  it('allows ordinary local authoring, saving and editing with the same SDK declaration', async () => {
    const artifacts = await import('../../../src/main/features/chat_artifacts');
    const saved = await import('../../../src/main/features/saved_apps');
    const created = await artifacts.createArtifact(uid, 'local-task', 'commander', { appType: 'local', files: [
      { path: 'index.html', content: '<h1>Local app</h1>' },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
    ] });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error);
    const stored = await saved.saveFromArtifact(uid, 'local-task', created.artifactId);
    expect(stored.ok).toBe(true); if (!stored.ok) throw new Error(stored.error);
    expect(await saved.openForEditing(uid, stored.id)).toMatchObject({ ok: true });
  });
});
