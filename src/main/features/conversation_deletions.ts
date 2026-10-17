/** Exact local task ownership prevents neighboring session-prefix deletion. */
import { safeId } from '../storage';
import { isSafeCloudRelPath } from '../util/cloud-path';

export interface TaskIdentity { cid: string; projectId: string | null; }
export type TaskOwnership = Map<string, TaskIdentity>;
const key = (pid: string | null, cid: string) => `${pid || ''}/${cid}`;

export function taskForPath(deletions: TaskOwnership, rel: string): TaskIdentity | undefined {
  if (!isSafeCloudRelPath(rel)) return;
  const parts = rel.split('/');
  const pid = parts[1] === 'projects' ? parts[2] : null;
  const rest = parts.slice(pid ? 3 : 1);
  const [domain, name] = rest;
  if (domain === 'chats' || domain === 'chat_attachments' || domain === 'chat_artifacts') {
    const cid = domain === 'chats' && rest.length === 2 && name?.endsWith('.jsonl') ? name.slice(0, -6) : name;
    return safeId(cid) ? deletions.get(key(pid, cid)) : undefined;
  }
  if (domain !== 'sessions' || !name) return;
  if (name.startsWith('gconv-')) {
    const cid = name.slice(6).split('.')[0];
    if (/^\.(?:jsonl(?:\.context\.json)?|tool-results)$/.test(name.slice(6 + cid.length))) return deletions.get(key(pid, cid));
  }
  if (name.startsWith('gmember-')) {
    const stem = name.slice(8).split('.')[0];
    if (!/\.(?:jsonl(?:\.context\.json)?|tool-results)$/.test(name)) return;
    for (let at = stem.lastIndexOf('-'); at > 0; at = stem.lastIndexOf('-', at - 1)) {
      const match = deletions.get(key(pid, stem.slice(0, at)));
      if (match) return match;
    }
  }
}
