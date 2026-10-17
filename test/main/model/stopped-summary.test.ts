import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapCoreAgentEvents } from '../../../src/main/model/core-agent/event-mapper';
import { setCurrentLang } from '../../../src/main/i18n';
import type { AgentRunResult, LLMProvider } from '#core-agent';

describe('stopped summary core-to-host delivery', () => {
  it.each(['empty', 'failed', 'partial', 'complete'] as const)(
    'keeps stop diagnostics out of the answer and saved model history (%s)', async outcome => {
      const { AgentRunner, PersistentSession, ProviderRegistry, createConfig } = await import('#core-agent');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-stop-summary-'));
      const file = path.join(root, 'session.jsonl');
      const session = new PersistentSession({ sessionFile: file });
      let executed = 0;
      let summaryCalls = 0;
      let terminal: AgentRunResult | undefined;
      const provider: LLMProvider = {
        id: 'mock', name: 'Mock',
        async validateAuth() { return true; },
        async complete(params) {
          summaryCalls++;
          expect(params.tools).toBeUndefined();
          if (outcome === 'failed') throw new Error('synthetic summary outage');
          return {
            model: 'mock-model',
            stopReason: outcome === 'partial' ? 'max_tokens' : 'end_turn',
            content: outcome === 'empty' ? [] : [{ type: 'text', text: '已经保存草稿。' }],
          };
        },
        async *stream() {
          yield { type: 'message_start' };
          yield { type: 'message_end', model: 'mock-model', stopReason: 'tool_use', content: [
            { type: 'tool_use', id: `call-${executed}`, name: 'internal_step', input: { step: executed } },
          ] };
        },
      };
      const providers = new ProviderRegistry();
      providers.registerFactory('mock', () => provider);
      const runner = new AgentRunner({
        session, providers,
        config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model', maxToolLoops: 1 } }),
        tools: [{ name: 'internal_step', description: 'Fixture step', inputSchema: {
          type: 'object', properties: { step: { type: 'integer' } }, required: ['step'],
        },
          async execute() { executed++; return { content: 'INTERNAL_RECEIPT_DIAGNOSTIC' }; } }],
      });
      async function* capture() {
        for await (const event of runner.runStream({ message: '完成任务' })) {
          if (event.type === 'done') terminal = event.result;
          yield event;
        }
      }
      setCurrentLang('zh');
      try {
        const events = [];
        for await (const event of mapCoreAgentEvents(capture(), { failureTrackingScope: {} })) events.push(event);
        const text = outcome === 'partial' || outcome === 'complete' ? '已经保存草稿。' : '';
        const notice = '本轮已达到 1 轮工具执行上限，任务已停止。收尾总结未能完整生成。';
        expect(events.filter(e => e.type === 'final')).toEqual([{ type: 'final',
          text: outcome === 'complete' ? text : [text, notice].filter(Boolean).join('\n\n'),
        }]);
        expect(events.filter(e => e.type === 'error')).toEqual([]);
        expect(executed).toBe(1);
        expect(summaryCalls).toBe(outcome === 'partial' ? 4 : 1);
        expect(terminal?.text).toBe(text);
        expect(terminal?.meta.termination).toEqual({ status: 'stopped', reason: 'tool_loop_limit',
          ...(outcome === 'complete' ? {} : { summaryIncomplete: true, toolRoundLimit: 1 }),
        });
        // Reload the real persisted transcript: only model text and actual
        // receipts survive. UI localization is not a synthetic assistant row.
        const restored = new PersistentSession({ sessionFile: file });
        const saved = fs.readFileSync(file, 'utf8');
        expect(saved).not.toContain(notice);
        expect(saved).not.toContain('Recent successful results:');
        expect(saved).not.toContain('Next step: review');
        expect(saved).toContain('INTERNAL_RECEIPT_DIAGNOSTIC');
        const assistantText = restored.getMessages().filter(m => m.role === 'assistant')
          .flatMap(m => m.content).filter(c => c.type === 'text');
        expect(assistantText).toEqual(text ? [{ type: 'text', text }] : []);
      } finally {
        setCurrentLang('en');
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
