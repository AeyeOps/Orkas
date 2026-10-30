import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class FakeElement {
  value = '';
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event?: any) => unknown>>();

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) || null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  querySelector() { return null; }
  focus() { this.setAttribute('data-focused', 'true'); }

  addEventListener(type: string, handler: (event?: any) => unknown) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ currentTarget: this, target: this, preventDefault: vi.fn(), ...event });
    }
  }

  click() { return this.dispatch('click'); }
}

function loadCredentialHarness() {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'settings-orkas-api-group',
    'settings-orkas-api-status',
    'settings-orkas-api-saved',
    'settings-orkas-api-key-masked',
    'settings-orkas-api-delete',
    'settings-entries',
    'settings-search-entries',
    'settings-image-entries',
    'settings-video-entries',
    'settings-tts-entries',
  ]) elements.set(id, new FakeElement());

  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'orkasApi.getStatus') return {
      ok: true,
      configured: false,
      keyMasked: '',
      name: '',
      connectorAccess: false,
    };
    if (channel === 'orkasApi.remove') return { ok: true, removed: true };
    return { ok: true };
  });
  const refreshModelGuard = vi.fn(async () => true);
  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    getLang: () => 'en',
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    refreshModelGuard,
    uiConfirm: vi.fn(async () => true),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings.js' });
  vm.runInContext(`
    window.__orkasApiRefreshes = 0;
    _settingsRefreshAllCredentialSections = async () => { window.__orkasApiRefreshes += 1; };
    _settingsBindOrkasApiOnce();
  `, context);
  return { context, elements, html, source, invoke, refreshModelGuard };
}

describe('stored Orkas API credential', () => {
  it('uses the standard settings card background and border', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');
    expect(css).toMatch(/\.settings-group\s*{[^}]*background:\s*var\(--surface\);[^}]*border:\s*1px solid var\(--border\);/s);
    expect(css).not.toContain('.settings-orkas-api-group::before');
    expect(css).not.toMatch(/\.settings-orkas-api-group\s*{[^}]*(?:linear-gradient|border-color)/s);
  });

  it('lays out saved credentials and deletion without exposing the raw key', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');
    expect(css).toMatch(/\.settings-orkas-api-group\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content;/s);
    expect(css).toMatch(/\.settings-orkas-api-head\s*{[^}]*display:\s*contents;/s);
    expect(css).toContain('.settings-orkas-api-saved');
    expect(css).toContain('.settings-orkas-api-key-summary code');
    expect(css).toContain('.settings-orkas-api-actions');
  });

  it('uses the complete Orkas service labels in configured rows', () => {
    const { context, elements, source } = loadCredentialHarness();
    expect(source).not.toContain("label: 'Orkas API'");
    expect(vm.runInContext("_ttsProviderLabel('orkas-api')", context)).toBe('Orkas · Voice');

    vm.runInContext(`
      _settingsAttachReorderDnd = () => {};
      _settingsState.searchProfiles = [{ id: 's1', provider: 'orkas-api', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.imageProfiles = [{ id: 'i1', provider: 'orkas-api', model: 'orkas-image', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.videoProfiles = [{ id: 'v1', provider: 'orkas-api', model: 'orkas-video', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.ttsProfiles = [{ id: 't1', provider: 'orkas-api', model: 'orkas-tts-1', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsRenderSearchEntries();
      _settingsRenderImageEntries();
      _settingsRenderVideoEntries();
      _settingsRenderTtsEntries();
    `, context);

    const configuredLabel = (id: string) => elements.get(id)!
      .children[0]!.children[1]!.children[0]!.innerHTML;
    expect(configuredLabel('settings-search-entries')).toContain('>Orkas · Search</span>');
    expect(configuredLabel('settings-image-entries')).toContain('>Orkas · Image</span>');
    expect(configuredLabel('settings-video-entries')).toContain('>Orkas · Video</span>');
    expect(configuredLabel('settings-tts-entries')).toContain('>Orkas · Voice</span>');
    expect(source).toContain('settings.orkas_api.recommended');
    expect(source).toContain('settings.orkas_api.includes');
  });

  it('renders both configured official model rows in Settings', () => {
    const { context, elements } = loadCredentialHarness();
    context.t = (key: string, values?: { models?: string }) => (
      values?.models ? `${key}: ${values.models}` : key
    );
    vm.runInContext(`
      _settingsAttachReorderDnd = () => {};
      _settingsState.entries = [
        {
          entryId: 'orkas-standard', provider: 'orkas-api', providerLabel: 'Orkas',
          model: 'orkas-llm-1.5', modelName: 'Orkas-1.5', modelEditable: false,
          modelAvailable: true, official: true, recommended: true,
          includedModels: ['DeepSeek V4', 'GPT-5.6 Luna', 'Claude-Sonnet-5', 'Gemini-3.6 Flash'],
          profileType: 'api_key', profileAvailable: true, profileLabel: 'Orkas'
        },
        {
          entryId: 'orkas-pro', provider: 'orkas-api', providerLabel: 'Orkas',
          model: 'orkas-llm-1.5-pro', modelName: 'Orkas-1.5 Pro', modelEditable: false,
          modelAvailable: true, official: true,
          includedModels: ['GPT-5.6 Sol', 'Claude Opus 5', 'Kimi K3'],
          profileType: 'api_key', profileAvailable: true, profileLabel: 'Orkas'
        }
      ];
      _settingsRenderEntries();
    `, context);

    const rows = elements.get('settings-entries')!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.children[1]!.children[0]!.innerHTML).toContain('Orkas-1.5');
    expect(rows[1]!.children[1]!.children[0]!.innerHTML).toContain('Orkas-1.5 Pro');
    expect(rows[0]!.children[1]!.children[1]!.children[1]!.textContent)
      .toContain('DeepSeek V4 · GPT-5.6 Luna · Claude-Sonnet-5 · Gemini-3.6 Flash');
    expect(rows[1]!.children[1]!.children[1]!.children[1]!.textContent)
      .toContain('GPT-5.6 Sol · Claude Opus 5 · Kimi K3');
  });

  it('keeps the masked credential visible and supports deletion', async () => {
    const { context, elements, invoke } = loadCredentialHarness();
    vm.runInContext(`
      _settingsState.orkasApiCredential = {
        configured: true,
        keyMasked: 'orka…1234',
        name: 'Desktop key',
        connectorAccess: true,
      };
      _settingsRenderOrkasApiCard();
    `, context);

    expect(elements.get('settings-orkas-api-saved')!.hidden).toBe(false);
    expect(elements.get('settings-orkas-api-key-masked')!.textContent).toBe('orka…1234');

    await elements.get('settings-orkas-api-delete')!.click();
    expect(invoke).toHaveBeenCalledWith('orkasApi.remove');
    const status = elements.get('settings-orkas-api-status')!;
    expect(status.textContent).toBe('');
    expect(status.getAttribute('data-i18n')).toBeNull();
    context.t = (key: string) => `translated:${key}`;
    vm.runInContext('_settingsRenderOrkasApiCard()', context);
    expect(status.textContent).toBe('');
  });
});
