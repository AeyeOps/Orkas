import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ rows: [] as any[], quiet: true,
  archive: vi.fn(), remove: vi.fn(), discard: vi.fn(), abort: vi.fn() }));
vi.mock('../../../src/main/features/chats', () => ({
  listCleanupConversationRows: async () => mocks.rows,
  getConversationMetadata: async (_uid: string, cid: string) => mocks.rows.find(r => r.conversation_id === cid) || null,
  deleteConversation: (...args: any[]) => mocks.remove(...args),
}));
vi.mock('../../../src/main/features/group_chat/bus', () => ({ isQuiescent: () => mocks.quiet, abort: (...args: any[]) => mocks.abort(...args) }));
vi.mock('../../../src/main/features/projects', () => ({ getProject: async (_uid: string, projectId: string) => ({ project_id: projectId, name: 'Fixture project' }) }));
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
  vi.resetModules(); vi.resetAllMocks(); mocks.rows = []; mocks.quiet = true;
  mocks.archive.mockResolvedValue({ id: 'backup', items: [{ path: 'history' }] });
  mocks.discard.mockResolvedValue(undefined);
  mocks.abort.mockImplementation(async (_uid, cid) => {
    const { conversationLayout } = await import('../../../src/main/util/project-layout');
    const row = mocks.rows.find(r => r.conversation_id === cid);
    const layout = conversationLayout(uid, cid, row.project_id || null);
    row.updated_at = new Date().toISOString();
    fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'aborted', in_flight: [], last_active_at: row.updated_at }));
    mocks.quiet = true;
  });
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
  it.each([null, 'p1'])('uses the sidebar metadata timestamp for cleanup in project %s', async projectId => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T06:00:00Z'));
    for (const [cid, updated_at] of [['recent-metadata', '2026-10-16T14:15:58.377Z'], ['old-metadata', '2026-09-20T12:00:00+08:00']]) {
      const { layout } = await seed(cid, { ...(projectId ? { project_id: projectId } : {}),
        created_at: '2026-09-10T19:50:45+08:00', updated_at });
      fs.writeFileSync(layout.messageFile, JSON.stringify({ ts: '2026-09-10T20:04:24+08:00', text: 'Historical response' }));
      fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'idle', in_flight: [], last_active_at: '2026-09-21T00:00:00Z' }));
    }
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14 });
    expect(p.rows).toEqual([expect.objectContaining({ cid: 'old-metadata', activeAt: '2026-09-20T04:00:00.000Z', selectable: true })]);
    expect(await api.remove(uid, p.token, 'old-metadata')).toEqual({ status: 'deleted' });
    expect(mocks.rows.map(row => row.conversation_id)).toEqual(['recent-metadata']);
  });
  it('refreshes and pages cleanup without reading transcript bodies', async () => {
    const histories = new Set<string>();
    const line = JSON.stringify({ ts: old, text: 'x'.repeat(64 * 1024) }) + '\n';
    for (let i = 0; i < 26; i++) {
      const { layout } = await seed(`history-${i}`, i === 25 ? { project_id: 'p1' } : {});
      fs.writeFileSync(layout.messageFile, line.repeat(i === 0 ? 32 : 1));
      histories.add(layout.messageFile);
    }
    const api = await import('../../../src/main/features/task_cleanup');
    // Observe disk access, not elapsed time: this catches a scan even on a fast SSD.
    const reads = [vi.spyOn(fs, 'createReadStream'), vi.spyOn(fs, 'open'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs.promises, 'open')];
    for (const days of [14, 30, 180]) {
      const p = await api.preview(uid, { days });
      expect(p.total).toBe(26);
      expect(api.page(uid, p.token, 20).rows).toHaveLength(6);
      expect(api.page(uid, p.token, 0, { projectId: 'p1' }).rows).toHaveLength(1);
    }
    for (const read of reads) expect(read.mock.calls.filter(args => histories.has(String(args[0]))).length).toBe(0);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it.each(['created_at', 'updated_at'])('keeps a task with an invalid %s out of cleanup', async field => {
    await seed('invalid-clock', { [field]: 'invalid-time' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14 });
    expect(p.rows).toEqual([]);
    await expect(api.remove(uid, p.token, 'invalid-clock')).rejects.toThrow('invalid_cleanup_selection');
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.rows).toHaveLength(1);
  });
  it('keeps the preview cutoff fixed while time passes and admits newly aged tasks only after refresh', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T06:00:00Z'));
    await seed('already-old');
    await seed('at-cutoff', { updated_at: '2026-10-03T14:00:00+08:00' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14 });
    expect(p.rows.map(row => row.cid)).toEqual(['already-old']);
    clock.mockReturnValue(Date.parse('2026-10-17T06:01:00Z'));
    expect(api.page(uid, p.token, 0).rows.map(row => row.cid)).toEqual(['already-old']);
    await expect(api.remove(uid, p.token, 'at-cutoff')).rejects.toThrow('invalid_cleanup_selection');
    expect(await api.remove(uid, p.token, 'already-old')).toEqual({ status: 'deleted' });
    const refreshed = await api.preview(uid, { days: 14 });
    expect(refreshed.rows.map(row => row.cid)).toEqual(['at-cutoff']);
    expect(() => api.page(uid, p.token, 0)).toThrow('cleanup_preview_expired');
  });
  it('retains metadata refreshed after selection without creating a backup or stopping the task', async () => {
    const { row } = await seed('changed-before-confirm', {}, 'running');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14 });
    row.updated_at = new Date().toISOString();
    expect(await api.remove(uid, p.token, row.conversation_id)).toEqual({ status: 'skipped' });
    expect(await api.remove(uid, p.token, row.conversation_id)).toEqual({ status: 'skipped' });
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect((await api.preview(uid, { days: 14 })).rows).toEqual([]);
    expect(mocks.rows).toEqual([row]);
  });
  it.each(['message', 'replacement', 'metadata'])('preserves a task changed through %s during backup', async change => {
    const { row, layout } = await seed('changed');
    fs.writeFileSync(layout.messageFile, JSON.stringify({ ts: old, text: 'original' }));
    fs.utimesSync(layout.messageFile, new Date(old), new Date(old));
    const before = fs.statSync(layout.messageFile);
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14 });
    mocks.archive.mockImplementationOnce(async () => {
      if (change === 'message') fs.appendFileSync(layout.messageFile, '\n' + JSON.stringify({ ts: old, text: 'Imported work during backup' }));
      if (change === 'replacement') {
        const replacement = layout.messageFile + '.replacement';
        fs.writeFileSync(replacement, JSON.stringify({ ts: old, text: 'modified' }));
        fs.utimesSync(replacement, before.atime, before.mtime);
        fs.renameSync(replacement, layout.messageFile);
        expect(fs.statSync(layout.messageFile)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
      }
      // Even an imported edit still older than the cutoff invalidates this backup.
      if (change === 'metadata') row.updated_at = '2020-02-01T00:00:00Z';
      return { id: 'backup', items: [{}] };
    });
    expect(await api.remove(uid, p.token, 'changed')).toEqual({ status: 'skipped' });
    expect(mocks.rows).toHaveLength(1);
    expect(mocks.discard).toHaveBeenCalledWith(uid, 'backup');
  });
  it.each(['queued', 'running'])('stops selected %s history before backing up and deleting, including stop-time updates', async status => {
    await seed('active', { project_id: 'p1' }, status); mocks.quiet = false;
    const api = await import('../../../src/main/features/task_cleanup');
    const preview = await api.preview(uid, { days: 30 });
    expect(preview.rows[0]).toMatchObject({ selectable: true, blocked: 'busy' });
    expect(preview.selectableTotal).toBe(1);
    expect(preview.entries[0]).toMatchObject({ selectableTotal: 1 });
    expect(mocks.abort).not.toHaveBeenCalled();
    let completeStop!: () => void;
    const stop = mocks.abort.getMockImplementation()!;
    mocks.abort.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { completeStop = resolve; }); await stop(...args); });
    const pending = api.remove(uid, preview.token, 'active');
    await vi.waitFor(() => expect(completeStop).toBeTypeOf('function'));
    expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    completeStop();
    expect(await pending).toEqual({ status: 'deleted' });
    expect(mocks.abort).toHaveBeenCalledExactlyOnceWith(uid, 'active');
    expect(mocks.rows).toEqual([]);
  });
  it.each(['rejects', 'still-running'])('keeps history when stopping %s and permits retry', async failure => {
    await seed('active', {}, 'running'); mocks.quiet = false;
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30 });
    mocks.abort.mockImplementationOnce(async () => { if (failure === 'rejects') throw new Error('stop failed'); });
    await expect(api.remove(uid, p.token, 'active')).rejects.toThrow('cleanup_failed');
    expect(mocks.archive).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(await api.remove(uid, p.token, 'active')).toEqual({ status: 'deleted' });
  });
  it('retries a failed backup after stop without treating its own stop as new task activity', async () => {
    await seed('active', {}, 'running');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30 });
    mocks.archive.mockRejectedValueOnce(new Error('archive unavailable'));
    await expect(api.remove(uid, p.token, 'active')).rejects.toThrow('cleanup_failed');
    expect(mocks.rows).toHaveLength(1);
    expect(await api.remove(uid, p.token, 'active')).toEqual({ status: 'deleted' });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });
  it.each(['runtime', 'state', 'recent', 'project'])('preserves stopped history changed by %s during backup', async change => {
    const { row, layout } = await seed('active', {}, 'running');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30 });
    mocks.archive.mockImplementationOnce(async () => {
      if (change === 'runtime') mocks.quiet = false;
      if (change === 'state') fs.writeFileSync(layout.stateFile, JSON.stringify({ status: 'idle', in_flight: [], last_active_at: old }));
      if (change === 'recent') row.updated_at = new Date(Date.now() + 1000).toISOString();
      if (change === 'project') row.project_id = 'another';
      return { id: 'backup', items: [{}] };
    });
    expect(await api.remove(uid, p.token, 'active')).toEqual({ status: 'skipped' });
    expect(mocks.rows).toHaveLength(1);
    expect(mocks.discard).toHaveBeenCalledWith(uid, 'backup');
  });
  it('never stops unreadable history even when the runtime is busy', async () => {
    const { layout } = await seed('corrupt', {}, 'running'); mocks.quiet = false;
    fs.writeFileSync(layout.stateFile, '{');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30 });
    expect(p.rows[0]).toMatchObject({ selectable: false, blocked: 'unknown' });
    expect(await api.remove(uid, p.token, 'corrupt')).toEqual({ status: 'skipped' });
    expect(mocks.abort).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('keeps corrupt state and a recent completion even when its index is stale', async () => {
    const corrupt = await seed('corrupt');
    fs.writeFileSync(corrupt.layout.stateFile, '{');
    const recent = await seed('recent-result');
    fs.writeFileSync(path.join(path.dirname(recent.layout.stateFile), 'tasks.json'), JSON.stringify([
      { created_by: 'user', created_at: old, status: 'done', ended_at: new Date().toISOString() },
    ]));
    const api = await import('../../../src/main/features/task_cleanup');
    expect((await api.preview(uid, { days: 90, protectedIds: [] })).rows).toMatchObject([{ cid: 'corrupt', selectable: false, blocked: 'unknown' }]);
  });
  it('includes failed and recovered work without requiring successful completion', async () => {
    const first = await seed('mixed');
    const second = await seed('recovered');
    const prior = { created_by: 'user', source_msg_id: 'prior', created_at: '2019-01-01', ended_at: old, status: 'failed' };
    const done = { created_by: 'user', source_msg_id: 'latest', created_at: old, ended_at: old, status: 'done' };
    fs.writeFileSync(path.join(path.dirname(first.layout.stateFile), 'tasks.json'), JSON.stringify([done, { ...done, status: 'failed' }]));
    fs.writeFileSync(path.join(path.dirname(second.layout.stateFile), 'tasks.json'), JSON.stringify([prior, done]));
    const api = await import('../../../src/main/features/task_cleanup');
    expect((await api.preview(uid, { days: 90, protectedIds: [] })).rows.map(r => r.cid)).toEqual(['mixed', 'recovered']);
  });
  it('expires previews and never uses an old receipt after restart or expiry', async () => {
    await seed(); const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);
    expect(() => api.page(uid, p.token, 0)).toThrow('cleanup_preview_expired');
    await expect(api.remove(uid, p.token, 'old-done')).rejects.toThrow('cleanup_preview_expired');
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('includes old history and marks active work without excluding pins, drafts, unread or automation', async () => {
    await seed();
    await seed('pinned', { pinned_at: old }); await seed('project', { project_id: 'p1' });
    await seed('auto', { origin_auto_task_id: 'a1' }); await seed('edit', { kind: 'edit' });
    await seed('recent', { updated_at: new Date().toISOString() });
    await seed('unread'); await seed('draft');
    for (const status of ['failed', 'stopped', 'waiting_input', 'queued', 'running', 'blocked', 'cancelled']) await seed(status, {}, status);
    const unknown = await seed('unknown'); fs.unlinkSync(path.join(path.dirname(unknown.layout.stateFile), 'tasks.json'));
    const api = await import('../../../src/main/features/task_cleanup');
    const preview = await api.preview(uid, { days: 90, protectedIds: ['unread', 'draft'] });
    expect(preview.total).toBe(14);
    expect(preview.rows.filter(r => r.selectable).map(r => r.cid).sort()).toEqual(['auto', 'blocked', 'cancelled', 'draft', 'failed', 'old-done', 'pinned', 'project', 'stopped', 'unknown', 'unread', 'waiting_input', 'queued', 'running'].sort());
    expect(preview.rows.find(r => r.cid === 'auto')).toMatchObject({ automation: true });
    expect(preview.rows.find(r => r.cid === 'pinned')).toMatchObject({ pinned: true });
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
  it('allows project history with annotations and running or queued work', async () => {
    for (const status of ['failed', 'stopped', 'running', 'queued', 'waiting_input']) await seed(status, { project_id: 'p1' }, status);
    await seed('pinned-project', { project_id: 'p1', pinned_at: old });
    await seed('auto-project', { project_id: 'p1', origin_auto_task_id: 'a1' });
    await seed('unread-project', { project_id: 'p1' }); await seed('draft-project', { project_id: 'p1' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: ['unread-project', 'draft-project'] });
    expect(p.total).toBe(9);
    expect(p.rows.filter(r => r.selectable).map(r => r.cid).sort()).toEqual(['failed', 'stopped', 'waiting_input', 'pinned-project', 'auto-project', 'unread-project', 'draft-project', 'running', 'queued'].sort());
  });
  it.each([null, 'p2'])('skips a project task relocated to %s after preview', async projectId => {
    const { row } = await seed('moved-project', { project_id: 'p1' });
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    row.project_id = projectId;
    expect(await api.remove(uid, p.token, 'moved-project')).toEqual({ status: 'skipped' });
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it.each([7, 14, 30, 60, 90, 180])('uses the exact %i-day cutoff for every activity source, independent of timezone and file mtime', async days => {
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
  it.each(['recent', 'project', 'running', 'waiting'])('skips a task changed to %s during its backup', async change => {
    const { row, layout } = await seed();
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 90, protectedIds: [] });
    mocks.archive.mockImplementationOnce(async () => {
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
  it.each(['unchanged', 'edited', 'added', 'symlink'])('handles nested attachments safely when %s', async change => {
    await seed('nested');
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const dir = path.join(chatAttachmentDirForConversation(uid, 'nested'), 'folder', 'inner');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'draft.txt');
    fs.writeFileSync(file, 'Original draft');
    if (change === 'symlink') fs.symlinkSync(root, path.join(dir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30 });
    mocks.archive.mockImplementationOnce(async () => {
      if (change === 'edited') fs.writeFileSync(file, 'Edited draft during backup');
      if (change === 'added') fs.writeFileSync(path.join(dir, 'new.txt'), 'New draft');
      return { id: 'backup', items: [{}] };
    });
    if (change === 'symlink') {
      await expect(api.remove(uid, p.token, 'nested')).rejects.toThrow('cleanup_failed');
      expect(mocks.archive).not.toHaveBeenCalled();
    } else {
      expect(await api.remove(uid, p.token, 'nested')).toEqual({ status: change === 'unchanged' ? 'deleted' : 'skipped' });
      expect(mocks.discard).toHaveBeenCalledTimes(change === 'unchanged' ? 0 : 1);
    }
    expect(mocks.rows).toHaveLength(change === 'unchanged' ? 0 : 1);
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
  it('pages project children separately and leaves personal tasks at the root', async () => {
    for (let i = 0; i < 25; i++) await seed('child-' + String(i).padStart(2, '0'), { project_id: 'p1' });
    await seed('personal');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 30, protectedIds: [] });
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]).toMatchObject({ type: 'project', projectId: 'p1', total: 25, selectableTotal: 25 });
    expect(p.entries[1]).toMatchObject({ cid: 'personal', projectId: null });
    const children = api.page(uid, p.token, 20, { projectId: 'p1' });
    expect(children.rows.map(r => r.cid)).toEqual(['child-20', 'child-21', 'child-22', 'child-23', 'child-24']);
    expect(children.nextOffset).toBeNull();
    expect(() => api.page(uid, p.token, 0, { projectId: 'another' })).toThrow();
  });
  it('allows an explicitly selected pinned failed task and existing attachment draft', async () => {
    const { layout } = await seed('pinned-draft', { pinned_at: old }, 'failed');
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const dir = chatAttachmentDirForConversation(uid, 'pinned-draft');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'draft.txt'), 'Draft');
    const api = await import('../../../src/main/features/task_cleanup');
    const p = await api.preview(uid, { days: 14, protectedIds: ['pinned-draft'] });
    expect(p.rows[0]).toMatchObject({ selectable: true, pinned: true, draft: true });
    expect(await api.remove(uid, p.token, 'pinned-draft')).toEqual({ status: 'deleted' });
  });

});
