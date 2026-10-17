import type { AssistantMessage } from '@earendil-works/pi-ai/compat';

type Item = Record<string, unknown>;
type ObservedItem = { id: string; type: string; index: number; done: boolean };
const blockType: Record<string, string> = {
  reasoning: 'thinking', message: 'text', function_call: 'toolCall', custom_tool_call: 'toolCall',
};
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Item : undefined;
const textParts = (value: unknown, type: string) => Array.isArray(value)
  && value.every(part => { const item = object(part); return item?.type === type && typeof item.text === 'string'; });

/** pi-ai 0.99.1 only saves reasoning on output_item.done. Observe its native
 * event hook, then annotate missing signatures at our existing result boundary.
 * The SDK still owns parsing, terminal validation, cancellation and tool calls.
 * Never mutate events, replace existing signatures, or synthesize protocol events.
 * The ordered item/block correspondence is covered by real-SDK regression cases
 * and the adapter's MIRRORED_PI_AI_SERIALIZER_VERSION dependency gate. */
export function createResponsesTerminalReasoning(api: string, signal?: AbortSignal) {
  if (!['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api)) return undefined;
  const slots = new Map<number, ObservedItem>();
  const ids = new Set<string>();
  const ordered: ObservedItem[] = [];
  let responseId: string | undefined;
  let terminal: Item | undefined;
  let invalid = false;
  const invalidate = () => { invalid = true; slots.clear(); ids.clear(); ordered.length = 0; terminal = undefined; };
  return {
    observe(data: unknown) {
      if (invalid || signal?.aborted) return;
      const event = object(data);
      if (!event) return;
      if (event.type === 'response.created') {
        const id = object(event.response)?.id;
        if (responseId || terminal || typeof id !== 'string' || !id) return invalidate();
        responseId = id;
      } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        if (terminal) return invalidate();
        const item = object(event.item);
        if (!item || typeof item.type !== 'string' || !Object.hasOwn(blockType, item.type)) return;
        const index = event.output_index;
        if (!Number.isSafeInteger(index) || (index as number) < 0 || typeof item.id !== 'string' || !item.id) return invalidate();
        const previous = slots.get(index as number);
        const done = event.type === 'response.output_item.done';
        if (previous) {
          if (!done || previous.done || previous.id !== item.id || previous.type !== item.type) return invalidate();
          previous.done = true;
        } else {
          // Bound request-local bookkeeping; ambiguous/reused ids never recover.
          if (ordered.length >= 1024 || ids.has(item.id)) return invalidate();
          const row = { id: item.id, type: item.type, index: index as number, done };
          slots.set(row.index, row); ids.add(row.id); ordered.push(row);
        }
      } else if (event.type === 'response.completed') {
        const response = object(event.response);
        if (terminal || response?.status !== 'completed' || response.error || response.incomplete_details
          || typeof response.id !== 'string' || (responseId && response.id !== responseId)
          || !Array.isArray(response.output) || response.output.length > 1024) return invalidate();
        terminal = response;
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        invalidate();
      }
    },
    apply(message: AssistantMessage): AssistantMessage['content'] {
      if (invalid || signal?.aborted || !terminal || message.rawStopReason !== 'completed'
        || !['stop', 'toolUse'].includes(message.stopReason) || message.responseId !== terminal.id
        || message.content.length !== ordered.length) return message.content;
      // Verify the entire correspondence before filling anything. Unknown SDK
      // block creation, duplicate events or mismatched identities fail closed.
      if (ordered.some((row, i) => message.content[i]?.type !== blockType[row.type])) return message.content;
      const output = terminal.output as unknown[];
      const terminalIds = new Set<string>();
      for (const value of output) {
        const item = object(value);
        if (!item || typeof item.id !== 'string' || terminalIds.has(item.id)) return message.content;
        terminalIds.add(item.id);
      }
      return message.content.map((block, i) => {
        const row = ordered[i];
        if (block.type !== 'thinking' || block.thinkingSignature || row.done) return block;
        const item = object(output[row.index]);
        if (item?.type !== 'reasoning' || item.id !== row.id
          || (item.status !== undefined && item.status !== 'completed')
          || !textParts(item.summary, 'summary_text')
          || (item.content !== undefined && !textParts(item.content, 'reasoning_text'))
          || (item.encrypted_content != null && typeof item.encrypted_content !== 'string')) return block;
        // Both native plaintext and opaque reasoning keep their exact original
        // item, including managed replay provenance. Ordinary replay projection
        // remains responsible for source compatibility and output-only fields.
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const content = Array.isArray(item.content) ? item.content : [];
        const text = (parts: unknown[]) => parts.map(p => object(p)?.text).filter(t => typeof t === 'string').join('\n\n');
        return { ...block, thinking: text(summary) || text(content) || block.thinking,
          thinkingSignature: JSON.stringify(item) };
      });
    },
  };
}
