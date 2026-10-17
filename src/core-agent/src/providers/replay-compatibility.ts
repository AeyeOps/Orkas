import { createHash } from 'node:crypto';
import type { Message, MessageContent } from '../shared/types.js';

type Origin = NonNullable<MessageContent['replayOrigin']>;
type Target = { api: string; provider: string; id: string; baseUrl?: string; headers?: Record<string, string>; compat?: unknown };

/** The configured DeepSeek adapter uses Chat Completions. Do not infer this
 * requirement from model aliases or thinkingFormat (also used by Moonshot). */
export function needsDeepSeekToolReasoning(model: Target & { reasoning?: boolean }): boolean {
  if (model.api !== 'openai-completions' || model.reasoning !== true) return false;
  if (model.provider === 'deepseek') return true;
  try { return new URL(model.baseUrl ?? '').hostname === 'api.deepseek.com'; }
  catch { return false; }
}

/** pi-ai supplies an empty Chat reasoning_content after foreign private state
 * is omitted. Use the accepted nonempty placeholder only on tool-call messages;
 * preserve real reasoning, explicit off, and the immutable session history.
 * This restores wire compatibility, not the missing private reasoning. */
export function projectDeepSeekToolReasoning(payload: unknown, model: Target & { reasoning?: boolean }): unknown {
  if (!needsDeepSeekToolReasoning(model) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const body = payload as { thinking?: { type?: string }; reasoning_effort?: string; messages?: unknown };
  if (body.thinking?.type === 'disabled' || body.reasoning_effort === 'none' || body.reasoning_effort === 'off'
    || !Array.isArray(body.messages)) return payload;
  let changed = false;
  const messages = body.messages.map(message => {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length
      || typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) return message;
    changed = true;
    // pi-ai may replay portable plaintext under the source Chat field name.
    const portable = [message.reasoning, message.reasoning_text]
      .find(value => typeof value === 'string' && value.length > 0);
    return { ...message, reasoning_content: portable ?? '.' };
  });
  return changed ? { ...body, messages } : payload;
}

/** Fingerprint routing/credentials without persisting their values. This is
 * compatibility metadata, not a signature, cryptographic key or permission. */
export function replayOrigin(model: Target, apiKey?: string, headers?: Record<string, string>): Origin {
  return { version: 1, source: { api: model.api, provider: model.provider, model: model.id }, scope: createHash('sha256').update(JSON.stringify([
    model.api, model.provider, model.id, model.baseUrl ?? '', apiKey ?? '', model.compat ?? null,
    Object.entries({ ...model.headers, ...headers }).map(([k, v]) => [k.toLowerCase(), v])
      .filter(([name]) => name !== 'x-request-id').sort(),
  ])).digest('hex') };
}

export function compatibleReplay(content: MessageContent, target: Origin): boolean {
  return content.replayOrigin?.version === 1 && content.replayOrigin.scope === target.scope;
}

function portableChatThinking(content: MessageContent, model: Target): boolean {
  return content.type === 'thinking' && model.api === 'openai-completions' && !content.redacted
    && !!content.thinking && ['reasoning_content', 'reasoning', 'reasoning_text'].includes(content.thinkingSignature ?? '');
}

/** A truncated tool batch may keep independently replayable plaintext, never
 * opaque state that could refer to its discarded proposals. Responses JSON
 * comes from the SDK's completed item event; do not synthesize it from deltas. */
export function isPortableThinkingForRecovery(content: MessageContent): boolean {
  if (content.type !== 'thinking' || content.redacted || content.googleNativeReplay) return false;
  const signature = content.thinkingSignature;
  if (['reasoning_content', 'reasoning', 'reasoning_text'].includes(signature ?? '')) return !!content.thinking.trim();
  try {
    const item = JSON.parse(signature ?? '');
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'reasoning') return false;
    // Fail closed for encrypted state and unknown provider extensions. Retain
    // the original item and origin unchanged; ordinary projection owns scope.
    if (Object.keys(item).some(key => !['type', 'id', 'status', 'summary', 'content', 'encrypted_content', '_orkas_replay'].includes(key))) return false;
    if (item.encrypted_content != null && item.encrypted_content !== '') return false;
    if (item.id !== undefined && typeof item.id !== 'string') return false;
    if (item._orkas_replay !== undefined && typeof item._orkas_replay !== 'string') return false;
    if (item.status !== undefined && item.status !== 'completed') return false;
    if (item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.length)) return false;
    return Array.isArray(item.content) && item.content.length > 0
      && item.content.every((part: unknown) => !!part && typeof part === 'object'
        && !Array.isArray(part) && Object.keys(part).every(key => key === 'type' || key === 'text')
        && (part as { type?: unknown }).type === 'reasoning_text'
        && typeof (part as { text?: unknown }).text === 'string')
      && item.content.some((part: { text: string }) => part.text.trim().length > 0);
  } catch { return false; }
}

/** pi-ai owns ordinary cross-model conversion. Only merged source blocks and
 * the legacy plaintext Chat contract need per-block projection: pi-ai's source
 * identity is message-wide and would otherwise discard valid sibling state. */
export function replayMessageSource(content: MessageContent[], model: Target, target: Origin) {
  const scoped = content.filter(c => c.replayOrigin || c.type === 'thinking' || c.type === 'tool_use'
    || c.type === 'text' && c.textSignature || c.googleNativeReplay);
  const first = scoped[0]?.replayOrigin;
  const projectBlocks = scoped.some(c => c.replayOrigin?.scope !== first?.scope)
    || scoped.some(c => !compatibleReplay(c, target) && portableChatThinking(c, model));
  const current = { api: model.api, provider: model.provider, model: model.id };
  if (projectBlocks) return { source: current, projectBlocks };
  const same = first?.version === 1 && first.scope === target.scope;
  const persisted = first?.version === 1 ? first.source : undefined;
  const known = persisted && [persisted.api, persisted.provider, persisted.model]
    .every(value => typeof value === 'string' && value.length > 0);
  const source = known ? persisted : (same ? current : { ...current, provider: 'orkas-replay-unknown', model: '' });
  // pi-ai cannot distinguish endpoints/accounts with identical model names.
  // Mark only that transport mismatch foreign; preserve known model identities.
  return { source: !same && source.api === model.api && source.provider === model.provider && source.model === model.id
    ? { ...source, provider: 'orkas-replay-incompatible' } : source, projectBlocks };
}

/** Mixed messages retain the target identity to preserve signed siblings, so
 * pi-ai skips its cross-source ID conversion. Repair only foreign Anthropic
 * IDs that violate its wire grammar; reserve all existing IDs against aliases.
 * This map is request-local and is shared by calls and receipts. */
export function mixedReplayToolIds(messages: Message[], model: Target, target: Origin): Map<string, string> {
  const mapped = new Map<string, string>();
  if (model.api !== 'anthropic-messages') return mapped;
  const reserved = new Set(messages.flatMap(m => m.content.flatMap(c =>
    c.type === 'tool_use' ? [String(c.id || '').trim()] : [])));
  // Single-source siblings still pass through pi-ai's Anthropic normalization.
  for (const id of [...reserved]) reserved.add(id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64));
  for (const message of messages) {
    if (message.role !== 'assistant' || !replayMessageSource(message.content, model, target).projectBlocks) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || compatibleReplay(block, target)) continue;
      const id = String(block.id || '').trim();
      if (!id || mapped.has(id) || /^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;
      let attempt = 0;
      let candidate: string;
      do {
        candidate = 'ork_' + createHash('sha256').update(JSON.stringify([id, attempt++])).digest('hex').slice(0, 60);
      } while (reserved.has(candidate));
      mapped.set(id, candidate);
      reserved.add(candidate);
    }
  }
  return mapped;
}

/** Project only private protocol state; canonical history stays untouched.
 * Legacy plaintext Chat reasoning fields are portable, unlike opaque blobs. */
export function projectReplay(content: MessageContent, model: Target, target: Origin, projectBlocks = false): MessageContent | undefined {
  const same = compatibleReplay(content, target);
  if (content.type === 'thinking') {
    if (!same) {
      if (portableChatThinking(content, model)) {
        return { type: 'thinking', thinking: content.thinking, thinkingSignature: content.thinkingSignature };
      }
      return undefined;
    }
    if (['openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(model.api)) {
      try {
        const item = JSON.parse(content.thinkingSignature ?? '');
        if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'reasoning') return undefined;
        // Direct Responses endpoints reject private relay metadata.
        const { status: _status, ...input } = item;
        delete input._orkas_replay;
        return { ...content, thinkingSignature: JSON.stringify(input) };
      } catch { return undefined; }
    }
    return content;
  }
  // For ordinary single-source messages pi-ai removes foreign text/tool
  // signatures. Do not maintain a second generic conversion implementation.
  if (same || !projectBlocks) return content;
  if (content.type === 'text') {
    const { textSignature: _signature, googleNativeReplay: _replay, ...rest } = content;
    return rest;
  }
  if (content.type === 'tool_use') {
    const { thoughtSignature: _signature, googleNativeReplay: _replay, ...rest } = content;
    return rest;
  }
  return content;
}

/** pi-ai 0.87.1 normalizes call/result ids, but may synthesize fc_* item ids
 * for foreign custom calls. Remove only provider-owned item identity after its
 * converter has paired receipts; never rewrite call_id or canonical history. */
export function projectResponsesItemIds(payload: unknown, foreignCalls: boolean[]): unknown {
  if (!foreignCalls.some(Boolean) || !payload || typeof payload !== 'object') return payload;
  const body = payload as { input?: unknown };
  if (!Array.isArray(body.input)) return payload;
  let callIndex = 0;
  return { ...body, input: body.input.map(item => {
    if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) return item;
    if (!foreignCalls[callIndex++]) return item;
    const { id: _id, namespace: _namespace, ...portable } = item;
    return portable;
  }) };
}
