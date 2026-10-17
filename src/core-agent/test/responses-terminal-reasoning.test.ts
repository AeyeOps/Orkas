// Original complete reasoning must survive SDK parsing, disk reload and replay.
// Synthetic Responses transport; no provider requests or real tool side effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import { AgentRunner } from '../src/agent/runner.js';
import { Session } from '../src/agent/session.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { defineTool } from '../src/tools/base.js';

const model = { api: 'openai-responses' as const, provider: 'fixture-provider', id: 'fixture', name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1', reasoning: true, input: ['text' as const], contextWindow: 10000,
  maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reason = { type: 'reasoning', id: 'rs_fixture', status: 'completed', summary: [],
  encrypted_content: 'synthetic-cipher-A', _orkas_replay: 'v1:synthetic' };
const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'inspect', arguments: '{}' };
const message = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Seven.', annotations: [] }] };
const added = (item: any, output_index: number) => ({ type: 'response.output_item.added', output_index,
  item: { ...item, status: 'in_progress', summary: [], content: [], encrypted_content: undefined } });
const done = (item: any, output_index: number) => ({ type: 'response.output_item.done', output_index, item });
const terminal = (output: any[], status = 'completed') => ({ type: `response.${status}`,
  response: { id: 'resp_fixture', status, output,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
function response(events: any[]) {
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());

it.each((['openai-responses', 'azure-openai-responses', 'openai-codex-responses'] as const)
  .flatMap(api => (['complete', 'stream'] as const).map(mode => ({ api, mode }))))
('recovers the missing item through $api / $mode, persistence and next wire request', async ({ api, mode }) => {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: any) => {
    expect(String(url)).toContain('fixture.invalid');
    const body = new Headers(init.headers).get('content-encoding') === 'zstd'
      ? zlib.zstdDecompressSync(init.body).toString('utf8') : init.body;
    bodies.push(JSON.parse(body));
    expect(bodies.length).toBeLessThanOrEqual(2);
    return bodies.length === 1
      ? response([added(reason, 0), added(call, 1), done(call, 1), terminal([reason, call])])
      : response([added(message, 0), done(message, 0), terminal([message])]);
  }));
  const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
  const provider = createPiProvider({ provider: 'fixture-provider', apiKey: `fixture.${token}.fixture`, customModel: { ...model, api } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reasoning-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: 'text', text: 'Inspect the count.' }]);
    const params = { messages: session.getMessagesForModel(), reasoning: 'low' as const };
    let content;
    if (mode === 'complete') content = (await provider.complete(params)).content;
    else for await (const event of provider.stream(params)) {
      expect(event.type).not.toBe('error');
      if (event.type === 'message_end') content = event.content;
    }
    expect(content).toBeDefined();
    const thoughts = content!.filter(c => c.type === 'thinking');
    expect(thoughts).toHaveLength(1);
    expect(JSON.parse(thoughts[0].thinkingSignature!)).toEqual(reason);
    session.addAssistantMessage(content!);
    const tool = content!.find(c => c.type === 'tool_use');
    expect(tool?.type).toBe('tool_use');
    session.addToolResult(tool!.type === 'tool_use' ? tool!.id : '', '{"count":7}');
    const restored = new PersistentSession({ sessionFile: file });
    const messages = restored.getMessagesForModel();
    const before = JSON.stringify(messages);
    await provider.complete({ messages, reasoning: 'low' });
    expect(JSON.stringify(messages)).toBe(before);
    const { status, _orkas_replay, ...wireReason } = reason;
    expect(bodies[1].input.filter((x: any) => x.type === 'reasoning')).toEqual([wireReason]);
    expect(bodies[1].input.filter((x: any) => x.type === 'function_call')).toHaveLength(1);
    expect(bodies[1].input.find((x: any) => x.type === 'function_call_output').call_id)
      .toBe(bodies[1].input.find((x: any) => x.type === 'function_call').call_id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const plaintext = { type: 'reasoning', id: 'rs_fixture', status: 'completed', summary: [],
  content: [{ type: 'reasoning_text', text: 'Original calculation: seven.' }], _orkas_replay: 'v1:synthetic' };
const noCipher = { ...reason, encrypted_content: undefined };
it.each([
  { label: 'normal equal ciphertext', events: [added(reason, 0), done(reason, 0), terminal([reason])], expected: [reason] },
  { label: 'different ciphertext keeps item-done state', events: [added(reason, 0), done(reason, 0),
    terminal([{ ...reason, encrypted_content: 'synthetic-cipher-B' }])], expected: [reason] },
  { label: 'SDK existing missing-cipher backfill', events: [added(reason, 0), done(noCipher, 0), terminal([reason])], expected: [reason] },
  { label: 'missing done with original plaintext', events: [added(plaintext, 0), terminal([plaintext])], expected: [plaintext] },
  { label: 'terminal has no matching item', events: [added(reason, 0), terminal([{ ...reason, id: 'rs_other' }])], expected: [] },
  { label: 'terminal item was never observed', events: [terminal([reason])], expected: [] },
  { label: 'incomplete terminal cannot finish reasoning', events: [added(reason, 0), terminal([reason], 'incomplete')], expected: [] },
  { label: 'in-progress terminal item', events: [added(reason, 0), terminal([{ ...reason, status: 'in_progress' }])], expected: [] },
  { label: 'duplicate item-added event', events: [added(reason, 0), added(reason, 0), terminal([reason])], expected: [] },
  { label: 'duplicate terminal identity', events: [added(reason, 0), terminal([reason, reason])], expected: [] },
  { label: 'different response identity', events: [{ type: 'response.created', response: { id: 'resp_other' } },
    added(reason, 0), terminal([reason])], expected: [] },
  { label: 'terminal item occupies a different index', events: [added(reason, 0), terminal([message, reason])], expected: [] },
  { label: 'malformed reasoning summary', events: [added(reason, 0), terminal([{ ...reason, summary: 'invalid' }])], expected: [] },
  { label: 'malformed encrypted state', events: [added(reason, 0), terminal([{ ...reason, encrypted_content: 42 }])], expected: [] },
])('uses complete original state only: $label', async ({ events, expected }) => {
  vi.stubGlobal('fetch', vi.fn(async () => response(events)));
  const provider = createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model });
  const result = await provider.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Calculate.' }] }] });
  const thoughts = result.content.filter(c => c.type === 'thinking');
  expect(thoughts.filter(c => c.thinkingSignature).map(c => JSON.parse(c.thinkingSignature!))).toEqual(expected);
  if (expected[0] === plaintext) expect(thoughts[0].thinking).toBe(plaintext.content[0].text);
});

it('preserves multiple interleaved items without replacing a completed sibling or changing order', async () => {
  const sibling = { ...reason, id: 'rs_second', encrypted_content: 'second-cipher' };
  const events = [added(reason, 0), added(message, 1), added(sibling, 2), done(sibling, 2), done(message, 1),
    terminal([reason, message, { ...sibling, encrypted_content: 'different-terminal-cipher' }])];
  vi.stubGlobal('fetch', vi.fn(async () => response(events)));
  const provider = createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model });
  const result = await provider.complete({ messages: [] });
  expect(result.content.map(c => c.type)).toEqual(['thinking', 'text', 'thinking']);
  expect(result.content.filter(c => c.type === 'thinking').map(c => JSON.parse(c.thinkingSignature!))).toEqual([reason, sibling]);
});

it.each(['missing terminal', 'failed terminal', 'cancelled'] as const)('never commits recovered state after %s', async scenario => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => {
    const events: any[] = [added(reason, 0)];
    if (scenario === 'failed terminal') events.push({ type: 'response.failed', response: { status: 'failed',
      output: [reason], error: { code: 'server_error', message: 'Synthetic failure.' } } });
    if (scenario === 'cancelled') { events.push(terminal([reason])); controller.abort(); }
    return response(events);
  }));
  const provider = createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model });
  const events = [];
  for await (const event of provider.stream({ messages: [], signal: controller.signal, onRequestFailure: () => {} })) events.push(event);
  expect(events.filter(e => e.type === 'message_end')).toHaveLength(0);
  expect(events.filter(e => e.type === 'error')).toHaveLength(1);
});

it.each([false, true])('tool execution remains SDK-owned (tool item completed: %s)', async toolDone => {
  let executions = 0;
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    expect(bodies.length).toBeLessThanOrEqual(2);
    return bodies.length === 1
      ? response([added(reason, 0), added(call, 1), ...(toolDone ? [done(call, 1)] : []), terminal([reason, call])])
      : response([added(message, 0), done(message, 0), terminal([message])]);
  }));
  const registry = new ProviderRegistry();
  registry.registerFactory('fixture-provider', () => createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model }));
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'fixture-provider', defaultModel: 'fixture', maxRetries: 0 } }),
    providers: registry, session: new Session(), evolution: { enabled: false },
    tools: [defineTool({ name: 'inspect', description: 'Synthetic execution counter.', inputSchema: { type: 'object' },
      execute: async () => { executions++; return { content: '{"count":7}' }; } })] });
  const result = await runner.run({ message: 'Inspect once.' });
  expect(executions).toBe(toolDone ? 1 : 0);
  expect(bodies).toHaveLength(toolDone ? 2 : 1);
  if (toolDone) {
    expect(result.meta.error).toBeUndefined();
    expect(bodies[1].input.filter((i: any) => i.type === 'reasoning')).toHaveLength(1);
    expect(bodies[1].input.filter((i: any) => i.type === 'function_call_output')).toHaveLength(1);
  } else expect(result.meta.error).toBeDefined();
});
