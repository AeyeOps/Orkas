import { afterEach, describe, expect, it, vi } from 'vitest';

import * as userInput from '../../../../src/main/features/local_agents/cli_user_input';
import { notifyUserSwitch } from '../../../../src/main/features/user-switch-hooks';

const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnings, error: vi.fn() }),
}));

afterEach(() => {
  vi.useRealTimers();
  userInput._resetForTest();
  warnings.mockClear();
});

function request(overrides: Record<string, unknown> = {}) {
  return userInput.requestUserInput({
    uid: 'u1',
    cid: 'c1',
    runId: 'run-1',
    agentId: 'agent-1',
    agentName: 'Codex Agent',
    cli: 'codex',
    request: {
      id: 'native-request-1',
      questions: [{
        id: 'environment',
        header: 'Environment',
        question: 'Choose target',
        options: [{ label: 'staging', description: 'Use staging' }],
        isOther: true,
      }],
    },
    ...overrides,
  } as any);
}

describe('local_agents/cli_user_input', () => {
  it.each(['claude', 'codex'])('saves a %s answer once before resuming the native request, including concurrent and lost IPC replies', async cli => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    let saved!: () => void;
    const saveAnswer = vi.fn(() => new Promise<void>(resolve => { saved = resolve; }));
    const response = request({ cli, saveAnswer });
    let resumed = false;
    void response.then(() => { resumed = true; });
    const first = userInput.respond(requestId, 'u1', { environment: ['staging'] });
    const duplicate = userInput.respond(requestId, 'u1', { environment: ['staging'] });
    await vi.waitFor(() => expect(saveAnswer).toHaveBeenCalledOnce());
    expect(saveAnswer).toHaveBeenCalledWith('Choose target\nstaging', requestId);
    expect(resumed).toBe(false);
    saved();
    expect(await first).toEqual({ handled: true, cancelled: false });
    expect(await duplicate).toEqual(await first);
    expect(await response).toEqual({ cancelled: false, answers: { environment: ['staging'] } });
    expect(await userInput.respond(requestId, 'u1', { environment: ['staging'] })).toEqual(await first);
    expect(await userInput.respond(requestId, 'other', { environment: ['staging'] })).toEqual({ handled: false });
    expect(saveAnswer).toHaveBeenCalledOnce();
  });

  it('keeps a failed history save retryable without resuming the CLI', async () => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    const saveAnswer = vi.fn<(...args: any[]) => Promise<void>>().mockRejectedValueOnce(new Error('injected write failure')).mockResolvedValue(undefined);
    const response = request({ saveAnswer });
    let resumed = false;
    void response.then(() => { resumed = true; });
    expect(await userInput.respond(requestId, 'u1', { environment: ['staging'] })).toEqual({ handled: false, save_failed: true });
    expect(resumed).toBe(false);
    expect(warnings).toHaveBeenCalledExactlyOnceWith('history save failed', expect.objectContaining({
      request_id: expect.any(String),
      error: expect.objectContaining({ message_hash: expect.stringMatching(/^[a-f0-9]{12}$/) }),
    }));
    const diagnostic = JSON.stringify(warnings.mock.calls);
    for (const privateValue of [requestId, 'injected write failure', 'Choose target', 'staging']) {
      expect(diagnostic).not.toContain(privateValue);
    }
    expect(await userInput.respond(requestId, 'u1', { environment: ['staging'] })).toEqual({ handled: true, cancelled: false });
    expect(saveAnswer.mock.calls.map(call => call[1])).toEqual([requestId, requestId]);
    await expect(response).resolves.toMatchObject({ cancelled: false });
  });

  it('lets an in-flight saved answer finish before cancellation, then expires its receipt on account switch', async () => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    let save!: () => void;
    const saveAnswer = vi.fn(() => new Promise<void>(resolve => { save = resolve; }));
    const cancel = vi.fn(async () => 'cancelled' as const);
    const response = request({ saveAnswer, request: { questions: [{ id: 'scope', question: 'Which scope?' }], cancel } });
    const reply = userInput.respond(requestId, 'u1', { scope: ['Current'] });
    const declined = userInput.cancelRequest(requestId, 'u1');
    save();
    expect(await reply).toEqual({ handled: true, cancelled: false });
    expect(await declined).toEqual({ handled: false, closed: true });
    expect(cancel).not.toHaveBeenCalled();
    await expect(response).resolves.toMatchObject({ cancelled: false });
    notifyUserSwitch('u1', 'u2');
    expect(await userInput.respond(requestId, 'u1', { scope: ['Current'] })).toEqual({ handled: false });
  });

  it('omits secret questions and answers from history, while returning every native answer', async () => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    const saveAnswer = vi.fn(async () => {});
    const response = request({ saveAnswer, request: { questions: [
      { id: 'scope', question: 'Which scope?' },
      { id: 'token', question: 'Private token prompt', isSecret: true },
    ] } });
    await userInput.respond(requestId, 'u1', { scope: ['Current', 'Docs'], token: ['private-fixture-value'] });
    expect(saveAnswer).toHaveBeenCalledExactlyOnceWith('Which scope?\nCurrent, Docs', requestId);
    await expect(response).resolves.toEqual({ cancelled: false, answers: { scope: ['Current', 'Docs'], token: ['private-fixture-value'] } });
    const secret = request({ saveAnswer, request: { questions: [{ id: 'token', question: 'Token', isSecret: true }] } });
    await userInput.respond(requestId, 'u1', { token: ['private-only'] });
    await expect(secret).resolves.toMatchObject({ cancelled: false });
    expect(saveAnswer).toHaveBeenCalledOnce();
  });

  it('retains a failed cancellation for retry and settles only after native confirmation', async () => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    let confirm!: (value: 'cancelled') => void;
    const cancel = vi.fn<() => Promise<'cancelled' | 'closed' | 'failed'>>()
      .mockResolvedValueOnce('failed')
      .mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const response = request({ request: { questions: [{ id: 'scope', question: 'Choose scope' }], cancel } });
    let settled = false;
    void response.then(() => { settled = true; });
    expect(await userInput.cancelRequest(requestId, 'other-account')).toEqual({ handled: false });
    expect(cancel).not.toHaveBeenCalled();
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, cancel_failed: true });
    expect(settled).toBe(false);
    const first = userInput.cancelRequest(requestId, 'u1');
    const duplicate = userInput.cancelRequest(requestId, 'u1');
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(await userInput.respond(requestId, 'u1', { scope: ['racing answer'] })).toEqual({ handled: false });
    confirm('cancelled');
    expect(await first).toEqual({ handled: true, cancelled: true });
    expect(await duplicate).toEqual({ handled: true, cancelled: true });
    expect(await response).toEqual({ cancelled: true, answers: { scope: [] } });
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, closed: true });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each(['unknown', 'exception'])('never retries or accepts a second answer after an uncertain cancellation: %s', async outcome => {
    let requestId = '';
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    const cancel = vi.fn(async () => 'unknown' as const);
    if (outcome === 'exception') cancel.mockRejectedValueOnce(new Error('delivery unknown'));
    const controller = new AbortController();
    const response = request({ request: { questions: [{ id: 'scope', question: 'Choose scope' }], cancel, signal: controller.signal } });
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, unknown: true });
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, unknown: true });
    expect(await userInput.respond(requestId, 'u1', { scope: ['late answer'] })).toEqual({ handled: false });
    expect(cancel).toHaveBeenCalledOnce();
    controller.abort();
    await expect(response).resolves.toMatchObject({ cancelled: true });
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, closed: true });
  });

  it('does not claim native cancellation when the adapter cannot confirm it', async () => {
    let requestId = '';
    userInput._setBroadcastForTest((_channel, payload: any) => { requestId = payload.request_id || requestId; });
    const response = request();
    expect(await userInput.cancelRequest(requestId, 'u1')).toEqual({ handled: false, cancel_failed: true });
    expect(await userInput.respond(requestId, 'u1', { environment: ['staging'] })).toEqual({ handled: true, cancelled: false });
    expect(await response).toEqual({ cancelled: false, answers: { environment: ['staging'] } });
  });

  it('returns empty answers immediately when no renderer can receive the request', async () => {
    userInput._setBroadcastForTest(() => false);

    await expect(request()).resolves.toEqual({
      cancelled: true,
      answers: { environment: [] },
    });
  });

  it.each(['codex', 'claude'])('keeps an unanswered %s request open without a CLI deadline, then closes only the CLI-cancelled request', async cli => {
    vi.useFakeTimers();
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const controller = new AbortController();
    const pending = request({ cli, request: {
      id: 'native-request-deadline', isBlocking: true,
      signal: controller.signal,
      questions: [{ id: 'environment', question: 'Choose target', options: [{ label: 'staging' }] }],
    } });
    const requestId = deliveries[0].payload.request_id as string;

    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(settled).toBe(false);
    expect(deliveries.some((entry) => entry.channel === 'local-agent:user-input_cancelled')).toBe(false);
    controller.abort();

    await expect(pending).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries).toContainEqual({
      channel: 'local-agent:user-input_cancelled',
      payload: { request_ids: [requestId] },
    });
    expect(await userInput.respond(requestId, 'u1', { environment: ['staging'] } as any)).toEqual({ handled: false });
  });

  it('publishes bounded questions and accepts one response from the owning account', async () => {
    let delivered: { channel: string; payload: any } | null = null;
    userInput._setBroadcastForTest((channel, payload) => {
      delivered = { channel, payload };
    });

    const pending = request({
      agentName: `Agent ${'n'.repeat(300)}\u0000`,
      conversationTitle: `Release ${'t'.repeat(300)}\u0007`,
      request: {
        id: 'must-not-be-rendered',
        isBlocking: true,
        questions: [
          {
            id: 'environment',
            question: `Choose ${'q'.repeat(3_000)}\u0000`,
            options: Array.from({ length: 20 }, (_, index) => ({
              label: `option-${index}`,
              description: 'description',
            })),
            isOther: true,
          },
          { id: 'token', question: 'Token', isSecret: true },
          { id: 'duplicate', question: 'First' },
          { id: 'ignored-fourth', question: 'Fourth' },
        ],
      },
    });

    expect(delivered?.channel).toBe('local-agent:user-input');
    expect(delivered?.payload).toMatchObject({
      cid: 'c1', agent_id: 'agent-1', cli: 'codex', is_blocking: true,
    });
    expect(delivered?.payload).not.toHaveProperty('id');
    expect(delivered?.payload.agent_name.length).toBeLessThanOrEqual(160);
    expect(delivered?.payload.conversation_title.length).toBeLessThanOrEqual(160);
    expect(delivered?.payload.questions).toHaveLength(3);
    expect(delivered?.payload.questions[0].question.length).toBe(2_000);
    expect(delivered?.payload.questions[0].options).toHaveLength(12);

    const requestId = delivered!.payload.request_id;
    expect(await userInput.respond(requestId, 'u2', { environment: ['production'] })).toEqual({ handled: false });
    expect(await userInput.respond(requestId, 'u1', {
      environment: ['staging', `custom-${'x'.repeat(5_000)}\u0000`],
      token: 'secret-value',
      ignored: ['not accepted'],
    })).toEqual({ handled: true, cancelled: false });

    const response = await pending;
    expect(response.cancelled).toBe(false);
    expect(response.answers.environment[0]).toBe('staging');
    expect(response.answers.environment[1]).toHaveLength(4_000);
    expect(response.answers.environment[1]).not.toContain('\u0000');
    expect(response.answers.token).toEqual(['secret-value']);
    expect(response.answers).not.toHaveProperty('ignored');
    expect(await userInput.respond(requestId, 'u1', {})).toEqual({ handled: false });
  });

  it('cancels only the abandoned run and makes its renderer response stale', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    const abandoned = request();
    const survivor = request({ runId: 'run-2' });
    const requests = deliveries
      .filter(entry => entry.channel === 'local-agent:user-input')
      .map(entry => entry.payload.request_id);

    userInput.cancelForRun('run-1');
    await expect(abandoned).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries).toContainEqual({
      channel: 'local-agent:user-input_cancelled',
      payload: { request_ids: [requests[0]] },
    });
    expect(await userInput.respond(requests[0], 'u1', { environment: ['staging'] })).toEqual({ handled: false });
    expect(await userInput.respond(requests[1], 'u1', { environment: ['staging'] })).toEqual({
      handled: true, cancelled: false,
    });
    await expect(survivor).resolves.toMatchObject({ cancelled: false });
  });

  it.each([0, 25, 20 * 60_000])('honors the CLI auto-resolution interval of %s ms without imposing a host cap', async autoResolutionMs => {
    vi.useFakeTimers();
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    const pending = request({
      request: {
        id: 'native-auto',
        autoResolutionMs,
        questions: [{ id: 'environment', question: 'Choose target' }],
      },
    });

    if (autoResolutionMs > 0) {
      await vi.advanceTimersByTimeAsync(autoResolutionMs - 1);
      expect(deliveries.at(-1)).toMatchObject({ channel: 'local-agent:user-input' });
    }
    await vi.advanceTimersByTimeAsync(autoResolutionMs > 0 ? 1 : 0);
    await expect(pending).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries.at(-1)).toMatchObject({ channel: 'local-agent:user-input_cancelled' });
    expect(await userInput.respond(deliveries[0].payload.request_id, 'u1', { environment: ['staging'] })).toEqual({ handled: false });
  });

  it('does not reopen a request already cancelled by the CLI before the host can show it', async () => {
    const broadcast = vi.fn();
    userInput._setBroadcastForTest(broadcast);
    const controller = new AbortController();
    controller.abort();
    await expect(request({ request: { signal: controller.signal, questions: [{ id: 'environment', question: 'Choose target' }] } }))
      .resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('cancels requests owned by the previous account on user switch', async () => {
    const deliveries: any[] = [];
    userInput._setBroadcastForTest((channel, payload) => deliveries.push({ channel, payload }));
    const previous = request();
    const next = request({ uid: 'u2', runId: 'run-u2' });

    notifyUserSwitch('u1', 'u2');
    await expect(previous).resolves.toMatchObject({ cancelled: true });
    const nextRequest = deliveries
      .filter(entry => entry.channel === 'local-agent:user-input')[1].payload.request_id;
    await userInput.respond(nextRequest, 'u2', { environment: ['staging'] });
    await expect(next).resolves.toMatchObject({ cancelled: false });
  });
});
