import { describe, it, expect } from 'vitest';

const {
  STORAGE_KEY,
  readCollapsedState,
  initSidebarSections,
} = require('../../src/renderer/modules/sidebar-sections.js');

function createClassList() {
  const values = new Set<string>();
  return {
    toggle(name: string, enabled: boolean) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    contains(name: string) {
      return values.has(name);
    },
  };
}

function createElement() {
  const listeners: Record<string, Function> = {};
  const attributes: Record<string, string> = {};
  return {
    hidden: false,
    dataset: {} as Record<string, string>,
    classList: createClassList(),
    addEventListener(type: string, listener: Function) {
      listeners[type] = listener;
    },
    click() {
      listeners.click?.();
    },
    setAttribute(name: string, value: string) {
      attributes[name] = value;
    },
    getAttribute(name: string) {
      return attributes[name];
    },
  };
}

function createHarness(initialState: unknown = {}) {
  const todaySection = createElement();
  const projectsSection = createElement();
  const tasksSection = createElement();
  const todayToggle = createElement();
  const projectsToggle = createElement();
  const tasksToggle = createElement();
  const todayBody = createElement();
  const projectsBody = createElement();
  const tasksBody = createElement();
  const values = new Map<string, string>([
    [STORAGE_KEY, JSON.stringify(initialState)],
  ]);
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const byId: Record<string, any> = {
    'today-section-toggle': todayToggle,
    'projects-section-toggle': projectsToggle,
    'tasks-section-toggle': tasksToggle,
    'today-list': todayBody,
    'projects-list': projectsBody,
    'conversation-list': tasksBody,
  };
  const document = {
    getElementById(id: string) {
      return byId[id] ?? null;
    },
    querySelector(selector: string) {
      if (selector === '.sidebar-today-section') return todaySection;
      if (selector === '.sidebar-projects-section') return projectsSection;
      if (selector === '.sidebar-conversations-section') return tasksSection;
      return null;
    },
  };
  const translate = (key: string, params?: { section?: string }) => {
    if (key === 'sidebar.today_tasks') return "Today's Tasks";
    if (key === 'sidebar.projects') return 'Projects';
    if (key === 'sidebar.conversations') return 'Tasks';
    if (key === 'sidebar.section_collapse') return `Collapse ${params?.section}`;
    if (key === 'sidebar.section_expand') return `Expand ${params?.section}`;
    return key;
  };
  return {
    document,
    storage,
    values,
    todaySection,
    projectsSection,
    tasksSection,
    todayToggle,
    projectsToggle,
    tasksToggle,
    todayBody,
    projectsBody,
    tasksBody,
    translate,
  };
}

describe('sidebar top-level section collapse', () => {
  it('restores Today, Projects and Tasks independently with accessible toggle state', () => {
    // State persisted before the Today section existed carries no `today`
    // key; the new section must open, not inherit a neighbour's state.
    const harness = createHarness({ projects: true, tasks: false });

    initSidebarSections(harness.document, harness.storage, harness.translate);

    expect(harness.todayBody.hidden).toBe(false);
    expect(harness.todaySection.classList.contains('is-collapsed')).toBe(false);
    expect(harness.todayToggle.getAttribute('aria-expanded')).toBe('true');
    expect(harness.todayToggle.getAttribute('aria-label')).toBe("Collapse Today's Tasks");
    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(false);
    expect(harness.projectsSection.classList.contains('is-collapsed')).toBe(true);
    expect(harness.tasksSection.classList.contains('is-collapsed')).toBe(false);
    expect(harness.projectsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(harness.projectsToggle.getAttribute('aria-label')).toBe('Expand Projects');
    expect(harness.tasksToggle.getAttribute('aria-expanded')).toBe('true');
    expect(harness.tasksToggle.getAttribute('aria-label')).toBe('Collapse Tasks');
  });

  it('persists a toggle without changing the other section', () => {
    const harness = createHarness({ projects: false, tasks: true });
    initSidebarSections(harness.document, harness.storage, harness.translate);

    harness.projectsToggle.click();

    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(true);
    expect(harness.todayBody.hidden).toBe(false);
    expect(JSON.parse(harness.values.get(STORAGE_KEY) || '{}')).toEqual({
      today: false,
      projects: true,
      tasks: true,
    });

    harness.todayToggle.click();

    expect(harness.todayBody.hidden).toBe(true);
    expect(harness.projectsBody.hidden).toBe(true);
    expect(JSON.parse(harness.values.get(STORAGE_KEY) || '{}')).toEqual({
      today: true,
      projects: true,
      tasks: true,
    });
  });

  it('reports a section reopen so its list can reset to the first page', () => {
    const harness = createHarness({ projects: false, tasks: true });
    const toggles: Array<{ name: string; collapsed: boolean }> = [];
    initSidebarSections(harness.document, harness.storage, harness.translate, (detail: any) => {
      toggles.push(detail);
    });

    harness.tasksToggle.click();

    expect(toggles).toEqual([{ name: 'tasks', collapsed: false }]);
    expect(harness.tasksBody.hidden).toBe(false);
  });

  it('treats corrupt or non-boolean stored values as expanded', () => {
    const storage = { getItem: () => '{bad json', setItem() {} };
    expect(readCollapsedState(storage)).toEqual({ today: false, projects: false, tasks: false });

    const harness = createHarness({ today: 'yes', projects: 'true', tasks: 1 });
    initSidebarSections(harness.document, harness.storage, harness.translate);

    expect(harness.todayBody.hidden).toBe(false);
    expect(harness.projectsBody.hidden).toBe(false);
    expect(harness.tasksBody.hidden).toBe(false);
  });
});

describe('sidebar section preferences after the navigation groups were retired', () => {
  it('ignores and drops collapse values stored for the retired navigation groups', () => {
    // An upgraded installation still carries the old group keys; they must
    // neither leak into task-section state nor survive the next write.
    const harness = createHarness({ operations: false, capabilities: true, projects: true });
    initSidebarSections(harness.document, harness.storage, harness.translate);

    expect(harness.todayBody.hidden).toBe(false);
    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(false);

    harness.tasksToggle.click();

    expect(JSON.parse(harness.values.get(STORAGE_KEY)!)).toEqual({ today: false, projects: true, tasks: true });
  });

  it.each(['{bad json', 'null', '[]', '{"projects":"true","tasks":0}'])('recovers invalid storage %s to expanded sections and lets the first click collapse', (stored) => {
    const harness = createHarness();
    harness.values.set(STORAGE_KEY, stored);
    initSidebarSections(harness.document, harness.storage, harness.translate);
    expect(harness.projectsBody.hidden).toBe(false);
    harness.projectsToggle.click();
    expect(harness.projectsBody.hidden).toBe(true);
    expect(JSON.parse(harness.values.get(STORAGE_KEY)!)).toEqual({ today: false, projects: true, tasks: false });
  });

  it('keeps section toggles usable when local storage is unavailable', () => {
    const harness = createHarness();
    const blockedStorage = {
      getItem() { throw new Error('Storage unavailable'); },
      setItem() { throw new Error('Storage unavailable'); },
    };
    initSidebarSections(harness.document, blockedStorage, harness.translate);
    expect(harness.todayBody.hidden).toBe(false);
    harness.todayToggle.click();
    expect(harness.todayBody.hidden).toBe(true);
    harness.todayToggle.click();
    expect(harness.todayBody.hidden).toBe(false);
  });

  it('refreshes accessible labels after a language change without resetting user choices', () => {
    const harness = createHarness({ projects: true });
    let language = 'en';
    const translate = (key: string, params?: { section?: string }) => language === 'zh'
      ? ({ 'sidebar.projects': '项目', 'sidebar.conversations': '任务', 'sidebar.today_tasks': '当天任务',
        'sidebar.section_expand': `展开${params?.section}`, 'sidebar.section_collapse': `收起${params?.section}` } as Record<string, string>)[key] || key
      : harness.translate(key, params);
    const controller = initSidebarSections(harness.document, harness.storage, translate);
    language = 'zh';
    controller.applyAll();
    expect(harness.projectsToggle.getAttribute('aria-label')).toBe('展开项目');
    expect(harness.tasksToggle.getAttribute('aria-label')).toBe('收起任务');
    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(false);
  });
});
