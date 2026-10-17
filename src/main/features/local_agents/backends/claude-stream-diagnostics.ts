/** Constant-space, content-free measurements at the stdout reader boundary.
 * Read callbacks can themselves be delayed by the main event loop; a burst
 * here does not establish that the provider or CLI buffered the response. */
export class ClaudeStreamDiagnostics {
  private reads = 0;
  private chars = 0;
  private partials = 0;
  private fullTextRecords = 0;
  private fallbackTextRecords = 0;
  private maxForwardMs = 0;
  private message = 0;
  private textMessage = -1;
  private lastRead = -1;
  private deltasInRead = 0;
  private lastText: {
    chars: number; deltas: number; reads: number;
    firstMs: number; lastMs: number; maxDeltasPerRead: number;
  } | undefined;

  constructor(private readonly startedAt = performance.now()) {}

  beginRead(chars: number): void {
    this.reads++;
    this.chars += chars;
  }

  record(obj: any, now = performance.now()): void {
    if (obj?.parent_tool_use_id) return;
    if (obj?.type === 'assistant') {
      if (Array.isArray(obj.message?.content)
          && obj.message.content.some((part: any) => part?.type === 'text' && typeof part.text === 'string')) {
        this.fullTextRecords++;
      }
      return;
    }
    if (obj?.type !== 'stream_event') return;
    if (obj.event?.type === 'message_start') { this.message++; return; }
    const delta = obj.event?.delta;
    if (obj.event?.type !== 'content_block_delta' || delta?.type !== 'text_delta'
        || typeof delta.text !== 'string' || !delta.text.length) return;
    if (this.textMessage !== this.message) {
      this.textMessage = this.message;
      this.lastRead = -1;
      this.lastText = { chars: 0, deltas: 0, reads: 0,
        firstMs: now - this.startedAt, lastMs: now - this.startedAt, maxDeltasPerRead: 0 };
    }
    if (this.lastRead !== this.reads) {
      this.lastRead = this.reads;
      this.deltasInRead = 0;
      this.lastText!.reads++;
    }
    this.partials++;
    this.lastText!.chars += delta.text.length;
    this.lastText!.deltas++;
    this.lastText!.lastMs = now - this.startedAt;
    this.lastText!.maxDeltasPerRead = Math.max(this.lastText!.maxDeltasPerRead, ++this.deltasInRead);
  }

  recordFallback(): void { this.fallbackTextRecords++; }
  recordForward(durationMs: number): void { this.maxForwardMs = Math.max(this.maxForwardMs, durationMs); }

  summary(): Record<string, unknown> {
    return { stdoutReads: this.reads, stdoutChars: this.chars, partialTextDeltas: this.partials,
      fullTextRecords: this.fullTextRecords, fallbackTextRecords: this.fallbackTextRecords,
      maxTextForwardMs: Math.round(this.maxForwardMs * 100) / 100,
      ...(this.lastText ? { lastStreamedText: { ...this.lastText,
        spanMs: this.lastText.lastMs - this.lastText.firstMs } } : {}) };
  }
}
