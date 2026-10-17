import * as assert from 'node:assert/strict';

/** Read the explicit reference receipt, rather than accepting matching words
 * elsewhere in history, assignment notes or predecessor results. */
export function quotedSnapshots(text: string): Array<Record<string, unknown>> {
  const opening = '<referenced-messages>';
  const closing = '</referenced-messages>';
  const start = text.indexOf(opening);
  assert.ok(start >= 0, 'Explicit reference block is missing');
  assert.equal(text.indexOf(opening, start + opening.length), -1, 'Reference block is duplicated');
  const end = text.indexOf(closing, start + opening.length);
  assert.ok(end > start, 'Reference block is incomplete');
  const block = text.slice(start + opening.length, end);
  const jsonStart = block.indexOf('[');
  assert.ok(jsonStart >= 0, 'Reference snapshot array is missing');
  const snapshots: unknown = JSON.parse(block.slice(jsonStart));
  assert.ok(Array.isArray(snapshots), 'Reference receipt must be an array');
  assert.ok(snapshots.every((row) => row && typeof row === 'object' && typeof row.text === 'string'),
    'Reference receipt contains an invalid snapshot');
  return snapshots;
}

export function currentTurnSnapshots(text: string): Array<Record<string, unknown>> {
  const start = text.lastIndexOf('<msg from="user"');
  assert.ok(start >= 0, 'Current user envelope is missing');
  const end = text.indexOf('</msg>', start);
  assert.ok(end > start, 'Current user envelope is incomplete');
  return quotedSnapshots(text.slice(start, end));
}

/** Both SDK wire formats used by the deterministic desktop fixture. Taking
 * only the last user message prevents a prior quoted turn from satisfying
 * the current delivery assertion. */
export function lastUserRequestText(request: Record<string, unknown>): string {
  const messages = request.input ?? request.messages;
  assert.ok(Array.isArray(messages), 'Model request message array is missing');
  const message = messages.filter((row) => row?.role === 'user').at(-1);
  assert.ok(message, 'Model request has no user message');
  if (typeof message.content === 'string') return message.content;
  assert.ok(Array.isArray(message.content), 'User message content is missing');
  return message.content.filter((part: any) => part?.type === 'input_text' || part?.type === 'text')
    .map((part: any) => String(part.text ?? '')).join('\n');
}
