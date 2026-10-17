/**
 * dispatch_planner.ts — split a user-orchestrated message into board tasks (D29).
 *
 * When a user message orchestrates several actors (or names one anywhere but
 * at the very start), the router hands it here instead of cutting the text at
 * mention positions. ONE structured model call proposes the split — who does
 * which part, and which earlier tasks each part must wait for — and this
 * module validates the proposal deterministically before the bus creates any
 * row:
 *   - assignees are only the mentioned actors or Commander (no new actors);
 *   - every mentioned actor is either assigned or listed as a reference;
 *   - 1..MAX_PLANNED_TASKS tasks, each with a non-empty part;
 *   - `after` may only name EARLIER tasks, so the graph is acyclic.
 * Any failure (model unavailable, timeout, malformed JSON, a clarifying
 * question) returns a reason, and the bus falls back to Commander. The model
 * never writes the board itself (D12): it only returns data the host checks.
 */

export interface PlannerCandidate {
  /** Actor id (agent id, or 'commander'). */
  id: string;
  name: string;
  /** One-line role summary shown to the planner. */
  description: string;
  isCommander: boolean;
  /** The user @-mentioned this actor (Commander may be a candidate without it). */
  mentioned: boolean;
}

export interface PlannedTask {
  /** Actor id. */
  assignee: string;
  /** This owner's part, in the user's language. */
  part: string;
  /** Indices of EARLIER tasks this task waits for (and receives results from). */
  after: number[];
}

export interface DispatchPlan {
  tasks: PlannedTask[];
  /** Mentioned actors that only provide context (e.g. "@A's report"). */
  references: string[];
}

export type DispatchPlanFailure = 'unavailable' | 'failed' | 'timeout' | 'invalid' | 'question' | 'aborted';

export type DispatchPlanResult =
  | { ok: true; plan: DispatchPlan }
  | { ok: false; reason: DispatchPlanFailure; question?: string; detail?: string };

export const MAX_PLANNED_TASKS = 8;
const MAX_PART_CHARS = 1000;
const PLANNER_TIMEOUT_MS = 20_000;

type PlannerModel = (input: {
  userId: string;
  cid: string;
  turnId: string;
  /** The rendered planning prompt (what the real model reads). */
  message: string;
  signal: AbortSignal;
  /** Structured view of the same request, for deterministic test stubs. */
  request?: { text: string; candidates: Array<PlannerCandidate & { key: string }> };
}) => Promise<string>;

let _modelForTest: PlannerModel | null = null;

/** Test-only: replace the model call with a deterministic stub (null restores). */
export function _setDispatchPlannerModelForTest(fn: PlannerModel | null): void {
  _modelForTest = fn;
}

/** Stable short keys the model sees instead of opaque actor ids. */
function candidateKeys(candidates: readonly PlannerCandidate[]): string[] {
  let n = 0;
  return candidates.map((c) => (c.isCommander ? 'commander' : `a${++n}`));
}

export async function planUserDispatch(input: {
  uid: string;
  cid: string;
  turnId: string;
  text: string;
  candidates: readonly PlannerCandidate[];
  recentHistory: string;
  signal: AbortSignal;
}): Promise<DispatchPlanResult> {
  const keys = candidateKeys(input.candidates);
  const keyToId = new Map(keys.map((key, i) => [key, input.candidates[i].id]));
  const { prompts } = await import('../../prompts/loader');
  const message = prompts.load('dispatch_planner', {
    candidates: input.candidates.map((c, i) => JSON.stringify({
      key: keys[i],
      name: c.name,
      role: c.description,
      mentioned: c.mentioned,
    })).join('\n'),
    recent_history: input.recentHistory.trim() || '(none)',
    message: input.text,
  });
  const timeout = AbortSignal.timeout(PLANNER_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeout]);
  let raw: string;
  try {
    const model: PlannerModel = _modelForTest
      || (await import('../../model/core-agent/runner')).completeDispatchPlan;
    raw = await model({
      userId: input.uid, cid: input.cid, turnId: input.turnId, message, signal,
      request: { text: input.text, candidates: input.candidates.map((c, i) => ({ ...c, key: keys[i] })) },
    });
  } catch (err) {
    if (input.signal.aborted) return { ok: false, reason: 'aborted' };
    if (timeout.aborted) return { ok: false, reason: 'timeout' };
    const detail = String((err as Error)?.message || err).slice(0, 160);
    // Provider errors can echo request text. Only the closed failure reason
    // may reach the bus diagnostic; validation details below are fixed codes.
    return { ok: false, reason: /unavailable/i.test(detail) ? 'unavailable' : 'failed' };
  }
  if (input.signal.aborted) return { ok: false, reason: 'aborted' };
  return validateDispatchPlan(raw, {
    keyToId,
    mentioned: input.candidates.filter((c) => c.mentioned).map((c) => c.id),
  });
}

/** Parse and check a planner reply. Pure — unit-testable without a model. */
export function validateDispatchPlan(
  raw: string,
  ctx: { keyToId: ReadonlyMap<string, string>; mentioned: readonly string[] },
): DispatchPlanResult {
  const invalid = (detail: string): DispatchPlanResult => ({ ok: false, reason: 'invalid', detail });
  const parsed = parsePlannerJson(raw);
  if (!parsed) return invalid('not_json');
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  if (question) return { ok: false, reason: 'question', question: question.slice(0, 500) };
  const rawTasks: unknown[] = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (!rawTasks.length || rawTasks.length > MAX_PLANNED_TASKS) return invalid('task_count');
  const keyIndex = new Map<string, number>();
  const tasks: PlannedTask[] = [];
  for (let i = 0; i < rawTasks.length; i += 1) {
    const task = (rawTasks[i] && typeof rawTasks[i] === 'object' ? rawTasks[i] : {}) as Record<string, unknown>;
    const assignee = ctx.keyToId.get(String(task.assignee ?? ''));
    if (!assignee) return invalid('unknown_assignee');
    const part = typeof task.part === 'string' ? task.part.trim().slice(0, MAX_PART_CHARS) : '';
    if (!part) return invalid('empty_part');
    const key = typeof task.key === 'string' && task.key.trim() ? task.key.trim() : `t${i + 1}`;
    if (keyIndex.has(key)) return invalid('duplicate_key');
    if (task.after !== undefined && !Array.isArray(task.after)) return invalid('after_not_array');
    const after: number[] = [];
    for (const dep of Array.isArray(task.after) ? task.after : []) {
      const index = keyIndex.get(String(dep));
      // Only earlier tasks: forward or self references could form a cycle.
      if (index === undefined) return invalid('after_not_earlier');
      if (!after.includes(index)) after.push(index);
    }
    keyIndex.set(key, i);
    tasks.push({ assignee, part, after });
  }
  const references = [...new Set((Array.isArray(parsed.references) ? parsed.references : [])
    .map((key: unknown) => ctx.keyToId.get(String(key)))
    .filter((id: string | undefined): id is string => !!id))];
  const covered = new Set<string>([...tasks.map((t) => t.assignee), ...references]);
  if (ctx.mentioned.some((id) => !covered.has(id))) return invalid('mention_dropped');
  return { ok: true, plan: { tasks, references } };
}

/** The first JSON object in the reply, tolerating a code fence or stray prose. */
function parsePlannerJson(raw: string): Record<string, unknown> | null {
  const text = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Model-facing split note for one planned task (consume-time prepend). It
 * names the whole plan so the owner does only its part, and who receives its
 * result so it writes that result for its consumer. */
export function buildAssignmentContext(
  plan: DispatchPlan,
  index: number,
  nameOf: (actorId: string) => string,
  /** Worded for a later turn of the same task (a user reply that continues
   * it), whose input no longer carries the split message. */
  continuing = false,
): string {
  const clean = (s: string) => s.replace(/<\/?task-assignment\b[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
  const lines = plan.tasks.map((task, i) => {
    const waits = task.after.length ? ` (after ${task.after.map((j) => j + 1).join(', ')})` : '';
    return `${i + 1}. ${nameOf(task.assignee)} — ${clean(task.part)}${waits}`;
  });
  const consumers = plan.tasks
    .map((task, i) => ({ task, i }))
    .filter(({ task }) => task.after.includes(index))
    .map(({ task, i }) => `${i + 1} (${nameOf(task.assignee)})`);
  return [
    '<task-assignment>',
    continuing
      ? 'This message continues your task from an earlier user message that the host split into tasks for named actors. Do only your own task; the other tasks belong to their owners.'
      : 'The host split the user message below into tasks for named actors. Do only your own task; the other tasks belong to their owners. A task listed with "after" starts only when those tasks are done, and their results are attached to it.',
    'Plan:',
    ...lines,
    `Your task: ${index + 1}. ${clean(plan.tasks[index].part)}`,
    `Your result goes to: ${consumers.length ? consumers.join(', ') : 'the user'}`,
    '</task-assignment>',
  ].join('\n');
}
