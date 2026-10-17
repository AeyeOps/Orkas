import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/** Native message boundaries place earlier text in the shared process disclosure.
 * These cases protect the single final body, live/canonical reconciliation,
 * chronological recovery and bounded deferred history loading. */

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const VIEW_MODEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-view-model.js'),
  'utf8',
);

class El {
  className = '';
  hidden = false;
  dataset: Record<string, string> = {};
  children: El[] = [];
  parentElement: El | null = null;
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  private attrs: Record<string, string> = {};
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  classList = {
    add: (name: string) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      set.add(name);
      this.className = [...set].join(' ');
    },
    remove: (name: string) => {
      this.className = this.className.split(/\s+/).filter((n) => n && n !== name).join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  };

  appendChild(child: El) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: El, ref: El | null) {
    child.parentElement = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at >= 0) this.children.splice(at, 0, child);
    else this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  get firstChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) {
      fn({ preventDefault() {}, stopPropagation() {} });
    }
  }

  private descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  querySelectorAll(selector: string): El[] {
    const cls = selector.replace(/^\./, '').replace(/\[.*$/, '');
    const segMatch = selector.match(/data-native-seg="([^"]+)"/);
    return this.descendants().filter((el) => {
      if (cls && !el.classList.contains(cls)) return false;
      if (segMatch && el.dataset.nativeSeg !== segMatch[1]) return false;
      return true;
    });
  }

  querySelector(selector: string): El | null {
    if (selector.startsWith('[data-role=')) {
      const role = selector.match(/data-role="([^"]+)"/)?.[1];
      return this.descendants().find((el) => el.getAttribute('data-role') === role) || null;
    }
    if (selector === '.chat-bubble') {
      return this.descendants().find((el) => el.classList.contains('chat-bubble')) || null;
    }
    return this.querySelectorAll(selector)[0] || null;
  }
}

function loadFoldContext() {
  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Map, Set, Array, String, Number, RegExp, Math, Promise, Boolean, Object,
    encodeURIComponent, URLSearchParams,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    requestAnimationFrame: (fn: Function) => { fn(); return 1; },
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml: (s: string) => String(s),
    renderMarkdownFull: (s: string) => String(s),
    t: (key: string) => key,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => new El(),
    },
    window: { addEventListener() {}, uiIconHtml: () => '', ConversationRuntime: {} },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(VIEW_MODEL_SOURCE, context);
  vm.runInContext(SOURCE, context);

  return context;
}

function rowWithProcess() {
  const row = new El();
  row.dataset.turnId = 'T-process';
  const bubble = new El();
  bubble.className = 'chat-bubble';
  row.appendChild(bubble);
  const details = new El();
  details.className = 'stream-process';
  const process = new El();
  process.className = 'stream-process-body';
  process.setAttribute('data-role', 'process');
  details.appendChild(process);
  bubble.appendChild(details);
  const final = new El();
  final.setAttribute('data-role', 'final');
  final.textContent = 'Final answer';
  bubble.appendChild(final);
  return { row, bubble, process, final };
}

const commentary = (text: string) => ({
  type: 'progress', text, event: { stream: 'assistant', data: { phase: 'commentary' } },
});

describe('native narration in the shared process disclosure', () => {
  it('uses stored commentary without classifying or duplicating raw source text', () => {
    const ctx = loadFoldContext();
    ctx._groupActorLabel = () => 'Claude';
    const process = [commentary('Stored process text')];
    const record = { id: 'classified', from: 'claude', seg: 0, text: 'Raw source text',
      display_phase: 'commentary', process };
    const merged = ctx._mergeSegmentGroup([record,
      { id: 'answer', seg: 1, text: 'Answer', display_phase: 'final_answer', process: [] }]).merged;
    expect(merged.process).toEqual(process);
    expect(ctx._groupMsgToLegacy(record).content).toBe('');
    expect(ctx._groupMsgToLegacy(record).display_phase).toBe('commentary');
    const part = { ref: 'stored-process', message_id: record.id };
    expect(ctx._processPartsForRecord({ ...record, process_parts: [part] }, true)).toEqual([part]);
  });

  it.each([1, 3, 19, 61])('keeps all %s earlier messages inside process information with no exposed tail', count => {
    const ctx = loadFoldContext();
    const { row, bubble, process, final } = rowWithProcess();
    for (let i = 0; i < count; i++) ctx._appendNarrationBlock(row, i, `Progress ${i}`);
    expect(process.children.map(child => child.dataset.processText))
      .toEqual(Array.from({ length: count }, (_, i) => `Progress ${i}`));
    expect(bubble.children.map(child => child.className)).toEqual(['stream-process', '']);
    expect(bubble.querySelectorAll('.chat-turn-narration-toggle')).toHaveLength(0);
    expect(final.textContent).toBe('Final answer');
  });

  it('replaces a provisional segment with its canonical text without duplicating the process entry', () => {
    const ctx = loadFoldContext();
    const { row, process } = rowWithProcess();
    ctx._appendNarrationBlock(row, 0, 'Partial');
    ctx._appendNarrationBlock(row, 0, 'Complete', { canonical: true });
    ctx._appendNarrationBlock(row, 0, 'Complete', { canonical: true });
    expect(process.children.map(child => child.dataset.processText)).toEqual(['Complete']);
    ctx._appendNarrationBlock(row, 0, '', { canonical: true });
    expect(process.children).toHaveLength(0);
  });

  it('moves each previous body before its tool activity while the next body remains independent', () => {
    const ctx = loadFoldContext();
    const { row, process } = rowWithProcess();
    const tool = new El(); tool.textContent = 'Read files'; process.appendChild(tool);
    row.dataset.streamBuf = 'Inspecting';
    ctx._demoteBodyToNarration(row, 0);
    const nextTool = new El(); nextTool.textContent = 'Run tests'; process.appendChild(nextTool);
    row.dataset.streamBuf = 'Verifying';
    ctx._demoteBodyToNarration(row, 1);
    expect(process.children.filter(child => !child.hidden).map(child => child.dataset.processText || child.textContent))
      .toEqual(['Inspecting', 'Read files', 'Verifying', 'Run tests']);
  });

  it('projects recovered segments into chronological process items and keeps only the last body', () => {
    const ctx = loadFoldContext();
    const tool = { type: 'progress', text: 'Read files' };
    const records = [
      { id: 'one', seg: 0, text: 'Inspecting', process: [tool] },
      { id: 'two', seg: 1, text: 'Verifying', process: [] },
      { id: 'three', seg: 2, text: 'Final answer', process: [] },
    ];
    const merged = ctx._mergeSegmentGroup(records).merged;
    expect(merged.text).toBe('Final answer');
    expect(merged.process).toEqual([commentary('Inspecting'), tool, commentary('Verifying')]);
    expect(records[0].process).toEqual([tool]);
  });

  it('keeps earlier commentary with its deferred process part without fetching that history', () => {
    const ctx = loadFoldContext();
    const part = { ref: 'fixture-ref', message_id: 'one' };
    const merged = ctx._mergeSegmentGroup([
      { id: 'one', seg: 0, text: 'Inspecting', process_parts: [part] },
      { id: 'two', seg: 1, text: 'Final answer', process: [] },
    ]).merged;
    expect(merged.process_parts[0]).toEqual({ ...part, leading_items: [commentary('Inspecting')] });
    expect(part).not.toHaveProperty('leading_items');
  });
});
