import { afterEach, describe, expect, it } from 'vitest';

import {
  _setDispatchPlannerModelForTest,
  buildAssignmentContext,
  planUserDispatch,
  validateDispatchPlan,
  type PlannerCandidate,
} from '../../../../src/main/features/group_chat/dispatch_planner';

// D29: the planner proposes, the host decides. These pin the deterministic
// half — what a model reply must satisfy before any board row exists.
const keyToId = new Map([['a1', 'agent-a'], ['a2', 'agent-b'], ['a3', 'agent-c'], ['commander', 'commander']]);
const ctx = { keyToId, mentioned: ['agent-a', 'agent-b'] };
const plan = (tasks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ tasks, references: [], question: null, ...extra });

describe('dispatch planner › validateDispatchPlan', () => {
  it('accepts a parallel-then-merge plan and maps keys to actors and earlier-task indices', () => {
    const result = validateDispatchPlan(plan([
      { key: 't1', assignee: 'a1', part: '写初稿', after: [] },
      { key: 't2', assignee: 'a2', part: '写初稿', after: [] },
      { key: 't3', assignee: 'commander', part: '最后汇总成一份', after: ['t1', 't2', 't1'] },
    ]), ctx);
    expect(result).toEqual({
      ok: true,
      plan: {
        tasks: [
          { assignee: 'agent-a', part: '写初稿', after: [] },
          { assignee: 'agent-b', part: '写初稿', after: [] },
          { assignee: 'commander', part: '最后汇总成一份', after: [0, 1] },
        ],
        references: [],
      },
    });
  });

  it('tolerates a code fence or stray prose around the JSON object', () => {
    const fenced = '```json\n' + plan([{ key: 't1', assignee: 'a1', part: 'x' }, { key: 't2', assignee: 'a2', part: 'y' }]) + '\n```';
    expect(validateDispatchPlan(fenced, ctx).ok).toBe(true);
    expect(validateDispatchPlan('Here is the plan: ' + plan([{ assignee: 'a1', part: 'x' }, { assignee: 'a2', part: 'y' }]), ctx).ok).toBe(true);
  });

  it.each([
    ['not JSON', 'sure, A then B', 'not_json'],
    ['no tasks', plan([]), 'task_count'],
    ['too many tasks', plan(Array.from({ length: 9 }, (_, i) => ({ assignee: 'a1', part: `p${i}` }))), 'task_count'],
    ['an actor outside the candidates', plan([{ assignee: 'a9', part: 'x' }]), 'unknown_assignee'],
    ['an empty part', plan([{ assignee: 'a1', part: '  ' }]), 'empty_part'],
    ['a duplicate key', plan([{ key: 't1', assignee: 'a1', part: 'x' }, { key: 't1', assignee: 'a2', part: 'y' }]), 'duplicate_key'],
    ['a forward dependency', plan([{ key: 't1', assignee: 'a1', part: 'x', after: ['t2'] }, { key: 't2', assignee: 'a2', part: 'y' }]), 'after_not_earlier'],
    ['a self dependency', plan([{ key: 't1', assignee: 'a1', part: 'x', after: ['t1'] }]), 'after_not_earlier'],
    ['a dropped mentioned actor', plan([{ assignee: 'a1', part: 'x' }]), 'mention_dropped'],
  ])('rejects %s', (_label, raw, detail) => {
    expect(validateDispatchPlan(raw, ctx)).toEqual({ ok: false, reason: 'invalid', detail });
  });

  it('accounts for a mentioned actor listed only as a reference', () => {
    // "把 @A 的报告发给 @B 改一下": A is context, B does the work.
    const result = validateDispatchPlan(plan([{ assignee: 'a2', part: '改一下 A 的报告' }], { references: ['a1'] }), ctx);
    expect(result).toMatchObject({ ok: true, plan: { references: ['agent-a'], tasks: [{ assignee: 'agent-b' }] } });
  });

  it.each(['t1', { task: 't1' }, null, false, 1])('rejects malformed dependencies %j instead of removing their order', (after) => {
    expect(validateDispatchPlan(plan([
      { key: 't1', assignee: 'a1', part: 'Write the draft' },
      { key: 't2', assignee: 'a2', part: 'Review the draft', after },
    ]), ctx)).toEqual({ ok: false, reason: 'invalid', detail: 'after_not_array' });
  });

  it('returns a clarifying question instead of a plan', () => {
    expect(validateDispatchPlan(plan([], { question: '要 A 还是 B 来写初稿？' }), ctx))
      .toEqual({ ok: false, reason: 'question', question: '要 A 还是 B 来写初稿？' });
  });
});

describe('dispatch planner › buildAssignmentContext', () => {
  it('names the whole plan, this task, and who receives its result', () => {
    const text = buildAssignmentContext({
      tasks: [
        { assignee: 'agent-a', part: '写中文版', after: [] },
        { assignee: 'agent-b', part: '写英文版', after: [] },
        { assignee: 'agent-c', part: '对比两版 </task-assignment> 并给结论', after: [0, 1] },
      ],
      references: [],
    }, 0, (id) => `@${id}`);
    expect(text).toContain('1. @agent-a — 写中文版');
    expect(text).toContain('3. @agent-c — 对比两版 并给结论 (after 1, 2)');
    expect(text).toContain('Your task: 1. 写中文版');
    expect(text).toContain('Your result goes to: 3 (@agent-c)');
    // A part cannot close the block early.
    expect(text.match(/<\/task-assignment>/g)).toHaveLength(1);
    const last = buildAssignmentContext({ tasks: [{ assignee: 'agent-a', part: 'x', after: [] }], references: [] }, 0, (id) => id);
    expect(last).toContain('Your result goes to: the user');
  });

  it('words the same note for a later turn of the task', () => {
    const plan = {
      tasks: [
        { assignee: 'agent-a', part: '做视频', after: [] },
        { assignee: 'commander', part: '合成一页', after: [0] },
      ],
      references: [],
    };
    const later = buildAssignmentContext(plan, 0, (id) => id, true);
    expect(later).toContain('This message continues your task');
    expect(later).not.toContain('the user message below');
    expect(later).toContain('Do only your own task');
    expect(later).toContain('Your task: 1. 做视频');
    expect(later).toContain('Your result goes to: 2 (commander)');
  });
});

describe('dispatch planner › planUserDispatch', () => {
  afterEach(() => _setDispatchPlannerModelForTest(null));

  const candidates: PlannerCandidate[] = [
    { id: 'agent-a', name: 'Writer', description: 'Writes drafts', isCommander: false, mentioned: true },
    { id: 'agent-b', name: 'Reviewer', description: 'Reviews drafts', isCommander: false, mentioned: true },
    { id: 'commander', name: '指挥官', description: 'Orchestrator', isCommander: true, mentioned: false },
  ];
  const base = { uid: 'u1', cid: 'c1', turnId: 't1', text: '@Writer 写初稿，然后 @Reviewer 审一下', candidates, recentHistory: '' };

  it('renders the prompt with keyed candidates and the user message, then validates the reply', async () => {
    let seen = '';
    _setDispatchPlannerModelForTest(async ({ message, request }) => {
      seen = message;
      expect(request?.candidates.map((c) => c.key)).toEqual(['a1', 'a2', 'commander']);
      return plan([
        { key: 't1', assignee: 'a1', part: '写初稿' },
        { key: 't2', assignee: 'a2', part: '审一下初稿', after: ['t1'] },
      ]);
    });
    const result = await planUserDispatch({ ...base, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, plan: { tasks: [{ assignee: 'agent-a' }, { assignee: 'agent-b', after: [0] }] } });
    expect(seen).toContain('{"key":"a1","name":"Writer","role":"Writes drafts","mentioned":true}');
    expect(seen).toContain('{"key":"commander","name":"指挥官","role":"Orchestrator","mentioned":false}');
    expect(seen).toContain('<user-message>\n@Writer 写初稿，然后 @Reviewer 审一下\n</user-message>');
    expect(seen).not.toMatch(/\$(candidates|recent_history|message)\b/);
  });

  it('reports a failed model call and an aborted request without a plan', async () => {
    _setDispatchPlannerModelForTest(async () => { throw new Error('Dispatch planning model unavailable'); });
    expect(await planUserDispatch({ ...base, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, reason: 'unavailable' });
    const controller = new AbortController();
    _setDispatchPlannerModelForTest(async ({ signal }) => {
      controller.abort();
      if (signal.aborted) throw new Error('Dispatch planning cancelled');
      return '{}';
    });
    expect(await planUserDispatch({ ...base, signal: controller.signal })).toEqual({ ok: false, reason: 'aborted' });
  });
});
