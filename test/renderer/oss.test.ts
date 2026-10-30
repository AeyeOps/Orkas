import { composerAccessorSource } from './composer-test-source';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// oss.js is a classic renderer script (globals, no exports). We load it into a
// Node VM with a fake DOM + the renderer globals it depends on, the same way
// category-tabs.test.ts exercises agents.js / skills.js.

class FakeClassList {
  classes = new Set<string>();
  add(c: string) { this.classes.add(c); }
  remove(c: string) { this.classes.delete(c); }
  contains(c: string) { return this.classes.has(c); }
}

class FakeInput {
  value = '';
  focused = false;
  classList = new FakeClassList();
  style: Record<string, string> = {};
  events: string[] = [];
  dataset: Record<string, string> = {};
  selection: [number, number] | null = null;
  focus() { this.focused = true; }
  setSelectionRange(a: number, b: number) { this.selection = [a, b]; }
  dispatchEvent(e: any) { this.events.push(e?.type || 'event'); return true; }
  addEventListener() {}
  querySelectorAll() { return []; }
}

interface LoadOpts {
  invoke?: (channel: string, payload?: unknown) => Promise<any>;
  lang?: string;
}

function loadOss(opts: LoadOpts = {}) {
  const elements = new Map<string, FakeInput>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeInput());
    return elements.get(id)!;
  };
  let invokeCount = 0;
  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const calls = { setView: [] as string[], setRecipient: [] as any[], openMarketplace: [] as any[] };

  const context: any = {
    console,
    setTimeout,
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    document: {
      getElementById: (id: string) => el(id),
      addEventListener: () => {},
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: () => {},
      dispatchEvent: () => true,
    } as any,
    escapeHtml: (s: unknown) => String(s ?? ''),
    uiIconHtml: () => '<svg></svg>',
    getLang: () => opts.lang || 'zh',
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    t: (key: string) => {
      if (key === 'oss.prompt') return 'Use {name} ({url}) to help me with: [describe your task here]. If {name} is already installed locally, use it directly; otherwise install it from {url} as local external package {id} first, then run the task.';
      if (key === 'oss.office_prompt') return 'OfficeCLI is built in. Use built-in Office tools for: [describe your task here].';
      if (key === 'oss.install_prompt') return 'Please install the open-source project {name} ({url}) as local external package {id}. Once it is installed, briefly tell me what it can do.';
      if (key === 'oss.office_install_prompt') return 'OfficeCLI is already built in as Office tools. Briefly explain what it can do.';
      if (key === 'oss.use_for') return 'Good for';
      if (key === 'oss.add_to_task') return 'Add to task';
      if (key === 'oss.more_tools') return 'More tools';
      if (key === 'oss.subtitle') return 'Extend Commander capabilities';
      return key;
    },
    setView: (v: string) => { calls.setView.push(v); },
    setChatRecipient: (target: string, next: any) => { calls.setRecipient.push({ target, next }); },
    loadRendererFeature: async () => {},
    openMarketplace: (tab: string, openOpts?: unknown) => { calls.openMarketplace.push({ tab, opts: openOpts }); },
  };
  context.window.orkas = {
    invoke: opts.invoke || (async (channel: string) => {
      if (channel === 'marketplace.getListingsCache') return { entries: {} };
      if (channel === 'marketplace.mergeListingsCache') return { ok: true };
      return { list: [], categories: [] };
    }),
  };
  // wrap default invoke to count
  const baseInvoke = context.window.orkas.invoke;
  context.window.orkas.invoke = async (...a: any[]) => {
    invokeCount++;
    invokeCalls.push({ channel: a[0], payload: a[1] });
    return baseInvoke(...a);
  };

  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/oss.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'oss.js' });
  return { context, el, calls, invokeCount: () => invokeCount, invokeCalls };
}

describe('oss.js', () => {
  it('keeps open-source tools off the home quick-start surface', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const conversation = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
    expect(html).not.toContain('id="oss-entry"');
    expect(html).not.toContain('id="oss-entry-grid"');
    expect(html).not.toContain('id="quick-panel-oss-more"');
    expect(conversation).not.toContain('oss-quick-task-card');
    expect(conversation).not.toContain("_quickStartText('new_chat.quick.task.oss'");
  });

  it('prefillCommander writes the task, focuses, sets the Commander recipient, and does NOT send', () => {
    const { context, el, calls } = loadOss();
    context.prefillCommander('帮我做一段产品开场动画');
    const input = el('new-chat-input');
    expect(input.value).toBe('帮我做一段产品开场动画');
    expect(input.focused).toBe(true);
    expect(input.events).toContain('input');           // triggers autoGrow, not a send
    expect(input.classList.contains('is-prefilled')).toBe(true);
    expect(calls.setView).toContain('new-chat');
    expect(calls.setRecipient[0]).toEqual({ target: 'new-chat', next: { kind: 'commander' } });
  });

  it('prefillCommander ignores empty input', () => {
    const { context, calls } = loadOss();
    context.prefillCommander('');
    expect(calls.setView).toEqual([]);
  });

  it('does not treat bracketed content in an existing task as an OSS placeholder', () => {
    const { context, el } = loadOss();
    const applied = context.prefillCommander(
      'Use Project X for this task: keep [sample] in the copy.',
      { trackPlaceholder: false },
    );

    expect(applied).toBe(true);
    expect(el('new-chat-input').dataset.ossTemplatePlaceholder).toBeUndefined();
  });

  it('adds a selected tool to an existing task without nesting another OSS prompt', () => {
    const { context } = loadOss();
    const project = {
      id: 'project-x',
      name: 'Project X',
      repo: 'org/project-x',
    };
    const quickStartInput = {
      value: 'Build a landing page with $& in the example copy.',
      dataset: {},
    };
    const enhanced = context._ossPromptForComposer(project, quickStartInput);
    expect(enhanced).toContain('Build a landing page with $& in the example copy.');
    expect(enhanced).not.toContain('[describe your task here]');

    const existingOssInput = {
      value: enhanced,
      dataset: { ossTemplateDraft: '1' },
    };
    expect(context._ossPromptForComposer(project, existingOssInput))
      .toContain('[describe your task here]');
  });

  it('loadOssCatalog returns bundled projects and categories on every request', async () => {
    const payload = {
      list: [{ id: 'x', name: 'X', task_zh: 't', task_en: 't', category: 'anim', driver: 'cli', stars: 10 }],
      categories: [{ code: 'anim', name_zh: '动画', name_en: 'Animation' }],
      total: 1,
    };
    const { context, invokeCalls } = loadOss({ invoke: async () => payload });
    const a = await context.loadOssCatalog();
    const b = await context.loadOssCatalog();
    expect(a).toEqual({ projects: payload.list, categories: payload.categories, total: 1, sourceType: 'bundled', ts: 0 });
    expect(b).toEqual(a);
    expect(invokeCalls).toEqual([
      { channel: 'marketplace.listProjects', payload: { home_only: false, category: '', q: '' } },
      { channel: 'marketplace.listProjects', payload: { home_only: false, category: '', q: '' } },
    ]);
  });

  it.each(['project|5|home|||', 'project|home|||'])('loadOssCatalog ignores a saved vendor catalog at %s', async cacheKey => {
    const bundledProject = { id: 'Lark-CLI', name: 'Lark-CLI', task_zh: '飞书', task_en: 'Lark', category: 'office', driver: 'cli' };
    const { context, invokeCalls } = loadOss({
      invoke: async channel => {
        if (channel === 'marketplace.getListingsCache') {
          return { entries: { [cacheKey]: { items: [{ id: 'vendor-cached' }], total: 1, ts: Date.now() } } };
        }
        if (channel !== 'marketplace.listProjects') throw new Error('unexpected IPC');
        return { list: [bundledProject], categories: [], total: 1 };
      },
    });
    const data = await context.loadOssCatalog({ homeOnly: true, revalidate: false });
    expect(data.projects).toEqual([bundledProject]);
    expect(data.sourceType).toBe('bundled');
    expect(invokeCalls).toEqual([
      { channel: 'marketplace.listProjects', payload: { home_only: true, category: '', q: '' } },
    ]);
  });

  it.each([false, true, 'cold-start', 'always'])('loadOssCatalog keeps the bundled source with revalidate=%s', async revalidate => {
    const { context, invokeCalls } = loadOss({ invoke: async () => ({ list: [], categories: [], total: 0 }) });
    const data = await context.loadOssCatalog({ homeOnly: true, revalidate });
    expect(data).toEqual({ projects: [], categories: [], total: 0, sourceType: 'bundled', ts: 0 });
    await Promise.resolve();
    expect(invokeCalls).toEqual([
      { channel: 'marketplace.listProjects', payload: { home_only: true, category: '', q: '' } },
    ]);
  });

  it('loadOssCatalog passes home/search/category options through to the local catalog', async () => {
    const { context, invokeCalls } = loadOss({ invoke: async () => ({ list: [], categories: [], total: 0 }) });
    await context.loadOssCatalog({ homeOnly: true });
    await context.loadOssCatalog({ category: 'rag', q: 'llama', size: 100 });
    expect(invokeCalls).toEqual([
      { channel: 'marketplace.listProjects', payload: { home_only: true, category: '', q: '' } },
      { channel: 'marketplace.listProjects', payload: { home_only: false, category: 'rag', q: 'llama', size: 100 } },
    ]);
  });

  it('ossGithubUrl derives the repo page', () => {
    const { context } = loadOss();
    expect(context.ossGithubUrl({ repo: 'hugohe3/ppt-master' })).toBe('https://github.com/hugohe3/ppt-master');
    expect(context.ossGithubUrl({ repo: '' })).toBe('');
  });

  it('ossPromptFor names the project + url and leaves the task blank', () => {
    const { context } = loadOss();
    const prompt = context.ossPromptFor({ id: 'pkg-id', name: 'PPT-Master', repo: 'hugohe3/ppt-master' });
    expect(prompt).toContain('PPT-Master');
    expect(prompt).toContain('https://github.com/hugohe3/ppt-master');
    expect(prompt).toContain('pkg-id');
    expect(prompt).not.toContain('verification code');
    expect(prompt).toMatch(/\[[^\]]+\]/); // a blank task placeholder remains
  });

  it('ossPromptFor tells OfficeCLI to use built-in Office tools', () => {
    const { context } = loadOss();
    const prompt = context.ossPromptFor({ id: 'OfficeCLI', name: 'OfficeCLI', repo: 'iOfficeAI/OfficeCLI' });
    expect(prompt).toContain('OfficeCLI is built in');
    expect(prompt).toContain('built-in Office tools');
    expect(prompt).not.toContain('https://github.com/iOfficeAI/OfficeCLI');
    expect(prompt).not.toContain('create_docx');
    expect(prompt.toLowerCase()).not.toContain('install');
    expect(prompt).toMatch(/\[[^\]]+\]/);
  });

  it('ossInstallPromptFor is an install request with no blank task slot', () => {
    const { context } = loadOss();
    const prompt = context.ossInstallPromptFor({ id: 'pkg-id', name: 'PPT-Master', repo: 'hugohe3/ppt-master' });
    expect(prompt).toContain('PPT-Master');
    expect(prompt).toContain('https://github.com/hugohe3/ppt-master');
    expect(prompt).toContain('pkg-id');
    expect(prompt.toLowerCase()).toContain('install');
    expect(prompt).not.toContain('verification code');
    expect(prompt).not.toMatch(/\[[^\]]*\]/); // no task placeholder — nothing to fill in
  });

  it('loadOssInstalled matches packages by stable name or repo url', async () => {
    const { context } = loadOss({
      invoke: async (channel) => {
        if (channel === 'packages.list') {
          return {
            ok: true,
            packages: [
              { name: 'cli', repo_url: 'https://github.com/heygen-com/hyperframes' },
              { name: 'ppt-master', repo_url: 'https://github.com/hugohe3/ppt-master.git' },
            ],
          };
        }
        if (channel === 'marketplace.getListingsCache') return { entries: {} };
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return { list: [], categories: [] };
      },
    });
    const installed = await context.loadOssInstalled(true);
    expect(context.isOssProjectInstalled({ id: 'hyperframes', repo: 'heygen-com/hyperframes' }, installed)).toBe(true);
    expect(context.isOssProjectInstalled({ id: 'ppt-master', repo: 'hugohe3/ppt-master' }, installed)).toBe(true);
    expect(context.isOssProjectInstalled({ id: 'missing', repo: 'missing/project' }, installed)).toBe(false);
  });

  it('ossInstallPromptFor explains bundled OfficeCLI instead of installing it', () => {
    const { context } = loadOss();
    const prompt = context.ossInstallPromptFor({ id: 'OfficeCLI', name: 'OfficeCLI', repo: 'iOfficeAI/OfficeCLI' });
    expect(prompt).toContain('OfficeCLI is already built in as Office tools');
    expect(prompt).not.toContain('https://github.com/iOfficeAI/OfficeCLI');
    expect(prompt.toLowerCase()).not.toContain('install');
    expect(prompt).not.toMatch(/\[[^\]]*\]/);
  });

  it('prefillCommander selects the [...] placeholder so the user types over it', () => {
    const { context, el } = loadOss();
    const prompt = context.ossPromptFor({ name: 'X', repo: 'o/x' });
    context.prefillCommander(prompt);
    const input = el('new-chat-input');
    const m = prompt.match(/\[[^\]]*\]/)!;
    expect(input.selection).toEqual([m.index, m.index! + m[0].length]);
    expect(input.dataset.ossTemplatePlaceholder).toBe(m[0]);
    expect(context.unresolvedOssTemplatePlaceholder(input)).toBe(m[0]);
  });

  it('validates only the exact renderer-owned OSS placeholder', () => {
    const { context, el } = loadOss();
    const input = el('new-chat-input');
    input.value = 'ordinary [code] prompt';
    expect(context.unresolvedOssTemplatePlaceholder(input)).toBe('');

    const prompt = context.ossPromptFor({ name: 'X', repo: 'o/x' });
    context.prefillCommander(prompt);
    const marker = input.dataset.ossTemplatePlaceholder;
    input.value = input.value.replace(marker, 'build a landing page');
    expect(context.unresolvedOssTemplatePlaceholder(input)).toBe('');
    expect(input.dataset.ossTemplatePlaceholder).toBeUndefined();
  });

  it('ossTaskFor / ossDescFor pick the active language', () => {
    const zh = loadOss({ lang: 'zh' }).context;
    const en = loadOss({ lang: 'en' }).context;
    const p = { task_zh: '中文', task_en: 'english', description_zh: '描述', description_en: 'desc' };
    expect(zh.ossTaskFor(p)).toBe('中文');
    expect(en.ossTaskFor(p)).toBe('english');
    expect(zh.ossDescFor(p)).toBe('描述');
    expect(en.ossDescFor(p)).toBe('desc');
  });

  it('maps the slides category to the presentation icon', () => {
    const { context } = loadOss();
    expect(context.ossIconFor('slides')).toBe('presentation');
  });

  it('localizes descriptions while retaining existing task prompt language and legacy fallbacks', () => {
    const descriptions = { es: 'Descripción', fr: 'Description française', ko: '한국어 설명', de: 'Beschreibung', ru: 'Описание', it: 'Descrizione' };
    for (const [lang, description] of Object.entries(descriptions)) {
      const { context } = loadOss({ lang });
      const p = { task_zh: '中文任务', task_en: 'English task', description_zh: '中文描述', description_en: 'English description', ['description_' + lang]: description };
      expect(context.ossDescFor(p)).toBe(description);
      expect(context.ossTaskFor(p)).toBe('English task');
      delete p['description_' + lang];
      expect(context.ossDescFor(p)).toBe('English description');
      expect(context.ossDescFor({ description_zh: '中文描述' })).toBe('中文描述');
      expect(context.ossDescFor({})).toBe('');
    }
  });
});

it('keeps application logging free of retired statistics wrappers and their success-only payloads', () => {
  const retired = /\b(?:_logManageResult|_logOpenResult|_logCreateAction|_logSavedAppSaveResult|_logLibraryImportResult|_artifactSaveSourceView|_logArtifactSaveResult|_savedAppSourceKind|_fileKindForLog|_trackRendererFeatureLoad|_autoCreateActionLogger|_autoAttachmentPayload|_logWorkspaceOpenFolderResult)\b/;
  for (const module of ['saved-apps.js', 'chat-artifact.js', 'conversation-info.js', 'lazy-features.js', 'auto.js', 'user-workspace.js']) {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/modules', module), 'utf8');
    expect(source, module).not.toMatch(retired);
  }
});

it('keeps private creation and execution analytics out of the local executors', () => {
  for (const file of ['src/main/features/agent_creation_telemetry.ts', 'bin/execution-error-diagnostics.cjs', 'bin/execution-error-diagnostics.d.cts']) {
    expect(fs.existsSync(path.resolve(process.cwd(), file)), file).toBe(false);
  }
  for (const file of ['src/main/features/project_setup_tool.ts', 'src/main/features/auto_tasks_tool.ts', 'src/core-agent/src/agent/runner.ts']) {
    expect(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'), file)
      .not.toMatch(/\b(?:reportAgentCreation|onAgentCreationTelemetry|onInternalToolError|reportInternalToolError|captureErrorDiagnostic|priorErrorDiagnostic)\b/);
  }
});
