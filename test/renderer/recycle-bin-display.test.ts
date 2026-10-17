import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';

function harness(displayItems: unknown[], lang = 'zh') {
  const body = { innerHTML: '', addEventListener: vi.fn() };
  const events = new Map<string, () => void>();
  const translations = new Map(LOCALES.map(locale => [locale.code, JSON.parse(readFileSync(
    resolve(__dirname, `../../src/renderer/locales/${locale.code}.json`), 'utf8',
  ))]));
  let language = lang;
  const list = vi.fn(async () => ({ batches: [{ id: 'batch', source: 'app', created_at_ms: 1,
    display_items: displayItems }] }));
  const window: any = { orkas: { recycleBin: { list } },
    addEventListener: (name: string, cb: () => void) => events.set(name, cb) };
  const context: any = { console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char: string) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[char]!)),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: { querySelectorAll: () => [], documentElement: { lang: 'en' } },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8'), Object.assign(context, {
    window, document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, getElementById: (id: string) => id === 'settings-recycle-body' ? body : null },
    getLang: () => language,
    t: (key: string) => translations.get(language as any)?.[key] || key,
  }));
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { body, list,
    async show() { context._settingsBindRecycleBinOnce(); await context._settingsRefreshRecycleBin(); await flush(); },
    async expand() {
      const click = body.addEventListener.mock.calls[0][1];
      await click({ target: { closest: (selector: string) => selector === '[data-recycle-view]'
        ? { getAttribute: () => 'batch' } : null } });
      await flush();
    },
    changeLang(lang: string) { language = lang; context._settingsRenderRecycleBin(); },
  };
}

describe('recycle automation display', () => {
  it('counts distinct tasks even when names match, and expands to readable names with hidden technical details', async () => {
    const app = harness([
      { category: 'auto_task', id: 'at_one', title: 'Weekly report <safe>', detail: 'Client Launch', path: 'cloud/auto_tasks/at_one/config.json' },
      { category: 'auto_task', id: 'at_two', title: 'Weekly report <safe>', path: 'cloud/auto_tasks/at_two/config.json' },
    ]);
    await app.show();
    expect(app.body.innerHTML).toContain('自动化 · 2 个任务');
    await app.expand();
    expect(app.body.innerHTML).toContain('Weekly report &lt;safe&gt;');
    expect(app.body.innerHTML).toContain('Client Launch');
    expect(app.body.innerHTML).not.toContain('settings-recycle-detail-path');
    expect(app.body.innerHTML).not.toContain('settings-recycle-detail-category');
    expect(app.body.innerHTML).toContain('at_one/config.json');
    expect(app.body.innerHTML).not.toContain('<safe>');
    const reads = app.list.mock.calls.length;
    app.changeLang('en');
    expect(app.body.innerHTML).toContain('Automation · 2 tasks');
    expect(app.list).toHaveBeenCalledTimes(reads);
  });

  it('keeps a single automation name and other deleted categories visible', async () => {
    const app = harness([
      { category: 'auto_task', id: 'at_one', title: 'Daily digest' },
      { category: 'attachment', id: 'notes', title: 'notes.txt', path: 'cloud/chat_attachments/c_one/notes.txt' },
    ], 'en');
    await app.show();
    expect(app.body.innerHTML).toContain('Automation: Daily digest');
    expect(app.body.innerHTML).toContain('Attachment: notes.txt');
    await app.expand();
    expect(app.body.innerHTML).toContain('settings-recycle-detail-path');
    expect(app.body.innerHTML).toContain('chat_attachments/c_one/notes.txt');
  });

  it('counts tasks rather than their configuration files and keeps distinct legacy IDs in details', async () => {
    const files = harness([
      { category: 'auto_task', id: 'cloud/auto_tasks/at_one/state.json', title: 'Digest', path: 'cloud/auto_tasks/at_one/state.json' },
      { category: 'auto_task', id: 'cloud/auto_tasks/at_one/config.json', title: 'Digest', path: 'cloud/auto_tasks/at_one/config.json' },
      { category: 'auto_task', id: 'at_two', title: 'Report', path: 'cloud/projects/p_launch/auto_tasks/at_two/config.json' },
    ], 'en');
    await files.show();
    expect(files.body.innerHTML).toContain('Automation · 2 tasks');
    await files.expand();
    expect(files.body.innerHTML.match(/class="settings-recycle-detail-title"/g)).toHaveLength(2);
    const legacy = harness([
      { category: 'auto_task', id: 'at_one', title: 'Same name' },
      { category: 'auto_task', id: 'at_two', title: 'Same name' },
    ], 'en');
    await legacy.show();
    await legacy.expand();
    expect(legacy.body.innerHTML.match(/class="settings-recycle-detail-title"/g)).toHaveLength(2);
  });

  it('provides automation count copy in every registered locale', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(resolve(__dirname,
        `../../src/renderer/locales/${locale.code}.json`), 'utf8'));
      expect(messages['settings.recycle.automation_count'], locale.code).toContain('{count}');
    }
  });
});
