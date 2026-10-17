import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (name: string) => readFileSync(join(__dirname, `../../src/renderer/modules/${name}.js`), 'utf8');

function mount({ cached = true, collapsed = false, previous = '' } = {}) {
  const scrolled: string[] = [];
  const nodes = new Map<string, any>();
  const deferred: Array<() => void> = [];
  const featureLoads: Array<() => void> = [];
  const projects = ['alpha', 'beta'].map(project_id => ({ project_id, name: project_id }));
  const node = () => ({
    innerHTML: '', textContent: '', hidden: false, dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    getAttribute(key: string) { return this.attributes[key]; },
    querySelector: (_selector: string): any => null,
    querySelectorAll: (_selector: string): any[] => [],
    addEventListener() {},
  });
  for (const id of ['panel-project', 'panel-settings', 'new-chat-btn', 'agents-btn', 'skills-btn',
    'project-detail-title', 'project-detail-content', 'projects-list', 'projects-section-toggle']) {
    nodes.set(id, node());
  }
  const list = nodes.get('projects-list');
  const toggle = nodes.get('projects-section-toggle');
  toggle.attributes['aria-expanded'] = String(!collapsed);
  list.hidden = collapsed;
  toggle.click = vi.fn(() => {
    list.hidden = !list.hidden;
    toggle.attributes['aria-expanded'] = String(!list.hidden);
  });
  list.querySelector = (selector: string) => {
    if (selector !== '.project-row.active') return null;
    const id = /class="project-row active" data-pid="([^"]+)"/.exec(list.innerHTML)?.[1];
    return id ? { scrollIntoView: () => scrolled.push(id) } : null;
  };
  const loadProjectDetail = vi.fn();
  const context: any = {
    currentView: 'settings', currentCid: null, conversations: [], _projectDetailPid: previous,
    _composerNavigationEpoch: 0, composerBindOwner() {}, _saveLastView() {},
    _bootLog: { info() {}, warn() {} }, createLogger: () => ({ info() {}, warn() {} }),
    _clearLazyFeatureError() {}, _showLazyFeatureError() {},
    setTimeout: () => 0, clearTimeout() {}, t: String, escapeHtml: String,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      addEventListener() {}, getElementById: (id: string) => nodes.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    addEventListener() {},
    orkas: { invoke: vi.fn(async () => ({ ok: true, projects })) },
    _deferSidebarNavWork: (_key: string, run: () => void) => deferred.push(run),
    loadRendererFeature: () => new Promise<void>(resolve => featureLoads.push(resolve)),
    loadProjectDetail,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source('projects'), context);
  const boot = source('boot');
  vm.runInContext(boot.slice(boot.indexOf('function _loadViewFeature('), boot.indexOf('function _lazyFeaturePanel(')), context);
  vm.runInContext(boot.slice(boot.indexOf('function setView(')), context);
  if (cached) vm.runInContext(`_projectsCache = ${JSON.stringify(projects)}`, context);
  const selected = () => [...list.innerHTML.matchAll(/class="project-row active" data-pid="([^"]+)"/g)]
    .map(match => match[1]);
  return { context, list, toggle, scrolled, selected, deferred, featureLoads, loadProjectDetail };
}

describe('project navigation follows the destination in the sidebar', () => {
  it.each(['', 'alpha'])('selects and reveals the target before detail loading, with previous detail %j', previous => {
    const h = mount({ previous, collapsed: true });
    h.context.setView('project', 'beta');
    expect(h.selected()).toEqual(['beta']);
    expect(h.list.hidden).toBe(false);
    expect(h.scrolled).toEqual(['beta']);
    expect(h.loadProjectDetail).not.toHaveBeenCalled();

    // Manual collapse and scrolling after entry win over background renders.
    h.toggle.click();
    h.context.renderProjectsSection();
    expect(h.list.hidden).toBe(true);
    expect(h.scrolled).toEqual(['beta']);
    h.context.setView('settings');
    expect(h.selected()).toEqual([]);
  });

  it('reveals a cold-start target once the project list arrives', async () => {
    const h = mount({ cached: false, collapsed: true });
    h.context.setView('project', 'beta');
    expect(h.scrolled).toEqual([]);
    await h.context.loadProjects();
    expect(h.selected()).toEqual(['beta']);
    expect(h.list.hidden).toBe(false);
    expect(h.scrolled).toEqual(['beta']);
    await h.context.loadProjects(true);
    expect(h.scrolled).toEqual(['beta']);
  });

  it('does not reveal a late project list after navigating away', async () => {
    const h = mount({ cached: false, collapsed: true });
    h.context.setView('project', 'beta');
    h.context.setView('settings');
    await h.context.loadProjects();
    expect(h.selected()).toEqual([]);
    expect(h.list.hidden).toBe(true);
    expect(h.scrolled).toEqual([]);
  });

  it('ignores the old deferred detail when switching projects during feature loading', async () => {
    const h = mount();
    h.context.setView('project', 'alpha');
    h.deferred.shift()!();
    h.context.setView('project', 'beta');
    h.deferred.shift()!();
    expect(h.selected()).toEqual(['beta']);
    h.featureLoads[1]();
    await new Promise(resolve => setImmediate(resolve));
    h.featureLoads[0]();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.loadProjectDetail.mock.calls.map(([pid]) => pid)).toEqual(['beta']);
    expect(h.selected()).toEqual(['beta']);
    expect(h.scrolled).toEqual(['alpha', 'beta']);
  });
});
