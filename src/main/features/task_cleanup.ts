/** Settings-only history maintenance. No model or application-SDK authority.
 * Preview reads index metadata once and only inspects old, unprotected tasks.
 * Receipts freeze membership; each deletion revalidates after its backup.
 * Recycle data stays local and uses the existing task storage category.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as chats from './chats';
import * as recycle from './recycle_bin';
import { isQuiescent } from './group_chat/bus';
import { hasPendingAttachmentsForCleanup } from './chat_attachments';
import { conversationLayout } from '../util/project-layout';
import { safeId } from '../storage';

const PAGE_SIZE = 20;
const TTL = 30 * 60 * 1000;
interface Row { cid: string; title: string; activeAt: string; projectId: string | null; }
interface Snapshot {
  token: string; expires: number; cutoff: number; rows: Row[];
  members: Map<string, string | null>; remaining: Set<string>; busy: boolean;
}
const snapshots = new Map<string, Snapshot>();
const previewing = new Set<string>();
function activity(c: chats.Conversation) { return Math.max(Date.parse(c.updated_at), Date.parse(c.created_at)); }
function eligible(c: chats.Conversation | null, cutoff: number): boolean {
  return !!c && c.kind === 'normal' && (!c.project_id || safeId(c.project_id)) && !c.origin_auto_task_id
    && !c.deleted_at && !c.pinned_at && safeId(c.conversation_id)
    && Number.isFinite(activity(c)) && activity(c) < cutoff;
}
function quiescent(uid: string, cid: string): boolean {
  return isQuiescent(uid, cid);
}
async function smallJson(filePath: string): Promise<any> {
  const file = await fs.open(filePath, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > 2 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === size ? JSON.parse(buffer.subarray(0, size).toString('utf8')) : null;
  } finally { await file.close(); }
}
async function completed(uid: string, cid: string, projectId: string | null, cutoff: number): Promise<boolean> {
  if (!quiescent(uid, cid)) return false;
  const layout = conversationLayout(uid, cid, projectId);
  if (layout.projectId !== projectId) return false;
  try {
    // Missing/corrupt records are unknown, never proof of completion. Do not
    // load the board runtime: that reader reconciles stale queued executions.
    const [state, tasks] = await Promise.all([
      smallJson(layout.stateFile),
      smallJson(path.join(path.dirname(layout.stateFile), 'tasks.json')),
    ]);
    if (state?.status !== 'idle' || !Array.isArray(state.in_flight) || state.in_flight.length
        || state.orchestration_ledger || !Array.isArray(tasks) || !tasks.length) return false;
    if (!Number.isFinite(Date.parse(state.last_active_at)) || Date.parse(state.last_active_at) >= cutoff) return false;
    if (tasks.some(t => !t || !['done', 'failed', 'stopped', 'cancelled'].includes(t.status))) return false;
    const roots = tasks.filter(t => t.created_by === 'user' && !t.parent_task_id && !t.absorbed_into_task_id);
    if (!roots.length || roots.some(t => !Number.isFinite(Date.parse(t.created_at)))) return false;
    const latest = roots.reduce((a, b) => Date.parse(a.created_at) >= Date.parse(b.created_at) ? a : b);
    const peers = roots.filter(t => t === latest || (latest.source_msg_id && t.source_msg_id === latest.source_msg_id));
    return peers.every(t => t.status === 'done' && Number.isFinite(Date.parse(t.ended_at)) && Date.parse(t.ended_at) < cutoff)
      && !await hasPendingAttachmentsForCleanup(uid, cid) && quiescent(uid, cid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw new Error('cleanup_read_failed');
  }
}
function snapshot(uid: string, token: string): Snapshot {
  const s = snapshots.get(uid);
  if (!s || s.token !== token || s.expires < Date.now()) throw new Error('cleanup_preview_expired');
  return s;
}
export async function preview(uid: string, args: { days: number; protectedIds: string[] }) {
  if (![30, 90, 180].includes(args.days) || !Array.isArray(args.protectedIds)
      || args.protectedIds.length > 50000 || args.protectedIds.some(id => typeof id !== 'string' || !safeId(id))) {
    throw new Error('invalid_cleanup_filter');
  }
  if (previewing.has(uid) || snapshots.get(uid)?.busy) throw new Error('cleanup_busy');
  previewing.add(uid);
  try {
    for (const [owner, s] of snapshots) if (!s.busy && s.expires < Date.now()) snapshots.delete(owner);
    const cutoff = Date.now() - args.days * 86400000;
    const protectedIds = new Set(args.protectedIds);
    const rows: Row[] = [];
    const candidates = (await chats.listCleanupConversationRows(uid))
      .filter(c => eligible(c, cutoff) && !protectedIds.has(c.conversation_id));
    // Four bounded readers, no history hydration or per-row IPC. Fail instead
    // of silently truncating an exceptionally large account's preview.
    if (candidates.length > 50000) throw new Error('cleanup_preview_too_large');
    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async c => {
        if (await completed(uid, c.conversation_id, c.project_id || null, cutoff)) rows.push({ cid: c.conversation_id, projectId: c.project_id || null,
          title: c.title.slice(0, 512), activeAt: new Date(activity(c)).toISOString() });
      }));
    }
    rows.sort((a, b) => a.activeAt.localeCompare(b.activeAt) || a.cid.localeCompare(b.cid));
    const s: Snapshot = { token: randomUUID(), expires: Date.now() + TTL, cutoff, rows,
      members: new Map(rows.map(r => [r.cid, r.projectId])), remaining: new Set(rows.map(r => r.cid)), busy: false };
    snapshots.set(uid, s);
    return { token: s.token, ...page(uid, s.token, 0) };
  } finally { previewing.delete(uid); }
}
export function page(uid: string, token: string, offset: number) {
  const s = snapshot(uid, token);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.rows.length) throw new Error('invalid_cleanup_page');
  const rows = s.rows.slice(offset, offset + PAGE_SIZE);
  return { total: s.rows.length, rows, nextOffset: offset + rows.length < s.rows.length ? offset + rows.length : null };
}
export async function remove(uid: string, token: string, cid: string) {
  const s = snapshot(uid, token);
  if (s.busy) throw new Error('cleanup_busy');
  if (!s.members.has(cid)) throw new Error('invalid_cleanup_selection');
  const projectId = s.members.get(cid)!;
  if (!s.remaining.has(cid)) return { status: 'skipped' as const };
  s.busy = true;
  try {
    const current = await chats.getConversationMetadata(uid, cid, projectId);
    if (!eligible(current, s.cutoff) || (current!.project_id || null) !== projectId
        || !await completed(uid, cid, projectId, s.cutoff)) {
      s.remaining.delete(cid); return { status: 'skipped' as const };
    }
    const batch = await recycle.createAppRecycleBatchForConversation(uid, cid);
    if (!batch?.items?.length) throw new Error('recycle_archive_failed');
    // Re-read the owning index under its write queue, after potentially slow
    // backup I/O, so a pin, project move, or new message invalidates selection.
    const removed = await chats.deleteConversation(uid, cid, projectId,
      async current => eligible(current, s.cutoff) && (current.project_id || null) === projectId
        && await completed(uid, cid, projectId, s.cutoff));
    s.remaining.delete(cid);
    if (!removed) await recycle.deleteRecycleBatch(uid, batch.id);
    s.expires = Date.now() + TTL;
    return { status: removed ? 'deleted' as const : 'skipped' as const };
  } catch (_) { throw new Error('cleanup_failed'); }
  finally { s.busy = false; }
}
