import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';

function harness(initial = [
  { id: 'cloud-one', source: 'cloud_sync' },
  { id: 'cloud-two', source: 'cloud_sync' },
  { id: 'local-one', source: 'app' },
]) {
  let batches = initial.map(batch => ({ ...batch, created_at_ms: 1, display_items: [] }));
  let listener: (event: unknown) => Promise<void>;
  const body = { innerHTML: '', addEventListener: vi.fn((_: string, cb: typeof listener) => { listener = cb; }) };
  const messages = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
  const confirm = vi.fn(async () => true);
  const toast = vi.fn();
  const warnings: unknown[] = [];
  const events: unknown[] = [];
  const list = vi.fn(async () => ({ batches: [...batches] }));
  const removeRecord = async (id: string) => {
    batches = batches.filter(batch => batch.id !== id);
    return { deleted: true };
  };
  const remove = vi.fn(removeRecord);
  const restore = vi.fn();
  const window: any = { orkas: { recycleBin: { list, delete: remove, restore } },
    addEventListener() {}, Monitor: { event: (name: string, data: unknown) => events.push({ name, data }) } };
  const context: any = { console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char: string) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[char]!)),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: { querySelectorAll: () => [], documentElement: { lang: 'en' } },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8'), Object.assign(context, {
    window, document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, getElementById: (id: string) => id === 'settings-recycle-body' ? body : null },
    t: (key: string) => messages[key] || key,
    uiConfirmDanger: confirm, uiConfirm: vi.fn(async () => true), uiToast: toast, Monitor: window.Monitor,
    createLogger: () => ({ warn: (...args: unknown[]) => warnings.push(args) }),
  }));
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const click = (attribute: string, value = '') => listener({ target: {
    closest: (selector: string) => selector.includes(`[${attribute}]`) ? {
      disabled: false, getAttribute: () => value,
      hasAttribute: (name: string) => name === attribute,
    } : null,
  } });
  return { body, confirm, toast, remove, removeRecord, restore, warnings, events, list, flush, click,
    refresh: () => window.initRecycleBin(),
    boundListeners: () => body.addEventListener.mock.calls.length,
    remaining: () => batches.map(batch => batch.id),
    add: (id: string) => batches.push({ id, source: 'cloud_sync', created_at_ms: 1, display_items: [] }),
    async show() { context._settingsBindRecycleBinOnce(); await context._settingsRefreshRecycleBin(); await flush(); },
  };
}

describe('empty the selected recycle bin source', () => {
  it('confirms and empties the local list including retained historical records', async () => {
    const app = harness();
    await app.show();
    await app.flush();
    expect(app.body.innerHTML).toContain('data-recycle-clear');
    await app.click('data-recycle-clear');
    await app.flush();
    expect(app.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Recycle Bin'),
    }));
    expect(app.remaining()).toEqual([]);
    expect(app.body.innerHTML).toContain('No recoverable data');
    expect(app.toast).toHaveBeenCalledWith('Recycle bin emptied', { variant: 'success' });
  });

  it('cancels without deleting any records and allows another attempt', async () => {
    const app = harness();
    await app.show();
    app.confirm.mockResolvedValueOnce(false);
    await app.click('data-recycle-clear');
    expect(app.remove).not.toHaveBeenCalled();
    expect(app.remaining()).toHaveLength(3);
    await app.click('data-recycle-clear');
    expect(app.remaining()).toEqual([]);
  });

  it('disables clearing an empty source without opening a confirmation', async () => {
    const app = harness([]);
    await app.show();
    expect(app.body.innerHTML).toMatch(/<button[^>]*data-recycle-clear[^>]*disabled/);
    await app.click('data-recycle-clear');
    expect(app.confirm).not.toHaveBeenCalled();
    expect(app.remove).not.toHaveBeenCalled();
  });

  it('locks concurrent actions from confirmation through deletion and preserves newly arriving records', async () => {
    const app = harness();
    await app.show();
    let approve!: (value: boolean) => void;
    app.confirm.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    let finish!: () => void;
    app.remove.mockImplementationOnce(id => new Promise(resolve => {
      finish = () => { resolve(app.removeRecord(id)); };
    }));
    const pending = app.click('data-recycle-clear');
    await app.click('data-recycle-clear');
    await app.click('data-recycle-tab', 'app');
    await app.click('data-recycle-restore', 'cloud-one');
    expect(app.confirm).toHaveBeenCalledTimes(1);
    expect(app.restore).not.toHaveBeenCalled();
    app.add('cloud-new');
    approve(true);
    await app.flush();
    expect(app.body.innerHTML).toContain('Emptying');
    expect(app.remove).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(app.remove.mock.calls.map(([id]) => id)).toEqual(['cloud-one', 'cloud-two', 'local-one']);
    expect(app.remaining()).toContain('cloud-new');
  });

  it('reports a partial failure safely and retries only the remaining records', async () => {
    const app = harness();
    await app.show();
    app.remove.mockImplementationOnce(app.removeRecord)
      .mockRejectedValueOnce(new Error('EACCES /private/user-data secret'));
    await app.click('data-recycle-clear');
    await app.flush();
    expect(app.remaining()).toEqual(['cloud-two', 'local-one']);
    expect(app.toast).toHaveBeenCalledWith('Could not finish emptying the recycle bin. Please try again.', { variant: 'error' });
    expect(JSON.stringify(app.events)).not.toContain('/private');
    expect(JSON.stringify(app.warnings)).not.toContain('secret');
    await app.click('data-recycle-clear');
    expect(app.remaining()).toEqual([]);
  });

  it('rejects a malformed deletion response without reporting success or deleting later records', async () => {
    const app = harness();
    await app.show();
    app.remove.mockResolvedValueOnce({} as any);
    await app.click('data-recycle-clear');
    expect(app.remove).toHaveBeenCalledTimes(1);
    expect(app.remaining()).toHaveLength(3);
    expect(app.toast).toHaveBeenCalledWith(expect.any(String), { variant: 'error' });
  });

  it('waits for an already running restore before allowing destructive clearing', async () => {
    const app = harness();
    await app.show();
    let finish!: (value: unknown) => void;
    app.restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = app.click('data-recycle-restore', 'cloud-one');
    await app.flush();
    await app.click('data-recycle-clear');
    expect(app.remove).not.toHaveBeenCalled();
    expect(app.confirm).not.toHaveBeenCalled();
    finish({ restored: 1, changed: 1 });
    await pending;
    await app.click('data-recycle-clear');
    expect(app.remaining()).toEqual([]);
  });

  it('provides clear and confirmation copy in every registered locale', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${locale.code}.json`), 'utf8'));
      for (const key of ['clear', 'clear_title', 'clear_confirm', 'clearing', 'cleared', 'clear_failed']) {
        expect(messages[`settings.recycle.${key}`], `${locale.code}: ${key}`).toBeTruthy();
      }
      expect(messages['settings.recycle.clear_confirm']).toContain('{source}');
      expect(messages['settings.recycle.clear_confirm']).toContain('{count}');
    }
  });
});


describe('local recycle refresh and restore feedback', () => {
  it('refreshes the existing local list through the shared cleanup hook without rebinding', async () => {
    const app = harness([]);
    await app.show();
    app.add('new-cleanup-batch');
    await app.refresh();
    expect(app.body.innerHTML).toContain('data-recycle-restore="new-cleanup-batch"');
    expect(app.body.innerHTML).not.toContain('data-recycle-tab=');
    expect(app.boundListeners()).toBe(1);
    expect(app.list).toHaveBeenCalledTimes(2);
  });

  for (const fixture of [
    { result: { ok: true, restored: 2, skipped: 1, reactivated: 1 }, text: 'Restored 4 files', variant: 'success' },
    { result: { ok: true, restored: 1, failed_paths: ['missing.txt'] }, text: 'Some content could not be restored: 1 file(s) failed. The recycle bin copy was kept so you can retry.', variant: 'warning' },
    { result: { ok: true, restored: 0 }, text: 'Nothing was restored. The data may already exist or may have been restored before.', variant: 'warning' },
  ]) it(`reports ${fixture.variant} for the actual restore outcome: ${fixture.text}`, async () => {
    const app = harness();
    await app.show();
    app.restore.mockResolvedValueOnce(fixture.result);
    await app.click('data-recycle-restore', 'local-one');
    expect(app.restore).toHaveBeenCalledWith('local-one');
    expect(app.toast).toHaveBeenCalledWith(fixture.text, { variant: fixture.variant });
    expect(app.events).toEqual([]);
  });

  for (const result of [{ ok: false, restored: 2 }, { ok: true }]) {
    it(`does not report a successful restore for an invalid result ${JSON.stringify(result)}`, async () => {
      const app = harness();
      await app.show();
      app.restore.mockResolvedValueOnce(result);
      await app.click('data-recycle-restore', 'local-one');
      expect(app.restore).toHaveBeenCalledWith('local-one');
      expect(app.toast).not.toHaveBeenCalled();
      expect(app.warnings).toHaveLength(1);
      expect(app.remaining()).toContain('local-one');
    });
  }
});
