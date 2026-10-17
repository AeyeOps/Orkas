import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ rows: [] as any[], quiet: true,
  archive: vi.fn(), remove: vi.fn(), discard: vi.fn() }));
vi.mock('../../../src/main/features/chats', () => ({
  listCleanupConversationRows: async () => mocks.rows,
  getConversationMetadata: async (_uid: string, cid: string) => mocks.rows.find(r => r.conversation_id === cid) || null,
  deleteConversation: (...args: any[]) => mocks.remove(...args),
}));
vi.mock('../../../src/main/features/group_chat/bus', () => ({ isQuiescent: () => mocks.quiet }));
vi.mock('../../../src/main/features/recycle_bin', () => ({
  createAppRecycleBatchForConversation: (...args: any[]) => mocks.archive(...args),
  deleteRecycleBatch: (...args: any[]) => mocks.discard(...args),
}));
let root: string;
let previous: string | undefined;
const uid = 'cleanup-user';
const old = '2020-01-01T00:00:00Z';
async function seed(cid = 'old-done', updates: any = {}, status = 'done') {
  const { conversationLayout } = await import('../../../src/main/util/project-layout');
  if (updates.project_id) {
    const { projectMetaFile } = await import('../../../src/main/paths');
    const file = projectMetaFile(uid, updates.project_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ project_id: updates.project_id, name: 'Fixture project' }));
  }
  const layout = conversationLayout(uid, cid, updates.project_id || null);
  fs.mkdirSync(path.dirname(layout.stateFile), { recursive: true });
  fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'idle', in_flight: [], last_active_at: old }));
  fs.writeFileSync(path.join(path.dirname(layout.stateFile), 'tasks.json'), JSON.stringify([
    { task_id: 't1', created_by: 'user', source_msg_id: 'm1', created_at: old, ended_at: old, status },
  ]));
  const row = { conversation_id: cid, title: cid, kind: 'normal', created_at: old, updated_at: old, ...updates };
  mocks.rows.push(row);
  return { row, layout };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cleanup-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks(); mocks.rows = []; mocks.quiet = true;
  mocks.archive.mockResolvedValue({ id: 'backup', items: [{ path: 'history' }] });
  mocks.discard.mockResolvedValue(undefined);
  mocks.remove.mockImplementation(async (_uid, cid, _hint, guard) => {
    const row = mocks.rows.find(r => r.conversation_id === cid);
    if (!await guard(row)) return false;
    mocks.rows = mocks.rows.filter(r => r !== row);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    // Let pending file-handle callbacks run between Windows cleanup retries.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } finally {
    if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previous;
  }
});

describe('safe historical task cleanup', () => {
  it('keeps corrupt state and a recent completion even when its index is stale', async () => {
    const corrupt = await seed('corrupt');
    fs.writeFileSync(corrupt.layout.stateFile, '{');
    const recent = await seed('recent-result');
    fs.writeFileSync(path.join(path.dirname(recent.layout.stateFile), 'tasks.json'), JSON.stringify([
      { created_by: 'user', created_at: old, status: 'done', ended_at: new Date().toISOString() },
    ]));
    const api = await import('../../../src/main/features/task_cleanup');
    expect((await api.preview(uid, { days: 90, protectedIds: [] })).total).toBe(0);
  });
  it('keeps a failed sibling of the latest user request while allowing an older recovered failure', async () => {
    const first = await seed('mixed');
    const second = await seed('recovered');
    const prior = { created_by: 'user', source_msg_id: 'prior', created_at: '2019-01-01', ended_at: old, status: 'failed' };
    const done = { created_by: 'user', source_msg_id: 'latest', created_at: old, ended_at: old, status: 'done' };
    fs.writeFileSync(path.join(path.dirname(first.layout.stateFile), 'tasks.json'), JSON.stringify([done, { ...done, status: 'failed' }]));
    fs.writeFileSync(path.join(path.dirname(second.layout.stateFile), 'tasks.json'), JSON.stringify([prior, done]));
    const api = await import('../../../src/main/features/task_cleanup');
    expect((await api.preview(uid, { days: 90, protectedIds: [] })).rows.map(r => r.cid)).toEqual(['recovered']);
  });
  it('expires previews and never uses an old receipt after restart or expiry', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);
    expect(() => api.page(uid, p.token, 0)).toThrow('cleanup_preview_expired');
    await expect(api.remove(uid, p.token, 'old-done')).rejects.toThrow('cleanup_preview_expired');
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('selects old completed tasks inside and outside projects, retaining protected and uncertain work', async () => {
    await seed();
    await seed('pinned', { pinned_at: old }); await seed('project', { project_id: 'p1' });
    await seed('auto', { origin_auto_task_id: 'a1' }); await seed('edit', { kind: 'edit' });
    await seed('recent', { updated_at: new Date().toISOString() });
    await seed('unread'); await seed('draft');
    for (const status of ['failed', 'stopped', 'waiting_input', 'queued', 'running', 'blocked', 'cancelled']) await seed(status, {}, status);
    const unknown = await seed('unknown'); fs.unlinkSync(path.join(path.dirname(unknown.layout.stateFile), 'tasks.json'));
    const api = await import('../../../src/main/features/task_cleanup');
    const preview = await api.preview(uid, { days: 90, protectedIds: ['unread', 'draft'] });
    expect(preview.total).toBe(2); expect(preview.rows.map(r => r.cid)).toEqual(['old-done', 'project']);
    expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('deletes a completed project task using its frozen project membership', async () => {
    await seed('project-done', { project_id: 'p1' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    expect(p.rows[0]).toMatchObject({ cid: 'project-done', projectId: 'p1' });
    expect(await api.remove(uid, p.token, 'project-done')).toEqual({ status: 'deleted' });
    expect(mocks.remove).toHaveBeenCalledWith(uid, 'project-done', 'p1', expect.any(Function));
  });
  it('protects project task drafts, unread, pinned, automated and unfinished work', async () => {
    for (const status of ['failed', 'stopped', 'running', 'queued', 'waiting_input']) await seed(status, { project_id: 'p1' }, status);
    await seed('pinned-project', { project_id: 'p1', pinned_at: old });
    await seed('auto-project', { project_id: 'p1', origin_auto_task_id: 'a1' });
    await seed('unread-project', { project_id: 'p1' }); await seed('draft-project', { project_id: 'p1' });
    const api = await import('../../../src/main/features/task_cleanup');
    expect((await api.preview(uid, { days: 90, protectedIds: ['unread-project', 'draft-project'] })).total).toBe(0);
  });
  it.each([null, 'p2'])('skips a project task relocated to %s after preview', async projectId => {
    const { row } = await seed('moved-project', { project_id: 'p1' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    row.project_id = projectId;
    expect(await api.remove(uid, p.token, 'moved-project')).toEqual({ status: 'skipped' });
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it.each([30, 90, 180])('uses the exact %i-day cutoff for every activity source, independent of timezone and file mtime', async days => {
    const now = Date.parse('2026-10-16T14:10:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const expected: string[] = [];
    // A recent index, runtime activity, or completion must independently
    // protect the task, even if all its other timestamps are stale.
    for (const field of ['created_at', 'updated_at', 'last_active_at', 'ended_at']) {
      for (const delta of [-1, 0, 1]) {
        const cid = `${field}-${delta + 1}`;
        const { row, layout } = await seed(cid);
        const timestamp = new Date(now - days * 86400000 + delta + 8 * 3600000)
          .toISOString().replace('Z', '+08:00');
        if (field === 'created_at' || field === 'updated_at') row[field] = timestamp;
        else if (field === 'last_active_at') {
          const state = JSON.parse(fs.readFileSync(layout.stateFile, 'utf8'));
          fs.writeFileSync(layout.stateFile, JSON.stringify({ ...state, last_active_at: timestamp }));
        } else {
          const file = path.join(path.dirname(layout.stateFile), 'tasks.json');
          const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
          tasks[0].ended_at = timestamp;
          fs.writeFileSync(file, JSON.stringify(tasks));
        }
        if (delta < 0) expected.push(cid);
      }
    }
    const api = await import('../../../src/main/features/task_cleanup');
    const preview = await api.preview(uid, { days, protectedIds: [] });
    expect(preview.rows.map(r => r.cid).sort()).toEqual(expected.sort());
    expect(preview.total).toBe(4);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('paginates a fixed preview and never adds later arrivals to its deletion scope', async () => {
    for (let i = 0; i < 25; i++) await seed(`task-${String(i).padStart(2, '0')}`);
    const api = await import('../../../src/main/features/task_cleanup');
    const preview = await api.preview(uid, { days: 30, protectedIds: [] });
    await seed('new-arrival');
    expect(preview.rows).toHaveLength(20); expect(preview.total).toBe(25);
    expect(api.page(uid, preview.token, 20).rows).toHaveLength(5);
    await expect(api.remove(uid, preview.token, 'new-arrival')).rejects.toThrow();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it.each(['pinned', 'recent', 'project', 'running', 'waiting'])('skips a task changed to %s during its backup', async change => {
    const { row, layout } = await seed();
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    mocks.archive.mockImplementationOnce(async () => {
      if (change === 'pinned') row.pinned_at = old;
      if (change === 'recent') row.updated_at = new Date().toISOString();
      if (change === 'project') row.project_id = 'p1';
      if (change === 'running') mocks.quiet = false;
      if (change === 'waiting') fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'idle', in_flight: [], orchestration_ledger: {} }));
      return { id: 'backup', items: [{}] };
    });
    expect(await api.remove(uid, p.token, 'old-done')).toEqual({ status: 'skipped' });
    expect(mocks.rows).toHaveLength(1);
  });
  it('keeps the source when backup fails, then permits retry', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    mocks.archive.mockRejectedValueOnce(new Error('backup unavailable'));
    await expect(api.remove(uid, p.token, 'old-done')).rejects.toThrow();
    expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.rows).toHaveLength(1);
    expect(await api.remove(uid, p.token, 'old-done')).toEqual({ status: 'deleted' });
    expect(await api.remove(uid, p.token, 'old-done')).toEqual({ status: 'skipped' });
    expect(mocks.archive).toHaveBeenCalledTimes(2);
  });
  it.each([null, 'p1'])('keeps a newly attached unsent file during backup in project %s', async projectId => {
    const { row } = await seed('new-attachment', projectId ? { project_id: projectId } : {});
    const api = await import('../../../src/main/features/task_cleanup');
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    const dir = chatAttachmentDirForConversation(uid, row.conversation_id);
    mocks.archive.mockImplementationOnce(async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'draft.txt'), 'New unsent work');
      return { id: 'backup', items: [{}] };
    });
    expect(await api.remove(uid, p.token, row.conversation_id)).toEqual({ status: 'skipped' });
    expect(mocks.rows).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'draft.txt'), 'utf8')).toBe('New unsent work');
    expect(mocks.discard).toHaveBeenCalledWith(uid, 'backup');
    // The rejected receipt cannot delete the task on a duplicate delivery.
    expect(await api.remove(uid, p.token, row.conversation_id)).toEqual({ status: 'skipped' });
    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });
  it('retains the backup after a deletion failure', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    mocks.remove.mockRejectedValueOnce(new Error('delete unavailable'));
    await expect(api.remove(uid, p.token, 'old-done')).rejects.toThrow();
    expect(mocks.discard).not.toHaveBeenCalled();
  });
  it('rejects cross-account, stale and invalid requests without mutation', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    await expect(api.remove('other', p.token, 'old-done')).rejects.toThrow();
    await expect(api.preview(uid, { days: -1, protectedIds: [] })).rejects.toThrow();
    await expect(api.preview(uid, { days: 90, protectedIds: ['../escape'] })).rejects.toThrow();
    await api.preview(uid, { days: 180, protectedIds: [] });
    expect(() => api.page(uid, p.token, 0)).toThrow();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('rejects concurrent duplicate deletion while a backup is in progress', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    let finish!: (v: any) => void;
    mocks.archive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = api.remove(uid, p.token, 'old-done');
    for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await expect(api.remove(uid, p.token, 'old-done')).rejects.toThrow();
    finish({ id: 'backup', items: [{}] }); await first;
    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });
});
