import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
const marker = "'conversations.processPage': ";
const handlerSource = source.slice(source.indexOf(marker) + marker.length, source.indexOf("'conversations.history':"))
  .trim().replace(/,$/, '');
function harness(exists = true) {
  const chats = {
    getConversationMetadata: vi.fn(async () => exists ? { project_id: 'actual-owner' } : null),
    getConversationProcessPage: vi.fn(async () => ({ items: [{ type: 'progress', text: 'Visible event' }], nextCursor: 2 })),
  };
  const handler = vm.runInNewContext(`(${handlerSource})`, {
    chats, safeId: (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v),
    conversationProjectHint: (v: any) => v.project_id,
  });
  return { handler, chats };
}
const input = { cid: 'conversation', message_id: 'message', ref: 'a'.repeat(64), cursor: 1, project_id: 'stale-owner' };

describe('conversation process disclosure authority', () => {
  it('resolves the active account and actual conversation owner before reading a page', async () => {
    const { handler, chats } = harness();
    expect(await handler(input, { userId: 'current-account' })).toMatchObject({ next_cursor: 2 });
    expect(chats.getConversationProcessPage).toHaveBeenCalledExactlyOnceWith(
      'current-account', 'conversation', input.ref, 1, 'message', 'actual-owner');
  });
  it.each([{ cid: '../another' }, { ref: '../outside' }, { message_id: '' }, { cursor: -1 }, { cursor: 0.5 }, { cursor: 'bad' }])(
    'rejects an invalid disclosure without reading state (%j)', async invalid => {
      const { handler, chats } = harness();
      await expect(handler({ ...input, ...invalid }, { userId: 'account' })).rejects.toThrow();
      expect(chats.getConversationMetadata).not.toHaveBeenCalled();
      expect(chats.getConversationProcessPage).not.toHaveBeenCalled();
    });
  it('does not serve cached details for an unavailable or deleted conversation', async () => {
    const { handler, chats } = harness(false);
    await expect(handler(input, { userId: 'other-account' })).rejects.toThrow('conversation not found');
    expect(chats.getConversationProcessPage).not.toHaveBeenCalled();
  });
});
