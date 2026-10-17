import { describe, expect, it } from 'vitest';
import { ClaudeStreamDiagnostics } from '../../../../src/main/features/local_agents/backends/claude-stream-diagnostics';

const start = { type: 'stream_event', event: { type: 'message_start' } };
const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'private' } } };

describe('Claude stdout delivery diagnosis', () => {
  it('distinguishes the same text arriving over time from one coalesced read', () => {
    const spaced = new ClaudeStreamDiagnostics(100);
    spaced.beginRead(200); spaced.record(start, 100); spaced.record(delta, 150);
    spaced.beginRead(200); spaced.record(delta, 1150);
    expect(spaced.summary()).toMatchObject({ stdoutReads: 2, partialTextDeltas: 2,
      lastStreamedText: { chars: 14, deltas: 2, reads: 2, spanMs: 1000, maxDeltasPerRead: 1 } });
    const burst = new ClaudeStreamDiagnostics(100);
    burst.beginRead(400); burst.record(start, 100); burst.record(delta, 1150); burst.record(delta, 1150);
    expect(burst.summary()).toMatchObject({ stdoutReads: 1, partialTextDeltas: 2,
      lastStreamedText: { chars: 14, deltas: 2, reads: 1, spanMs: 0, maxDeltasPerRead: 2 } });
  });

  it('keeps the final main reply distinct from earlier prose, child output and full-record fallback', () => {
    const stats = new ClaudeStreamDiagnostics(0);
    stats.beginRead(300); stats.record(start, 10); stats.record(delta, 20); stats.record(delta, 2000);
    stats.record({ ...start, parent_tool_use_id: 'private-child' }, 2500);
    stats.record({ ...delta, parent_tool_use_id: 'private-child' }, 2600);
    stats.record(start, 3000); stats.record(delta, 3100); stats.record(delta, 3101);
    stats.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'private-full' }] } });
    stats.recordFallback(); stats.recordForward(125); stats.recordForward(2);
    expect(stats.summary()).toEqual({ stdoutReads: 1, stdoutChars: 300, partialTextDeltas: 4,
      fullTextRecords: 1, fallbackTextRecords: 1, maxTextForwardMs: 125,
      lastStreamedText: { chars: 14, deltas: 2, reads: 1, firstMs: 3100, lastMs: 3101,
        spanMs: 1, maxDeltasPerRead: 2 } });
    expect(JSON.stringify(stats.summary())).not.toContain('private');
  });

  it('reports absent partials explicitly and stays bounded across long tool conversations', () => {
    const stats = new ClaudeStreamDiagnostics(0);
    expect(stats.summary()).not.toHaveProperty('lastStreamedText');
    for (let i = 0; i < 10_000; i++) {
      stats.beginRead(50); stats.record(start, i * 100); stats.record(delta, i * 100 + 1);
    }
    expect(stats.summary()).toMatchObject({ stdoutReads: 10_000, partialTextDeltas: 10_000,
      lastStreamedText: { chars: 7, deltas: 1, reads: 1, spanMs: 0, maxDeltasPerRead: 1 } });
    expect(JSON.stringify(stats.summary()).length).toBeLessThan(500);
  });
});
