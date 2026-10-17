// Commander home (modules/home.js): which state the New task view shows, how
// open to-dos and unopened finished runs are grouped, folded and opened, and
// the shortcuts and connect chooser. jsdom isn't installed, so — like the other
// renderer tests — the classic script runs in a vm sandbox with a minimal DOM
// shim and the real zh copy, and assertions read the generated HTML.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const R = path.join(__dirname, '../../src/renderer');
const homeSource = fs.readFileSync(path.join(R, 'modules/home.js'), 'utf8');
const iconsContext: any = { window: {}, document: undefined };
vm.createContext(iconsContext);
vm.runInContext(fs.readFileSync(path.join(R, 'modules/icons.js'), 'utf8'), iconsContext);
const uiIconHtml = iconsContext.window.uiIconHtml;
const zh = JSON.parse(fs.readFileSync(path.join(R, 'locales/zh.json'), 'utf8')) as Record<string, string>;

function t(key: string, vars?: Record<string, unknown>): string {
  let s = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] || c));
}

function element(extra: Record<string, any> = {}) {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  const attrs: Record<string, string> = {};
  return {
    dataset: {} as Record<string, string>,
    hidden: false,
    innerHTML: '',
    textContent: '',
    focusCount: 0,
    addEventListener(type: string, fn: (event: any) => unknown) { (listeners[type] ||= []).push(fn); },
    setAttribute(name: string, value: unknown) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    focus() { this.focusCount += 1; },
    getBoundingClientRect: () => ({ left: 100, top: 600, bottom: 628 }),
    fire(type: string, event: any) { return (listeners[type] || []).map((fn) => fn(event)); },
    ...extra,
  };
}

/** An event whose target answers `closest()` for the given selectors. */
function click(matches: Record<string, any>) {
  return { target: { closest: (selector: string) => matches[selector] || null } };
}

const MINUTE = 60 * 1000;

function loadHome(options: {
  todos?: { tasks: any[]; total: number };
  todosError?: boolean;
  unread?: any[];
  conversations?: any[];
  lookup?: (cids: string[]) => any;
  connectors?: any[];
} = {}) {
  const els: Record<string, any> = {
    'panel-new-chat': element({ dataset: { homeState: 'pending' } }),
    'home-groups': element(),
    'home-explore-context': element(),
  };
  const clicks: Array<[string, any]> = [];
  const events: Array<[string, any]> = [];
  const views: any[][] = [];
  const invokes: Array<[string, any]> = [];
  const forgotten: string[] = [];
  const menus: any[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const context: any = {
    console,
    Promise,
    Date,
    Intl,
    currentView: 'new-chat',
    conversations: options.conversations || [],
    _projectsCache: [{ project_id: 'p1', name: '增长' }],
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t,
    getLang: () => 'zh',
    getLocaleMeta: () => ({ intlLocale: 'zh-CN' }),
    performance: { now: () => 0 },
    setView: (...args: any[]) => { views.push(args); },
    _forgetUnreadConversation: (cid: string) => { forgotten.push(cid); },
    loadRendererFeature: vi.fn(async () => {}),
    focusTodo: vi.fn(),
    showContextMenu: (_anchor: any, items: any[]) => { menus.push(items); },
    Monitor: {
      click: (action: string, data: any) => { clicks.push([action, data]); },
      event: (action: string, data: any) => { events.push([action, data]); },
    },
    document: { getElementById: (id: string) => els[id] || null },
  };
  context.window = {
    uiIconHtml,
    innerHeight: 720,
    Monitor: true,
    addEventListener() {},
    TaskUnread: { list: () => options.unread || [] },
    loadConnectorNavTarget: async (id: string) => ({ name: { feishu: '飞书', dingtalk: '钉钉', gmail: 'Gmail', 'm365-mail': 'Microsoft 365 邮箱' }[id] || id }),
    openConnectorSetupById: vi.fn(async () => true),
    orkas: {
      invoke: async (channel: string, payload: any) => {
        invokes.push([channel, payload]);
        if (channel === 'projects.tasks.listOpen') {
          if (options.todosError) throw new Error('read failed');
          return { ok: true, ...(options.todos || { tasks: [], total: 0 }) };
        }
        if (channel === 'conversations.getMany') {
          return options.lookup ? options.lookup(payload.cids) : { conversations: [], missing: [] };
        }
        if (channel === 'connectors.list') return { ok: true, instances: options.connectors || [] };
        throw new Error(`unexpected channel ${channel}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(homeSource, context);
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    context, els, clicks, events, views, invokes, forgotten, menus, timers, settle,
    state: () => els['panel-new-chat'].dataset.homeState,
    html: () => els['home-groups'].innerHTML as string,
    data: () => JSON.parse(vm.runInContext('JSON.stringify(_homeData)', context)),
  };
}

function run(cid: string, status: string, minutesAgo: number, entryPoint?: string) {
  return {
    cid, projectId: '', finishedAt: Date.now() - minutesAgo * MINUTE, status,
    ...(entryPoint ? { entryPoint } : {}),
  };
}

describe('Commander home states', () => {
  it('shows the empty state when nothing is open or unopened', async () => {
    const h = loadHome();
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('empty');
    expect(h.html()).toBe('');
    // The context line carries the connect chooser inside the translated sentence.
    expect(h.els['home-explore-context'].innerHTML).toBe(
      '用 ＋ 分享资料，或<button type="button" class="home-connect-link" data-home-connect="1">连接飞书 / 钉钉 / 邮箱</button>，补充背景，让 Orkas 更了解你。从你愿意分享的内容开始。',
    );
  });

  it('groups open to-dos, automation runs and other finished tasks in that order', async () => {
    const h = loadHome({
      todos: {
        total: 5,
        tasks: [
          { id: 't1', project_id: 'p1', project_name: '增长', status: 'review', content: '确认定价方案\n附件见对话', updated_at: new Date(Date.now() - 5 * MINUTE).toISOString() },
          { id: 't2', project_id: '', project_name: '', status: 'todo', content: '整理客户访谈', updated_at: new Date(Date.now() - 3 * 60 * MINUTE).toISOString() },
          { id: 't3', project_id: '', project_name: '', status: 'progress', content: '周报', updated_at: '' },
        ],
      },
      unread: [
        run('auto-new', 'failed', 2, 'automation'),
        // A reply the user wrote inside an automation run is still that run.
        run('auto-reply', 'completed', 10, 'conversation'),
        run('project-task', 'waiting_input', 20, 'chat_send'),
        run('legacy', '', 30),
        run('deleted-elsewhere', 'completed', 40, 'chat_send'),
      ],
      conversations: [
        { conversation_id: 'auto-new', title: '每周竞品简报', project_id: '', origin_auto_task_id: 'a1' },
        { conversation_id: 'auto-reply', title: '每日销售摘要', project_id: '', origin_auto_task_id: 'a2' },
        { conversation_id: 'project-task', title: '竞品对比', project_id: 'p1' },
      ],
      lookup: (cids) => ({
        conversations: cids.includes('legacy')
          ? [{ conversation_id: 'legacy', title: '', project_id: '', origin_auto_task_id: '' }]
          : [],
        missing: cids.filter((cid) => cid === 'deleted-elsewhere'),
      }),
    });
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('populated');
    // Only conversations missing from the sidebar cache are looked up.
    expect(h.invokes.filter(([channel]) => channel === 'conversations.getMany'))
      .toEqual([['conversations.getMany', { cids: ['legacy', 'deleted-elsewhere'] }]]);
    expect(h.forgotten).toEqual(['deleted-elsewhere']);

    const html = h.html();
    const order = [...html.matchAll(/data-section="(\w+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['todos', 'automations', 'tasks']);
    expect(html).toContain('重要待办<span class="home-group-count">5</span>');
    expect(html).toContain('自动化待处理<span class="home-group-count">2</span>');
    expect(html).toContain('任务待你处理<span class="home-group-count">2</span>');
    // To-do rows share the sidebar's To-do icon, with status still shown in words.
    const sidebarTodoIcon = fs.readFileSync(path.join(R, 'index.html'), 'utf8')
      .match(/id="todos-btn"[^>]*><span data-ui-icon="([^"]+)"/)?.[1];
    expect(sidebarTodoIcon).toBe('clipboard-list');
    const todoIcon = uiIconHtml(sidebarTodoIcon, 'home-row-status-icon');
    expect(html).toContain(`<span class="home-row-status is-review" aria-hidden="true">${todoIcon}</span><span class="home-row-main"><span class="home-row-title">确认定价方案</span>`);
    expect(html).toContain('<span class="home-row-source">增长 · 待办</span>待确认 · 5分钟前更新');
    expect(html).toContain(`<span class="home-row-status is-todo" aria-hidden="true">${todoIcon}</span><span class="home-row-main"><span class="home-row-title">整理客户访谈</span>`);
    expect(html).toContain('<span class="home-row-source">全局待办</span>待处理 · 3小时前更新');
    expect(html).toContain('<span class="home-row-source">全局待办</span>处理中</span>');
    expect(html).toContain(`<span class="home-row-status is-progress" aria-hidden="true">${todoIcon}</span>`);
    // More to-dos than rows: the link to the full To-dos page sits in the group header, not below the list.
    expect(html).toContain('重要待办<span class="home-group-count">5</span></h2><button type="button" class="home-text-btn" data-home-action="more_todos" aria-describedby="home-group-todos-title">查看全部 →</button></div>');
    expect(html).not.toContain('home-group-more" data-home-action="more_todos"');
    expect(html).not.toContain('data-home-toggle="todos"');
    // Run rows: result-specific glyph and action, automation source, fallbacks for old records.
    expect(html).toMatch(/data-home-cid="auto-new"[^>]*data-home-status="failed"[^>]*><span class="home-row-status is-failed"/);
    expect(html).toMatch(/data-home-cid="auto-reply"[^>]*><span class="home-row-status is-completed"/);
    expect(html).toMatch(/data-home-cid="project-task"[^>]*><span class="home-row-status is-waiting_input"/);
    expect(html).toMatch(/data-home-cid="legacy"[^>]*><span class="home-row-status is-unknown"/);
    expect(html).toContain(`<span class="home-row-status is-failed" aria-hidden="true">${uiIconHtml('x-circle', 'home-row-status-icon')}</span>`);
    expect(html).toContain('<span class="home-row-title">每周竞品简报</span><span class="home-row-meta"><span class="home-row-source">自动化</span>失败 · 2分钟前</span></span><span class="home-row-action">查看原因');
    expect(html).toContain('<span class="home-row-source">增长 · 项目任务</span>等你输入 · 20分钟前</span></span><span class="home-row-action">去回复');
    expect(html).toContain('<span class="home-row-title">未命名任务</span><span class="home-row-meta"><span class="home-row-source">全局任务</span>有新结果 · 30分钟前');
    expect(html).not.toContain('deleted-elsewhere');
    expect(html).toContain('全部自动化 →');
  });

  it('shows three runs per group and folds up to twenty more', async () => {
    const unread = Array.from({ length: 25 }, (_, i) => run(`task-${i}`, 'completed', i + 1, 'chat_send'));
    const h = loadHome({
      unread,
      conversations: unread.map((record) => ({ conversation_id: record.cid, title: record.cid, project_id: '' })),
    });
    h.context.homeOnEnter();
    await h.settle();

    const html = h.html();
    const visible = html.split('<div class="home-list-fold"')[0];
    const fold = html.match(/<div class="home-list-fold" id="home-fold-tasks" hidden>(.*?)<\/div>/)?.[1] || '';
    expect([...visible.matchAll(/data-home-cid="([^"]+)"/g)].map((m) => m[1])).toEqual(['task-0', 'task-1', 'task-2']);
    expect([...fold.matchAll(/data-home-position="(\d+)"/g)].map((m) => Number(m[1])))
      .toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    expect(html).toContain('aria-expanded="false">展开其余 20 条</button>');
    expect(html).toContain('任务待你处理<span class="home-group-count">25</span>');

    const foldEl = element({ hidden: true });
    h.els['home-fold-tasks'] = foldEl;
    const toggle = element({ dataset: { homeToggle: 'tasks', homeFolded: '20' } });
    h.els['home-groups'].fire('click', click({ '[data-home-toggle]': toggle }));
    expect(foldEl.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('收起');
    // A refresh during the visit keeps the group unfolded.
    expect(vm.runInContext('_homeSectionHtml("tasks")', h.context)).toContain('id="home-fold-tasks">');

    h.els['home-groups'].fire('click', click({ '[data-home-toggle]': toggle }));
    expect(foldEl.hidden).toBe(true);
    expect(toggle.textContent).toBe('展开其余 20 条');
  });

  it('opens a run in its conversation and a to-do on the To-dos page', async () => {
    const h = loadHome({
      todos: { total: 1, tasks: [{ id: 't1', project_id: 'p1', project_name: '增长', status: 'todo', content: 'A' }] },
      unread: [run('auto-new', 'failed', 2, 'automation')],
      conversations: [{ conversation_id: 'auto-new', title: '简报', project_id: '', origin_auto_task_id: 'a1' }],
    });
    h.context.homeOnEnter();
    await h.settle();
    // Every open to-do is already listed, so there is no link to more of them.
    expect(h.html()).not.toContain('data-home-action="more_todos"');

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeCid: 'auto-new', homeSection: 'automations', homeStatus: 'failed', homePosition: '1' } },
    }));
    expect(h.views).toEqual([['conversation', 'auto-new', { entryPoint: 'home' }]]);
    // Gone right away, so coming back never shows the run just opened.
    expect(h.data().automations).toEqual([]);

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeTodo: 't1', homePid: 'p1', homeStatus: 'todo', homePosition: '1' } },
    }));
    await h.settle();
    expect(h.context.loadRendererFeature).toHaveBeenCalledWith('project');
    expect(h.context.focusTodo).toHaveBeenCalledWith('p1', 't1', { entryPoint: 'home' });

    h.els['home-groups'].fire('click', click({ '[data-home-action]': { dataset: { homeAction: 'all_automations' } } }));
    h.els['home-groups'].fire('click', click({ '[data-home-action]': { dataset: { homeAction: 'more_todos' } } }));
    expect(h.views.slice(1)).toEqual([['auto', null, { entryPoint: 'home' }], ['todos', null, { entryPoint: 'home' }]]);
  });

  it('returns to the conversation a to-do belongs to, and falls back to the To-dos page when it is gone', async () => {
    const h = loadHome({
      todos: { total: 2, tasks: [
        { id: 't-saved', project_id: '', status: 'todo', content: 'Write chapter 3', origin_cid: 'conv-origin' },
        { id: 't-gone', project_id: 'p1', status: 'progress', content: 'Deleted thread', origin_cid: 'conv-deleted' },
      ] },
      conversations: [{ conversation_id: 'conv-origin', title: 'Novel', project_id: '' }],
      lookup: (cids: string[]) => ({ conversations: [], missing: cids }),
    });
    h.context.homeOnEnter();
    await h.settle();
    expect(h.html()).toContain('data-home-origin-cid="conv-origin"');

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeTodo: 't-saved', homePid: '', homeStatus: 'todo', homePosition: '1', homeOriginCid: 'conv-origin' } },
    }));
    await h.settle();
    // Back to the original conversation, with nothing prefilled.
    expect(h.views).toEqual([['conversation', 'conv-origin', { entryPoint: 'home' }]]);
    expect(h.context.focusTodo).not.toHaveBeenCalled();

    h.els['home-groups'].fire('click', click({
      '.home-row': { dataset: { homeTodo: 't-gone', homePid: 'p1', homeStatus: 'progress', homePosition: '2', homeOriginCid: 'conv-deleted' } },
    }));
    await h.settle();
    expect(h.context.focusTodo).toHaveBeenCalledWith('p1', 't-gone', { entryPoint: 'home' });
    expect(h.invokes.some(([channel, payload]) => channel === 'conversations.getMany'
      && JSON.stringify(payload.cids) === JSON.stringify(['conv-deleted']))).toBe(true);
  });

  it('hides only the group whose lookup failed', async () => {
    const h = loadHome({
      todosError: true,
      unread: [run('task-a', 'completed', 1, 'chat_send')],
      conversations: [{ conversation_id: 'task-a', title: '报告', project_id: '' }],
    });
    h.context.homeOnEnter();
    await h.settle();

    expect(h.state()).toBe('populated');
    expect(h.html()).not.toContain('data-section="todos"');
    expect(h.html()).toContain('data-section="tasks"');
  });

  it('falls back to the empty layout when the first lookup is slow, then paints what arrives', async () => {
    let release: (value: any) => void = () => {};
    const h = loadHome();
    h.context.window.orkas.invoke = () => new Promise((resolve) => { release = resolve; });
    h.context.homeOnEnter();
    expect(h.state()).toBe('pending');
    const fallback = h.timers.find((timer) => timer.ms === 1500);
    fallback!.fn();
    expect(h.state()).toBe('empty');

    release({ ok: true, tasks: [{ id: 't1', project_id: '', status: 'todo', content: '迟到的待办' }], total: 1 });
    await h.settle();
    expect(h.state()).toBe('populated');
    expect(h.html()).toContain('迟到的待办');
  });

  it('refreshes while the home is showing and leaves it to the next visit otherwise', async () => {
    const h = loadHome();
    h.context.homeOnEnter();
    await h.settle();
    const lookups = () => h.invokes.filter(([channel]) => channel === 'projects.tasks.listOpen').length;
    expect(lookups()).toBe(1);

    h.context.homeRefresh();
    const debounce = h.timers.filter((timer) => timer.ms === 500);
    expect(debounce).toHaveLength(1);
    debounce[0].fn();
    await h.settle();
    expect(lookups()).toBe(2);

    h.context.currentView = 'conversation';
    h.context.homeRefresh();
    expect(h.timers.filter((timer) => timer.ms === 500)).toHaveLength(1);
  });
});

describe('Commander home connect chooser', () => {
  it('marks connected services and opens the picked one in Connectors', async () => {
    const h = loadHome({ connectors: [
      { id: 'lark', status: { kind: 'connected' } },
      { id: 'gmail', status: { kind: 'error' } },
    ] });
    h.context.homeOnEnter();
    await h.settle();

    h.els['home-explore-context'].fire('click', click({ '[data-home-connect]': element() }));
    await h.settle();
    expect(h.menus).toHaveLength(1);
    expect(h.menus[0].map((item: any) => item.label)).toEqual(['飞书 · 已连接', '钉钉', 'Gmail', 'Microsoft 365 邮箱']);

    h.menus[0][2].onClick();
    expect(h.views).toEqual([['connectors', null, { entryPoint: 'home' }]]);
    expect(h.context.window.openConnectorSetupById).toHaveBeenCalledWith('gmail', 'form');
  });
});
