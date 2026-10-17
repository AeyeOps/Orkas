import { describe, it, expect } from 'vitest';

import {
  parseMentions, resolveRecipients,
  extractFormFromFinal, computeFormId, decodeSubmission, encodeSubmission,
  validateFormAnswers,
  extractPlanInteractionFromFinal, extractHandbackFromFinal,
  classifyUserMentionRoute,
} from '../../../../src/main/features/group_chat/router';

describe('group_chat router › chat form answers', () => {
  it.each([
    { type: 'number', default: 0, min: 1, answer: 1 },
    { type: 'number', default: 11, max: 10, answer: 10 },
    { type: 'number', default: 'unknown', answer: 0 },
    { type: 'boolean', default: 'unknown', answer: false },
    { type: 'select', default: 'removed', options: [{ value: 'a', label: 'A' }], answer: 'a' },
    { type: 'multiselect', default: ['a', 'removed'], options: [{ value: 'a', label: 'A' }], answer: ['a'] },
    { type: 'text', default: 123, answer: 'Provided' },
    { type: 'textarea', default: { value: 'invalid' }, answer: 'Provided' },
  ])('keeps a required $type question answerable when its default is invalid: $default', ({ answer, ...definition }) => {
    const question = { id: 'question', label: 'Question', required: true, ...definition };
    const result = extractFormFromFinal(`<agent-input-form>\n${JSON.stringify({ fields: [question] })}\n</agent-input-form>`, 'writer');
    const { default: _invalid, ...expected } = question;
    expect(result.form?.fields).toEqual([expected]);
    expect(result.cleanText).toBe('');
    expect(validateFormAnswers(result.form!.fields, {})).toBe(false);
    expect(validateFormAnswers(result.form!.fields, { question: null })).toBe(false);
    expect(validateFormAnswers(result.form!.fields, { question: answer })).toBe(true);
  });

  it('keeps unanswered form definitions separate from defaults and supplied answers', () => {
    const fields = [
      { id: 'count', type: 'number', required: true, min: 0 },
      { id: 'confirmed', type: 'boolean', required: true },
      { id: 'choice', type: 'select', required: true, options: [{ value: 'a' }, { value: 'b' }] },
    ];
    for (const empty of [undefined, null, '']) {
      const text = `<agent-input-form>\n${JSON.stringify({ fields: fields.map(f => ({ ...f, default: empty })) })}\n</agent-input-form>`;
      const result = extractFormFromFinal(text, 'writer');
      expect(result.form?.fields).toHaveLength(3);
      expect(result.form?.fields.every(f => !Object.hasOwn(f, 'default'))).toBe(true);
      expect(result.cleanText).toBe('');
    }
    const resolved = extractFormFromFinal(`<agent-input-form>\n${JSON.stringify({ fields: fields.map((f, i) => ({ ...f, default: [0, false, 'b'][i] })) })}\n</agent-input-form>`, 'writer');
    expect(resolved.form?.fields.map(f => f.default)).toEqual([0, false, 'b']);
    const schema = resolved.form!.fields;
    expect(validateFormAnswers(schema, { count: 0, confirmed: false, choice: 'b' })).toBe(true);
    for (const values of [
      {}, { count: null, confirmed: false, choice: 'b' },
      { count: '', confirmed: false, choice: 'b' },
      { count: 1, confirmed: null, choice: 'b' },
      { count: 1, confirmed: 'false', choice: 'b' },
      { count: 1, confirmed: false, choice: '' },
      { count: 1, confirmed: false, choice: 'c' },
      ...[NaN, Infinity, -1, '3'].map(count => ({ count, confirmed: false, choice: 'b' })),
    ]) expect(validateFormAnswers(schema, values), JSON.stringify(values)).toBe(false);
    expect(validateFormAnswers(schema.map(f => ({ ...f, required: false })), { count: null, confirmed: null, choice: '' })).toBe(true);
    expect(validateFormAnswers(schema.map(f => ({ ...f, required: false })), { count: [] })).toBe(false);
    expect(encodeSubmission({ form_id: 'abcd1234', agent_id: 'writer', fields: resolved.form!.fields }, { count: null, confirmed: null, choice: null }))
      .not.toMatch(/：(?:0|no|b)/);
  });

});

describe('group_chat router › parseMentions', () => {
  it('finds @-tokens deduped in first-occurrence order', () => {
    expect(parseMentions('hi @alice and @bob, then @alice again')).toEqual(['alice', 'bob']);
  });

  it('does not match emails as mentions', () => {
    // `foo@example.com` — `o` is in the prev-char class so the boundary
    // disqualifies the @.
    expect(parseMentions('contact me at foo@example.com please')).toEqual([]);
  });

  it('handles punctuation boundaries (start, comma, period)', () => {
    expect(parseMentions('@x, hello @y. and @z!')).toEqual(['x', 'y', 'z']);
  });

  // CJK typing habit: no space before `@` ("…然后@PptMaker 做成…"). The CJK
  // range is in the TOKEN class (CJK agent names) but must not act as a
  // leading boundary blocker — that exact shape silently dropped the second
  // mention on-device 2026-08-23 and the whole text went to one agent.
  it('recognizes a mention directly after a CJK character (no space)', () => {
    expect(parseMentions('写一篇介绍，然后@PptMaker 做成一份ppt文件', { names: ['PptMaker'] }))
      .toEqual(['PptMaker']);
    // Fallback class (no name list) behaves the same.
    expect(parseMentions('先研究，再@Writer 总结')).toEqual(['Writer']);
    // Rejected look-alikes: an ASCII word char before `@` is still an email
    // shape, even inside CJK prose.
    expect(parseMentions('邮件发到 user@example.com 即可')).toEqual([]);
    expect(parseMentions('账号a@b也不算')).toEqual([]);
  });

  it.each([
    '`@alice` then @bob review',
    '``@alice `example` `` then @bob review',
    '```ts\n@alice\n```\n@bob review',
    '~~~xml\n@alice\n~~~\n@bob review',
    '@bob review\n```\n@alice',
  ])('only dispatches prose mentions when pasted content contains code: %s', (text) => {
    expect(parseMentions(text)).toEqual(['bob']);
  });

  it('returns [] on empty / non-string', () => {
    expect(parseMentions('')).toEqual([]);
  });

  // Multi-word display names get truncated by the fallback char-class regex
  // (no whitespace allowed inside a token). Passing `names` switches the
  // parser to alternation mode so "Software Requirements Analyst" matches
  // as a whole. Regression for the case where user typed
  // "@Socratic Learning Coach 运行" and bus extracted only `Socratic`.
  it('greedy-matches multi-word names from the supplied list', () => {
    const names = ['Software Requirements Analyst', 'Socratic Learning Coach', 'Software'];
    expect(parseMentions('@Socratic Learning Coach 运行', { names })).toEqual(['Socratic Learning Coach']);
    expect(parseMentions('let @Software Requirements Analyst handle scoping', { names }))
      .toEqual(['Software Requirements Analyst']);
    // Longest-first ordering: bare "@Software" (no continuation) still matches
    // the short name without being mistaken for a prefix of the long one.
    expect(parseMentions('ping @Software now', { names })).toEqual(['Software']);
    // Token continues into a non-name word — alternation fails, fallback
    // char class matches just the leading word.
    expect(parseMentions('@Software Foo Bar', { names })).toEqual(['Software']);
  });

  // LLM 派活走 dispatch_to / hand_off_to 工具,散文里的 @ 只是展示或指代。
  // 这条不变量保护"commander/agent 在介绍/列举/计划里写 @ 不会误触发"。
  // 2026-10-04 起 agent 正文里的 @commander / @指挥官 也不再路由:交还指挥官
  // 只走 <handback> / orkas_handoff_to_commander(带单跳与防循环保护)。
  it('parses no routing mentions from commander or agent prose', () => {
    const text = '我让 @需求挖掘师 先聊,然后 **@全面评估师** 评估';
    expect(parseMentions(text, { fromKind: 'commander' })).toEqual([]);
    expect(parseMentions(text, { fromKind: 'agent' })).toEqual([]);
    expect(parseMentions('辛苦 @需求挖掘师 继续, @commander 接力, @指挥官 看一下', { fromKind: 'agent' }))
      .toEqual([]);
    // 2026-10-04 真实误触:表格单元格里举例写到 @指挥官。
    expect(parseMentions('| C | 其他带 @ 的消息,或混了 @指挥官 | 整条交给指挥官 |', { fromKind: 'agent' }))
      .toEqual([]);
    // user 仍然走完整扫描
    expect(parseMentions(text, { fromKind: 'user' })).toEqual(['需求挖掘师', '全面评估师']);
    // 缺省 fromKind 等价老行为(向后兼容)
    expect(parseMentions(text)).toEqual(['需求挖掘师', '全面评估师']);
  });

  // Quote-reply prepends the quoted bubble's body as `> ...` blockquote
  // lines. `@<name>` inside that quote refers to the original author's
  // dispatch — re-routing to it whenever someone forwards the bubble
  // is wrong (the user's intent is in their own typed prose, not in the
  // pasted-in context). Lines starting with `>` are stripped from the
  // routing-relevant view.
  it('ignores @-mentions inside `>` blockquote lines (quote-reply context)', () => {
    // Pure quote, no body → no mentions parsed (default routing applies upstream).
    expect(parseMentions('> hi @alice')).toEqual([]);
    // Quote contains @, body has its own @ → only the body's @ counts.
    expect(parseMentions('> previous reply mentioned @alice\n@bob please review'))
      .toEqual(['bob']);
    // Multi-line quote, multiple @s ignored; user's plain @ kept.
    expect(parseMentions('> line one @x\n> line two @y\nfinal: @z'))
      .toEqual(['z']);
    // Leading whitespace before `>` (some clients indent quotes).
    expect(parseMentions('   > @alice from somewhere\nplain @bob'))
      .toEqual(['bob']);
  });

  it('ignores mentions across multiple separately quoted messages', () => {
    const text = [
      '> first reply asked @alice',
      '',
      '> second reply asked @bob',
      '> and referenced @carol',
      '',
      '@reviewer compare all replies',
    ].join('\n');
    expect(parseMentions(text)).toEqual(['reviewer']);
  });
});

describe('group_chat router › resolveRecipients', () => {
  const members = [
    { kind: 'commander' as const, id: 'commander', joined_at: 't' },
    { kind: 'user' as const,      id: 'user',      joined_at: 't' },
    { kind: 'agent' as const,     id: 'writer',    joined_at: 't' },
  ];

  it('user with no @ → defaults to [commander]', () => {
    const r = resolveRecipients({ fromKind: 'user', fromId: 'user', text: 'hi', members });
    expect(r.to).toEqual(['commander']);
    expect(r.unknown).toEqual([]);
  });

  // active_recipient (the conversation floor): a no-`@` user message follows the
  // agent the commander handed off to, instead of always the commander.
  it('user with no @ + active floor agent → routes to the floor agent', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'I didn\'t get part 2', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['writer']);
    expect(r.hadExplicitMention).toBe(false);
  });

  it('falls back to Commander for legacy multi-recipient defaults', () => {
    const opts = { fromKind: 'user' as const, fromId: 'user', members,
      activeRecipients: ['writer', 'commander'] };
    expect(resolveRecipients({ ...opts, text: 'continue' }).to).toEqual(['commander']);
    expect(resolveRecipients({ ...opts, text: '> @writer quoted\ncontinue' }).to).toEqual(['commander']);
    expect(resolveRecipients({ ...opts, text: '@writer revise' }).to).toEqual(['writer']);
    expect(resolveRecipients({ ...opts, text: 'done', fromKind: 'agent', fromId: 'writer' }).to).toEqual(['user']);
  });

  it.each([
    ['check this', ['writer']],
    ['  @commander check this', ['commander']],
    // D29: prose before a mention no longer leaves the leading text to the
    // floor. Agent mentions go to the dispatch planner; a Commander-only
    // mention has one possible owner and goes straight to Commander.
    ['check first @commander review', ['commander']],
    ['> @writer quoted\n @commander review', ['commander']],
    ['@writer first @writer second', ['writer']],
  ])('routes first-instruction ownership for %s', (text, expected) => {
    expect(resolveRecipients({ fromKind: 'user', fromId: 'user', members, activeRecipient: 'writer', text }).to).toEqual(expected);
  });

  // Roster membership is a RECORD written at first dispatch, never a routing
  // gate: a chip-selected agent has no roster row until it first runs, and
  // gating on membership silently rerouted that first message to the
  // commander ("给：Claude Code" answered by 指挥官, on-device 2026-08-23).
  // The router therefore honors any non-reserved floor; the BUS owns
  // validation against the enabled-agent registry and clears dead floors
  // before calling in (bus e2e pins that half).
  it('honors an off-roster floor — validation is the caller\'s, membership is not eligibility', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '你好', members,
      activeRecipient: 'freshagent01',
    });
    expect(r.to).toEqual(['freshagent01']);
    expect(r.hadExplicitMention).toBe(false);
  });

  it('user explicit @commander overrides the floor (routes to commander)', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@commander switch tasks', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['commander']);
  });

  it('user explicit @<otherAgent> while handed off routes only to that agent', () => {
    const members2 = [...members, { kind: 'agent' as const, id: 'coder', joined_at: 't' }];
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@coder quick q', members: members2,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['coder']);
    expect(r.hadExplicitMention).toBe(true);
  });

  it('an absent/reserved floor falls back to [commander]', () => {
    // Dead-floor protection (deleted/disabled agent) lives in the BUS's
    // registry check now — it clears the floor before the router runs. The
    // router's own fallback covers only "no floor at all" and the reserved
    // ids, which are not agent routes.
    expect(resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'still there?', members,
    }).to).toEqual(['commander']);
    expect(resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'still there?', members,
      activeRecipient: 'commander',
    }).to).toEqual(['commander']);
  });

  it('commander reply ignores the floor (commander/agent always → user)', () => {
    const r = resolveRecipients({
      fromKind: 'commander', fromId: 'commander', text: 'done', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['user']);
  });

  it('commander with no @ → defaults to [user]', () => {
    const r = resolveRecipients({ fromKind: 'commander', fromId: 'commander', text: 'done', members });
    expect(r.to).toEqual(['user']);
  });

  it('agent with no @ → defaults to [user]', () => {
    // Agents surface their output to the human user by default — most
    // turns produce intermediate / final results meant for user-facing
    // display. Returning control to commander uses `<handback>` (or a CLI
    // agent's `orkas_handoff_to_commander`), never a prose mention.
    const r = resolveRecipients({ fromKind: 'agent', fromId: 'writer', text: 'done', members });
    expect(r.to).toEqual(['user']);
  });

  it('explicit @<aid> routes only to that actor', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@writer go', members,
    });
    expect(r.to).toEqual(['writer']);
  });

  it('@unknown returns empty `to` + populated `unknown` (bus applies default)', () => {
    // When tokens were present but none resolved synchronously, router
    // returns `to=[]` so the bus can try async resolution before
    // committing to the sender-default recipient. If router defaulted
    // here, a successful async resolve would end up appending the agent
    // alongside the default user/commander, double-routing the message.
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@nobody help', members,
    });
    expect(r.to).toEqual([]);
    expect(r.unknown).toEqual(['nobody']);
  });

  it('user multiple @-mentions deduped + union routed', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user',
      text: '@writer please / and @writer again', members,
    });
    expect(r.to).toEqual(['writer']);
  });

  // Bug-fix invariant: commander/agent 散文里写 `@<X>` 不再触发派活
  // (LLM 派活走 dispatch_to / plan_set 工具)。详见 CLAUDE.md §5
  // "派活通道" + docs/plans/dispatch-via-tool-call.md。
  it('commander @ in text routes to default (user) — @ no longer dispatches', () => {
    const r = resolveRecipients({
      fromKind: 'commander', fromId: 'commander',
      text: '我让 **@writer** 先做这件事,然后 @writer 收尾', members,
    });
    expect(r.to).toEqual(['user']);
    expect(r.unknown).toEqual([]);
  });

  it('agent @<agent> in text routes to default (user) — @ no longer dispatches agents', () => {
    const r = resolveRecipients({
      fromKind: 'agent', fromId: 'writer',
      text: '辛苦 @writer 接力', members,
    });
    expect(r.to).toEqual(['user']);
  });

  it('agent @commander / @指挥官 / @user in prose stays with the user (display-only)', () => {
    for (const text of [
      '辛苦 @commander 接力',
      '@指挥官 我这边卡住了，需要你协调。',
      '这一格写的是不带代码格式的 @指挥官，系统就把整条回复当成了发给指挥官的消息',
      '@user 结果在这里',
    ]) {
      const r = resolveRecipients({ fromKind: 'agent', fromId: 'writer', text, members });
      expect(r.to).toEqual(['user']);
      expect(r.unknown).toEqual([]);
      expect(r.hadExplicitMention).toBe(false);
    }
  });
});

describe('group_chat router › extractHandbackFromFinal', () => {
  it('detects + strips a legacy bare marker without inventing a reason', () => {
    const r = extractHandbackFromFinal('All done for now.\n<handback />');
    expect(r.handback).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.cleanText).toBe('All done for now.');
    expect(r.cleanText).not.toContain('handback');
  });

  it('extracts completed_handoff from the paired marker form', () => {
    const r = extractHandbackFromFinal(
      "Finished the delegated work.\n<handback reason='completed_handoff'></handback>",
    );
    expect(r.handback).toBe(true);
    expect(r.reason).toBe('completed_handoff');
    expect(r.cleanText).toBe('Finished the delegated work.');
  });

  it('extracts capability_boundary from a self-closing marker', () => {
    const r = extractHandbackFromFinal(
      'Video production is outside my workflow.\n<handback reason="capability_boundary" />',
    );
    expect(r.handback).toBe(true);
    expect(r.reason).toBe('capability_boundary');
    expect(r.cleanText).toBe('Video production is outside my workflow.');
  });

  it('strips unknown or conflicting reasons but leaves the routing reason undefined', () => {
    for (const text of [
      '<handback reason="done" />',
      '<handback reason="capability_boundary" reason="completed_handoff" />',
      '<handback reason="capability_boundary" />\n<handback />',
      '<handback reason="capability_boundary" />\n<handback reason="completed_handoff" />',
    ]) {
      const r = extractHandbackFromFinal(text);
      expect(r.handback).toBe(true);
      expect(r.reason).toBeUndefined();
      expect(r.cleanText).toBe('');
    }
  });

  it('no marker → handback undefined, text untouched', () => {
    const r = extractHandbackFromFinal('Here is lesson 2, any questions?');
    expect(r.handback).toBeUndefined();
    expect(r.cleanText).toBe('Here is lesson 2, any questions?');
  });

  it('look-alikes that pass the cheap <handback substring check but not the marker regex are NOT handback', () => {
    for (const text of [
      'See <handbackfoo /> for details.',        // \b after handback fails
      'The <handback-note> tag is documented.',  // not self-closing, no </handback>
      '<handbackish>content</handbackish>',       // \b fails on the word char
    ]) {
      const r = extractHandbackFromFinal(text);
      expect(r.handback).toBeUndefined();
      expect(r.cleanText).toBe(text);
    }
  });

  it('a real marker amid look-alike noise still detects handback and strips only the marker', () => {
    const r = extractHandbackFromFinal('Mentioning <handback-note> but actually done.\n<handback />');
    expect(r.handback).toBe(true);
    expect(r.cleanText).toBe('Mentioning <handback-note> but actually done.');
  });
});

describe('group_chat router › form encoding', () => {
  it('encodeSubmission round-trips through decodeSubmission', () => {
    const form = {
      form_id: 'abcdef0123456789',
      agent_id: 'writer',
      fields: [
        { id: 'topic', label: 'Topic', type: 'text' as const, default: '' },
        { id: 'count', label: 'Count', type: 'number' as const, default: 1 },
      ],
    };
    const text = encodeSubmission(form, { topic: 'hello', count: 5 });
    const decoded = decodeSubmission(text);
    expect(decoded).not.toBeNull();
    expect(decoded?.form_id).toBe('abcdef0123456789');
    expect(decoded?.agent_id).toBe('writer');
    expect(decoded?.values).toEqual({ topic: 'hello', count: 5 });
  });

  it('extractFormFromFinal pulls fenced block + falls back to defaultAgentId', () => {
    const text = [
      'before',
      '',
      '```agent-input-form',
      JSON.stringify({ fields: [{ id: 'q', label: 'Q', type: 'text' }] }),
      '```',
      '',
      'after',
    ].join('\n');
    const r = extractFormFromFinal(text, 'writer');
    expect(r.form?.agent_id).toBe('writer');
    expect(r.form?.fields[0].id).toBe('q');
    expect(r.cleanText).toContain('before');
    expect(r.cleanText).toContain('after');
    expect(r.cleanText).not.toContain('agent-input-form');
  });

  it('extractFormFromFinal pulls XML form blocks without exposing the raw protocol text', () => {
    const text = [
      '请补充信息。',
      '',
      '<agent-input-form>',
      JSON.stringify({
        fields: [
          { id: 'topic', label: 'Topic', type: 'text', required: true },
          { id: 'files', label: 'Files', type: 'file', multiple: true },
        ],
      }),
      '</agent-input-form>',
      '',
      '收到后继续。',
    ].join('\n');

    const r = extractFormFromFinal(text, 'writer');
    expect(r.form?.agent_id).toBe('writer');
    expect(r.form?.fields.map((f) => f.id)).toEqual(['topic', 'files']);
    expect(r.cleanText).toContain('请补充信息。');
    expect(r.cleanText).toContain('收到后继续。');
    expect(r.cleanText).not.toContain('<agent-input-form>');
    expect(r.cleanText).not.toContain('"fields"');
  });

  it('extractPlanInteractionFromFinal strips valid markers and returns the latest status', () => {
    const text = [
      '我需要先和你确认目标。',
      '<plan-interaction status="open" />',
      '',
      '收到后我会继续。',
      '<plan-interaction status="closed"></plan-interaction>',
    ].join('\n');

    const r = extractPlanInteractionFromFinal(text);
    expect(r.status).toBe('closed');
    expect(r.cleanText).toContain('我需要先和你确认目标。');
    expect(r.cleanText).toContain('收到后我会继续。');
    expect(r.cleanText).not.toContain('plan-interaction');
  });

  it('extractPlanInteractionFromFinal leaves invalid markers visible', () => {
    const text = '继续确认。\n<plan-interaction status="wait" />';
    const r = extractPlanInteractionFromFinal(text);
    expect(r.status).toBeUndefined();
    expect(r.cleanText).toBe(text);
  });

  it('encodeSubmission leaves optional blanks empty instead of writing placeholders', () => {
    const form = {
      form_id: 'abcdef0123456789',
      agent_id: 'writer',
      fields: [
        { id: 'optional', label: 'Optional', type: 'text' as const, default: '' },
        { id: 'choice', label: 'Choice', type: 'select' as const, default: 'a', options: [{ value: 'a', label: 'A' }] },
        { id: 'multi', label: 'Multi', type: 'multiselect' as const, default: [], options: [{ value: 'x', label: 'X' }] },
      ],
    };

    const text = encodeSubmission(form, {});
    const decoded = decodeSubmission(text);

    expect(text).toContain('Optional：\n');
    expect(text).toContain('Choice：A');
    expect(text).toContain('Multi：\n');
    expect(text).not.toContain('unfilled');
    expect(text).not.toContain('undefined');
    expect(decoded?.values).toEqual({});
  });

  it('computeFormId is deterministic on same inputs', () => {
    const fields = [{ id: 'q', label: 'Q', type: 'text' as const, default: '' }];
    expect(computeFormId('cid1', 'msg1', 'writer', fields))
      .toBe(computeFormId('cid1', 'msg1', 'writer', fields));
  });
});

describe('group_chat router › classifyUserMentionRoute (D29)', () => {
  // Fixture contract (repo rule: parser code needs accepted real shapes +
  // rejected look-alikes). The classifier only decides direct vs planned;
  // it never cuts text, so no agent can receive half a sentence again.
  const IDS = { a: 'agent-aaa1', b: 'agent-bbb2', helper: 'agent-ccc3' };
  const CMD = 'commander';
  const NAMES: Record<string, string> = {
    A: IDS.a, B: IDS.b, 'Writing Helper': IDS.helper, 写作助手: IDS.helper, 指挥官: CMD, commander: CMD,
  };
  const route = (text: string, recipientIds: string[] = [...Object.values(IDS), CMD]) => classifyUserMentionRoute(text, {
    tokenToId: (token: string) => NAMES[token] || null,
    recipientIds: new Set(recipientIds),
    names: Object.keys(NAMES),
  });

  it('keeps a message that starts with its only mentioned actor on the direct path', () => {
    expect(route('@A do the whole thing')).toEqual({ kind: 'direct' });
    expect(route('@A first step @A second step')).toEqual({ kind: 'direct' });
    expect(route('> quoted context\n@A handle it')).toEqual({ kind: 'direct' });
    expect(route('@指挥官 总结现状')).toEqual({ kind: 'direct' });
    expect(route('just some text')).toEqual({ kind: 'direct' });
    expect(route('mail a@b and c@d then decide')).toEqual({ kind: 'direct' });
  });

  it('routes a Commander-only mention directly wherever it appears', () => {
    // Commander is always a planner candidate, so there is nothing to split.
    expect(route('先看一下现状 @指挥官 再定计划')).toEqual({ kind: 'direct' });
    expect(route('check first @commander review @指挥官 again')).toEqual({ kind: 'direct' });
    expect(route('先看一下现状 @指挥官 再让 @A 跑测试')).toEqual({ kind: 'plan', candidates: [CMD, IDS.a] });
  });

  it('sends every orchestrated shape to the planner with candidates in first-mention order', () => {
    // The shapes positional segmentation cut apart (2026-10-04 probe).
    expect(route('帮我把这段翻译成英文 @A')).toEqual({ kind: 'plan', candidates: [IDS.a] });
    expect(route('这个方案 @A 你看下有没有问题')).toEqual({ kind: 'plan', candidates: [IDS.a] });
    expect(route('@A 和 @B 一起评审这份方案')).toEqual({ kind: 'plan', candidates: [IDS.a, IDS.b] });
    expect(route('让 @A 和 @B 分别写初稿，最后汇总成一份')).toEqual({ kind: 'plan', candidates: [IDS.a, IDS.b] });
    expect(route('把 @A 的报告发给 @B 改一下')).toEqual({ kind: 'plan', candidates: [IDS.a, IDS.b] });
    expect(route('@A 写一篇介绍，然后@B 做成一份ppt文件')).toEqual({ kind: 'plan', candidates: [IDS.a, IDS.b] });
    expect(route('@指挥官 总结现状 @A 跑一遍测试')).toEqual({ kind: 'plan', candidates: [CMD, IDS.a] });
    expect(route('@Writing Helper polish the intro @B then the ending'))
      .toEqual({ kind: 'plan', candidates: [IDS.helper, IDS.b] });
  });

  it('treats mention-only text as nothing to dispatch', () => {
    expect(route('@A')).toEqual({ kind: 'mention_only' });
    expect(route('@A @B ')).toEqual({ kind: 'mention_only' });
    expect(route('> context\n@A')).toEqual({ kind: 'mention_only' });
  });

  it('never counts mentions in code, quotes, or outside the recipient set', () => {
    expect(route('@A inspect `@B` and\n```xml\n@B\n```')).toEqual({ kind: 'direct' });
    expect(route('> quoted from @B earlier\n@A do a')).toEqual({ kind: 'direct' });
    expect(route('@A do a @B do b', [IDS.a])).toEqual({ kind: 'direct' });
    expect(route('@A do it with @nobody')).toEqual({ kind: 'direct' });
  });

  it('uses host-validated resources as content without routing mentions inside the quoted source', () => {
    expect(classifyUserMentionRoute('@Writing Helper', {
      tokenToId: (token) => NAMES[token] || null, recipientIds: new Set(Object.values(IDS)),
      names: Object.keys(NAMES), hasMessageContent: true,
    })).toEqual({ kind: 'direct' });
    const members = [{ kind: 'agent' as const, id: IDS.helper, name: 'Writing Helper', joined_at: '' }];
    expect(resolveRecipients({ fromKind: 'user', fromId: 'user', members, text: '@Writing Helper',
      hasMessageContent: true }).to).toEqual([IDS.helper]);
    expect(resolveRecipients({ fromKind: 'user', fromId: 'user', members, text: '@Writing Helper',
      hasMessageContent: false })).toMatchObject({ to: [], mentionOnly: true });
    expect(classifyUserMentionRoute('@A @B', {
      tokenToId: (token) => NAMES[token] || null, recipientIds: new Set(Object.values(IDS)),
      names: Object.keys(NAMES), hasMessageContent: true,
    })).toEqual({ kind: 'plan', candidates: [IDS.a, IDS.b] });
  });

  it('resolveRecipients hands planned sends to the bus with their candidates', () => {
    const members = [
      { kind: 'commander' as const, id: CMD, joined_at: '' },
      { kind: 'agent' as const, id: IDS.a, name: 'A', joined_at: '' },
      { kind: 'agent' as const, id: IDS.b, name: 'B', joined_at: '' },
    ];
    const planned = resolveRecipients({ fromKind: 'user', fromId: 'user', members, text: '让 @A 和 @B 分别写初稿，最后汇总' });
    expect(planned).toMatchObject({ to: [IDS.a, IDS.b], plannerCandidates: [IDS.a, IDS.b], hadExplicitMention: true });
    const direct = resolveRecipients({ fromKind: 'user', fromId: 'user', members, text: '@A 写初稿' });
    expect(direct.to).toEqual([IDS.a]);
    expect(direct.plannerCandidates).toBeUndefined();
    const mentionOnly = resolveRecipients({ fromKind: 'user', fromId: 'user', members, text: '@A @B' });
    expect(mentionOnly).toMatchObject({ to: [], mentionOnly: true });
  });
});
