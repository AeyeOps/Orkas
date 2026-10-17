import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompletionParams, Message, ToolContext } from '../../../../src/core-agent/src/index';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

it.each([
  { label: 'healthy capacity', usage: 500, parallel: 1, summaryFails: false, writeFirst: true, recovered: false },
  { label: 'below ceiling with summary', usage: 22_500, parallel: 1, summaryFails: false, writeFirst: true, recovered: true },
  { label: 'below ceiling with unavailable summary', usage: 22_500, parallel: 1, summaryFails: true, writeFirst: true, recovered: true },
  { label: 'parallel marker reserves', usage: 21_000, parallel: 3, summaryFails: false, writeFirst: true, recovered: true },
  { label: 'over ceiling', usage: 24_000, parallel: 1, summaryFails: true, writeFirst: true, recovered: true },
  { label: 'protected latest round only', usage: 22_500, parallel: 1, summaryFails: false, writeFirst: false, recovered: false },
])('recovers real file reads: $label', async (scenario) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-budget-recovery-'));
  const previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  try {
    const uid = 'budget-recovery';
    const { activateUser } = await import('../../../../src/main/features/users');
    const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    activateUser(uid);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    expect(setWorkspacePath(uid, workspace).ok).toBe(true);
    const file = path.join(workspace, 'fixture.txt');
    const writeReceipt = path.join(workspace, 'writes.txt');
    fs.writeFileSync(file, 'Exact fixture content.');
    const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
    const read = createFileTools({ userId: uid }).find(t => t.name === 'read_files')!;
    const { AgentRunner, ProviderRegistry, createConfig, defineTool } = await import('../../../../src/core-agent/src/index');
    const { CONTEXT_COMPACTION_SYSTEM_PROMPT } = await import('../../../../src/core-agent/src/agent/runner');
    const { capToolResult } = await import('../../../../src/main/util/tool-result-cap');
    const reads: { budget: number; delivered: boolean; evidence: number }[] = [];
    const requests: { messages: Message[]; diagnostics: Record<string, any> }[] = [];
    let calls = 0;
    let summaries = 0;
    let reduced = false;
    const provider: any = {
      id: 'fixture', name: 'Fixture', validateAuth: async () => true,
      complete: async () => { throw new Error('Unexpected non-stream call'); },
      async *stream(params: CompletionParams) {
        if (params.systemPrompt === CONTEXT_COMPACTION_SYSTEM_PROMPT) {
          summaries++;
          if (scenario.summaryFails) throw new Error('Synthetic summary unavailable');
          yield { type: 'message_end', stopReason: 'end_turn', model: 'fixture',
            content: [{ type: 'text', text: 'The write completed once. Read the pending fixture.' }],
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
          return;
        }
        const diagnostics = params.requestMetadata?.contextBudgetDiagnostics as Record<string, any>;
        if (diagnostics.emergency_result === 'applied' || diagnostics.compaction_after_tokens !== undefined) reduced = true;
        requests.push({ messages: structuredClone(params.messages), diagnostics });
        const n = calls++;
        const readStart = scenario.writeFirst ? 1 : 0;
        if (n >= readStart + (scenario.writeFirst ? 2 : 1)) {
          yield { type: 'message_end', stopReason: 'end_turn', model: 'fixture',
            content: [{ type: 'text', text: 'Fixture finished.' }],
            usage: { inputTokens: 500, outputTokens: 5, totalTokens: 505 } };
          return;
        }
        const write = scenario.writeFirst && n === 0;
        const usage = write || reduced ? 500 : scenario.usage;
        yield { type: 'message_end', stopReason: 'tool_use', model: 'fixture',
          content: write ? [{ type: 'tool_use', id: 'write-0', name: 'record_write', input: {} }]
            : Array.from({ length: scenario.parallel }, (_, i) => ({ type: 'tool_use',
              id: `read-${n}-${i}`, name: 'read_files', input: { paths: [{ path: file }] } })),
          usage: { inputTokens: usage, outputTokens: 40, totalTokens: usage + 40 } };
      },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory('fixture', () => provider);
    const runner = new AgentRunner({ providers, config: createConfig({
      agent: { defaultProvider: 'fixture', defaultModel: 'fixture', maxToolLoops: 8 },
      evolution: { enabled: false },
      models: { catalog: { fixture: { provider: 'fixture', model: 'fixture', contextWindow: 32_000, maxOutputTokens: 4_096 } } },
    }), tools: [defineTool({ name: 'record_write', description: 'Record a fixture write',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        fs.appendFileSync(writeReceipt, 'once\n');
        return { content: 'Write completed. ' + 'Fixture receipt detail. '.repeat(160) };
      },
    }), { ...read, async execute(input: any, ctx: ToolContext) {
      const budget = (ctx.state.toolResultInlineLedger as { remainingTokens: number }).remainingTokens;
      const result = await read.execute(input, ctx);
      reads.push({ budget, delivered: result.content.includes('Exact fixture content.'),
        evidence: result.observations?.fileReads?.length ?? 0 });
      return result;
    } }], transformToolResult: (name, result, ctx) => capToolResult(name, result, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(root, 'results'),
    }) });
    const events: any[] = [];
    for await (const event of runner.runStream({ message: 'Record the write once, then read the fixture.', workingDir: workspace })) events.push(event);
    expect(fs.readFileSync(file, 'utf8')).toBe('Exact fixture content.');
    expect(fs.existsSync(writeReceipt) ? fs.readFileSync(writeReceipt, 'utf8') : '').toBe(scenario.writeFirst ? 'once\n' : '');
    expect(calls).toBe(scenario.writeFirst ? 4 : 2);
    expect(reads).toHaveLength((scenario.writeFirst ? 2 : 1) * scenario.parallel);
    expect(reads.slice(0, scenario.parallel).every(r => r.delivered)).toBe(scenario.usage === 500);
    if (scenario.usage !== 500) expect(reads.slice(0, scenario.parallel).every(r => r.budget === 0 && r.evidence === 0)).toBe(true);
    if (scenario.writeFirst) expect(reads.slice(scenario.parallel).every(r => r.delivered && r.evidence === 1)).toBe(scenario.recovered || scenario.usage === 500);
    else expect(reads.every(r => !r.delivered && r.evidence === 0)).toBe(true);
    expect(summaries).toBe(scenario.recovered ? 1 : 0);
    const applied = events.filter(e => e.type === 'context_status' && e.phase === 'emergency_reduction' && e.data.result === 'applied');
    expect(applied).toHaveLength(scenario.recovered && scenario.summaryFails ? 1 : 0);
    if (scenario.recovered) {
      const nextRequest = requests[2];
      expect(nextRequest.diagnostics.result_capacity_exhausted).toBe(1);
      expect(reads.slice(scenario.parallel).every(r => r.budget > 0)).toBe(true);
      // The latest read call and its failed receipt must survive either recovery path.
      const blocks = nextRequest.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content);
      for (let i = 0; i < scenario.parallel; i++) {
        expect(blocks.some(b => b.type === 'tool_use' && b.id === `read-1-${i}`)).toBe(true);
        expect(blocks.some(b => b.type === 'tool_result' && b.toolUseId === `read-1-${i}`)).toBe(true);
      }
      expect(nextRequest.diagnostics.emergency_after_tokens).toBeLessThan(22_881 - scenario.parallel * 1_000);
      if (scenario.usage < 22_881 && scenario.summaryFails) {
        expect(nextRequest.diagnostics.emergency_before_tokens).toBeLessThan(22_881);
      }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
