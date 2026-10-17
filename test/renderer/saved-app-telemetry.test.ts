import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const modulesDir = resolve(__dirname, '../../src/renderer/modules');
const fileViewerSource = readFileSync(resolve(modulesDir, 'chat-file-viewer.js'), 'utf8');
const conversationInfoSource = readFileSync(resolve(modulesDir, 'conversation-info.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
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

describe('Save-as-App failure alerts', () => {
  // Raw IPC/main errors can carry absolute local paths and English internals;
  // the user sees only the localized action copy, and logs stay code-only.
  const localeTable = (lang: string) => JSON.parse(readFileSync(resolve(modulesDir, `../locales/${lang}.json`), 'utf8'));
  const privateDetail = '/Users/test/private/project/app.html: EACCES permission denied';
  const outcomes = [
    ['rejected', async () => { throw new Error(privateDetail); }],
    ['refused', async () => ({ ok: false, error: privateDetail })],
    ['root_refused', async () => ({ ok: false, error: 'app_bundle_root' })],
  ] as const;
  const cases = (['zh', 'en'] as const).flatMap(lang => outcomes.map(([mode, invoke]) => [lang, mode, invoke] as const));

  it.each(cases)('file preview shows only "%s" save failure copy when the save is %s', async (lang, _mode, invoke) => {
    const table = localeTable(lang);
    const alerts: string[] = [];
    const warnings: any[] = [];
    const context: any = {
      Date, Math, Object, String,
      t: (key: string) => table[key] || key,
      _viewerCurrentPath: '/Users/test/private/project/app.html',
      _viewerSaveAppBtn: { disabled: false, innerHTML: '' },
      _viewerDirty: false,
      _kindOf: () => 'html',
      _viewerLogFailure: (name: string, payload: any) => warnings.push({ name, payload }),
      _viewerShowAlert: async (message: string) => { alerts.push(message); },
      _viewerSaveAppButtonHtml: () => '<button>',
      _setSaveAppVisible: () => {},
      _viewerFileActionPayload: () => ({ path: '/Users/test/private/project/app.html' }),
      _scheduleSaveAppButtonRestore: () => {},
      window: { orkas: { invoke: vi.fn(invoke) } },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(fileViewerSource, '_viewerLabel'),
      extractFunction(fileViewerSource, '_viewerStableFailure'),
      extractFunction(fileViewerSource, '_viewerDurationSince'),
      extractFunction(fileViewerSource, '_onSaveAppClick'),
    ].join('\n'), context);

    await context._onSaveAppClick();

    expect(alerts).toEqual([table[_mode === 'root_refused' ? 'apps.save_root_folder_required' : 'apps.save_failed']]);
    expect(JSON.stringify(warnings)).not.toContain('/Users/');
    expect(JSON.stringify(warnings)).not.toContain('EACCES');
  });

  it.each(cases)('conversation info shows only "%s" save failure copy when the save is %s', async (lang, _mode, invoke) => {
    const table = localeTable(lang);
    const alerts: string[] = [];
    const warnings: any[] = [];
    const context: any = {
      Date, Math, Object, String,
      t: (key: string) => table[key] || key,
      window: { orkas: { invoke: vi.fn(invoke) } },
      _infoLog: { warn: (_message: string, payload: any) => warnings.push(payload) },
      _fileActionPayload: () => ({ path: '/Users/test/private/project/app.html' }),
      uiAlert: async (message: string) => { alerts.push(message); },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(conversationInfoSource, '_label'),
      extractFunction(conversationInfoSource, '_baseName'),
      extractFunction(conversationInfoSource, '_extForName'),
      extractFunction(conversationInfoSource, '_savedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_logSavedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_saveEntryAsApp'),
    ].join('\n'), context);

    await context._saveEntryAsApp('/Users/test/private/project/app.html', 'private-cid');

    expect(alerts).toEqual([table[_mode === 'root_refused' ? 'apps.save_root_folder_required' : 'apps.save_failed']]);
    expect(JSON.stringify(warnings)).not.toContain('/Users/');
  });
});


describe('historical web receipts at file entry points', () => {
  it.each(['preview save', 'conversation save', 'preview open'])('guides once without a generic error or local success effects: %s', async entry => {
    const receipt = { ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' };
    const show = vi.fn(async () => {}), alert = vi.fn(), warn = vi.fn(), restore = vi.fn();
    const invoke = vi.fn(async () => receipt);
    const context: any = {
      window: { orkas: { invoke }, OrkasPreviewWindows: { open: invoke, options: () => ({}) } },
      _viewerCurrentPath: '/fixture/app.html', _viewerSaveAppBtn: { disabled: false }, _viewerDirty: false,
      _viewerLabel: (_key: string, fallback: string) => fallback,
      _viewerSaveAppButtonHtml: () => '<button>', _setSaveAppVisible: vi.fn(),
      _viewerFileActionPayload: () => ({ path: '/fixture/app.html' }),
      _fileActionPayload: () => ({ path: '/fixture/app.html' }),
      _scheduleSaveAppButtonRestore: restore, _viewerShowAlert: alert, uiAlert: alert,
      _viewerLogFailure: warn, _logSavedAppSaveFailure: warn,
      _ensureViewerFileExists: async () => true, _kindOf: () => 'html',
    };
    vm.createContext(context);
    vm.runInContext(readFileSync(resolve(modulesDir, 'commercial-entry.js'), 'utf8'), context);
    context.window.OrkasCommercialEntry.show = show;
    if (entry === 'conversation save') {
      vm.runInContext(extractFunction(conversationInfoSource, '_saveEntryAsApp'), context);
      await context._saveEntryAsApp('/fixture/app.html', 'task');
    } else if (entry === 'preview save') {
      vm.runInContext(extractFunction(fileViewerSource, '_onSaveAppClick'), context);
      await context._onSaveAppClick();
      expect(restore).toHaveBeenCalledExactlyOnceWith('/fixture/app.html', '<button>');
    } else {
      vm.runInContext(extractFunction(fileViewerSource, 'openChatFileViewer'), context);
      await expect(context.openChatFileViewer('/fixture/app.html')).resolves.toBe(receipt);
    }
    expect(show).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
});
