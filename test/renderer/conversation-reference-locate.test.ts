import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Scenario: a sent message quotes an earlier message ("Quoted from @Agent:").
// Clicking that quote must take the user to the original message: revealed in
// place when it is still mounted, loaded around its id when it scrolled out of
// the paged transcript, opened in its source task for a cross-task quote, and
// reported as missing (never silently landing at the bottom) when the original
// is gone. Legacy quotes without a stored identity remain static text.

const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}(`;
  const syncMarker = `function ${name}(`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const signatureEnd = source.indexOf(') {', start);
  const braceStart = signatureEnd >= 0 ? signatureEnd + 2 : -1;
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const t = (key: string, values: Record<string, string> = {}) => {
  if (key === 'chat.quote_from') return `Quoted from @${values.name}:`;
  if (key === 'chat.reference_locate_title') return 'Go to the original message';
  if (key === 'chat.reference_locate_missing') return 'The original message no longer exists.';
  return key;
};

function renderHarness() {
  const context: any = {
    String,
    Array,
    Math,
    escapeHtml: (value: unknown) => String(value),
    _chatFileIconHtml: () => '',
    _referenceDisplayName: (ref: any) => ref.from_name || 'Unknown',
    _conversationTitleForCid: (cid: string) => `Title for ${cid}`,
    t,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(conversationSource, '_quotePreviewAttribution'),
    extractFunction(conversationSource, '_renderMessageReferencesHtml'),
  ].join('\n'), context);
  return context;
}

type FakeMessage = {
  dataset: Record<string, string>;
  classList: { add: (n: string) => void; remove: (n: string) => void; contains: () => boolean };
  closest: () => any;
  getBoundingClientRect: () => { top: number; height: number };
};

function locateHarness(opts: { currentCid?: string; mounted?: string[] } = {}) {
  const flashes: string[] = [];
  const messages: FakeMessage[] = [];
  const container: any = {
    scrollTop: 0,
    clientHeight: 400,
    style: { scrollBehavior: '' },
    getBoundingClientRect: () => ({ top: 0, height: 400 }),
    querySelectorAll: () => messages,
  };
  const mount = (msgId: string) => {
    messages.push({
      dataset: { msgId },
      classList: {
        contains: () => true,
        add: (name: string) => flashes.push(`${msgId}:${name}`),
        remove: () => {},
      },
      closest: () => container,
      getBoundingClientRect: () => ({ top: 100, height: 50 }),
    });
  };
  for (const id of opts.mounted || []) mount(id);
  const context: any = {
    String,
    Number,
    Math,
    Array,
    currentCid: opts.currentCid || 'task-a',
    document: { getElementById: (id: string) => (id === 'chat-history' ? container : null) },
    t,
    uiToast: vi.fn(),
    setView: vi.fn(),
    loadConversationHistory: vi.fn(async () => {}),
    _msTs: () => 0,
    _markProgrammaticStickyScroll: () => {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    setTimeout: () => 1,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(conversationSource, '_findConversationHistorySearchTarget'),
    extractFunction(conversationSource, '_flashConversationHistorySearchTarget'),
    extractFunction(conversationSource, '_revealConversationHistorySearchTarget'),
    extractFunction(conversationSource, '_showReferenceMissingToast'),
    extractFunction(conversationSource, '_locateReferencedMessage'),
  ].join('\n'), context);
  return { context, container, flashes, mount };
}

describe('locating the original message behind a quoted reference', () => {
  it('renders a quote as a locatable row only when its source identity survived', () => {
    const context = renderHarness();
    const html = context._renderMessageReferencesHtml([
      { source_cid: 'task-a', source_msg_id: 'm1', from_name: 'Writer', text: 'Keep this' },
      { from_name: 'Legacy', text: 'Old quote without identity' },
    ], 'task-a');
    expect(html).toContain('<button type="button" class="chat-reference-message is-locatable" data-source-cid="task-a" data-source-msg-id="m1" title="Go to the original message">');
    expect(html).toContain('<div class="chat-reference-message"><span class="chat-reference-author">Quoted from @Legacy:</span>');
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain('Keep this');
    expect(html).toContain('Old quote without identity');
    expect(styleSource).toContain('.chat-reference-message.is-locatable {');
  });

  it('reveals a mounted same-task original in place without reloading history', async () => {
    const h = locateHarness({ mounted: ['m0', 'm1'] });
    await expect(h.context._locateReferencedMessage({ source_cid: 'task-a', source_msg_id: 'm1' }))
      .resolves.toBe(true);
    expect(h.flashes).toEqual(['m1:search-flash']);
    expect(h.context.loadConversationHistory).not.toHaveBeenCalled();
    expect(h.context.setView).not.toHaveBeenCalled();
    expect(h.context.uiToast).not.toHaveBeenCalled();
  });

  it('loads the page around an original that scrolled out of the transcript and flashes it', async () => {
    const h = locateHarness({ mounted: ['m40'] });
    h.context.loadConversationHistory = vi.fn(async (cid: string, opts: any) => {
      expect(cid).toBe('task-a');
      expect(opts.searchTarget.msgId).toBe('m1');
      expect(opts.searchTarget).not.toHaveProperty('msgIndex');
      h.mount('m1');
      // The real loader reveals the target after the anchored page paints.
      h.context._revealConversationHistorySearchTarget(cid, opts.searchTarget);
    });
    await expect(h.context._locateReferencedMessage({ source_cid: 'task-a', source_msg_id: 'm1' }))
      .resolves.toBe(true);
    expect(h.context.loadConversationHistory).toHaveBeenCalledOnce();
    expect(h.flashes).toEqual(['m1:search-flash']);
    expect(h.context.uiToast).not.toHaveBeenCalled();
    expect(h.context.setView).not.toHaveBeenCalled();
  });

  it('tells the user when the original no longer exists instead of silently landing at the bottom', async () => {
    const h = locateHarness({ mounted: ['m40'] });
    h.context.loadConversationHistory = vi.fn(async (cid: string, opts: any) => {
      // Main fell back to the latest page: the id is not in the transcript.
      h.context._revealConversationHistorySearchTarget(cid, opts.searchTarget);
    });
    await expect(h.context._locateReferencedMessage({ source_cid: 'task-a', source_msg_id: 'gone' }))
      .resolves.toBe(false);
    expect(h.flashes).toEqual([]);
    expect(h.context.uiToast).toHaveBeenCalledExactlyOnceWith(
      'The original message no longer exists.', { variant: 'warning' },
    );
    expect(h.context.setView).not.toHaveBeenCalled();
  });

  it('opens the source task positioned on the original for a cross-task quote', async () => {
    const h = locateHarness({ mounted: ['m1'] });
    await expect(h.context._locateReferencedMessage({ source_cid: 'task-b', source_msg_id: 'm9' }))
      .resolves.toBe(true);
    expect(h.context.setView).toHaveBeenCalledOnce();
    const [view, cid, opts] = h.context.setView.mock.calls[0];
    expect(view).toBe('conversation');
    expect(cid).toBe('task-b');
    expect(opts.historyTarget.msgId).toBe('m9');
    expect(typeof opts.historyTarget.onMiss).toBe('function');
    expect(h.context.loadConversationHistory).not.toHaveBeenCalled();
    expect(h.flashes).toEqual([]);
    expect(h.context.uiToast).not.toHaveBeenCalled();
  });

  it('reports a legacy quote that carries no source identity without navigating', async () => {
    const h = locateHarness({ mounted: ['m1'] });
    await expect(h.context._locateReferencedMessage({ text: 'legacy' })).resolves.toBe(false);
    expect(h.context.uiToast).toHaveBeenCalledOnce();
    expect(h.context.setView).not.toHaveBeenCalled();
    expect(h.context.loadConversationHistory).not.toHaveBeenCalled();
  });

  it('reports a miss only after the mounted transcript was actually searched', () => {
    const h = locateHarness({ mounted: ['m1'] });
    const onMiss = vi.fn();
    expect(h.context._revealConversationHistorySearchTarget('task-other', { msgId: 'm1', onMiss })).toBe(false);
    expect(onMiss).not.toHaveBeenCalled();
    expect(h.context._revealConversationHistorySearchTarget('task-a', { msgId: 'm1', onMiss })).toBe(true);
    expect(onMiss).not.toHaveBeenCalled();
    expect(h.context._revealConversationHistorySearchTarget('task-a', { msgId: 'm2', onMiss })).toBe(false);
    expect(onMiss).toHaveBeenCalledOnce();
  });

  it('binds each locatable row once and keeps the click off bubble selection', () => {
    const rows: any[] = [
      { dataset: { sourceCid: 'task-a', sourceMsgId: 'm1' }, handlers: [] as any[], addEventListener(_: string, fn: any) { this.handlers.push(fn); } },
    ];
    const msgDiv = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('.chat-reference-message.is-locatable[data-source-cid][data-source-msg-id]');
        return rows;
      },
    };
    const context: any = { _locateReferencedMessage: vi.fn(async () => true) };
    vm.createContext(context);
    vm.runInContext(extractFunction(conversationSource, '_hydrateMessageReferenceLocators'), context);
    context._hydrateMessageReferenceLocators(msgDiv);
    context._hydrateMessageReferenceLocators(msgDiv);
    expect(rows[0].handlers).toHaveLength(1);
    const event = { stopPropagation: vi.fn() };
    rows[0].handlers[0](event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(context._locateReferencedMessage).toHaveBeenCalledExactlyOnceWith({
      source_cid: 'task-a', source_msg_id: 'm1',
    });
    expect(conversationSource).toContain('_hydrateMessageReferenceLocators(msgDiv);');
  });

  it('requests the page around a message id without inventing a source index', () => {
    const context: any = {
      Math,
      Number,
      encodeURIComponent,
      HISTORY_PAGE_SIZE: 10,
      _projectIdForConversation: () => 'p1',
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(conversationSource, '_historyRequestUrl'), context);
    expect(context._historyRequestUrl('c1', null, 10, Number(undefined), 'm1')).toBe(
      '/api/conversations/c1/history?limit=10&around_message_id=m1&project_id=p1',
    );
  });
});
