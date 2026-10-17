// Sidebar task sections persist local collapse preferences. The navigation
// entries above them are a flat, always-visible list; collapse values stored for
// the retired navigation groups are ignored and dropped on the next write.
(function () {
  const STORAGE_KEY = 'sidebar.sectionCollapsed';
  const SECTION_CONFIG = [
    {
      name: 'today',
      sectionSelector: '.sidebar-today-section',
      toggleId: 'today-section-toggle',
      bodyId: 'today-list',
      labelKey: 'sidebar.today_tasks',
    },
    {
      name: 'projects',
      sectionSelector: '.sidebar-projects-section',
      toggleId: 'projects-section-toggle',
      bodyId: 'projects-list',
      labelKey: 'sidebar.projects',
    },
    {
      name: 'tasks',
      sectionSelector: '.sidebar-conversations-section',
      toggleId: 'tasks-section-toggle',
      bodyId: 'conversation-list',
      labelKey: 'sidebar.conversations',
    },
  ];

  function readCollapsedState(storage) {
    let parsed = {};
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) parsed = saved;
    } catch (_) {}
    return Object.fromEntries(
      SECTION_CONFIG.map(({ name, defaultCollapsed }) => [
        name, typeof parsed[name] === 'boolean' ? parsed[name] : defaultCollapsed === true,
      ]),
    );
  }

  function writeCollapsedState(storage, state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function applySectionState(doc, config, collapsed, translate) {
    const section = doc.querySelector(config.sectionSelector);
    const toggle = doc.getElementById(config.toggleId);
    const body = doc.getElementById(config.bodyId);
    if (!section || !toggle || !body) return;

    section.classList.toggle('is-collapsed', collapsed);
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const sectionLabel = translate(config.labelKey);
    toggle.setAttribute(
      'aria-label',
      translate(collapsed ? 'sidebar.section_expand' : 'sidebar.section_collapse', { section: sectionLabel }),
    );
  }

  function initSidebarSections(doc, storage, translate, onToggle) {
    const state = readCollapsedState(storage);
    const applyAll = () => SECTION_CONFIG.forEach((config) => {
      applySectionState(doc, config, state[config.name] === true, translate);
    });

    SECTION_CONFIG.forEach((config) => {
      const toggle = doc.getElementById(config.toggleId);
      if (!toggle || toggle.dataset.sectionCollapseBound === '1') return;
      toggle.dataset.sectionCollapseBound = '1';
      toggle.addEventListener('click', () => {
        state[config.name] = state[config.name] !== true;
        writeCollapsedState(storage, state);
        applySectionState(doc, config, state[config.name], translate);
        if (typeof onToggle === 'function') {
          onToggle({ name: config.name, collapsed: state[config.name] });
        }
      });
    });
    applyAll();
    return { state, applyAll };
  }

  function start() {
    const controller = initSidebarSections(
      document,
      localStorage,
      (key, params) => t(key, params),
      (detail) => {
        window.dispatchEvent(new CustomEvent('sidebar-section-toggle', { detail }));
      },
    );
    window.addEventListener('i18n-change', controller.applyAll);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY,
      SECTION_CONFIG,
      readCollapsedState,
      applySectionState,
      initSidebarSections,
    };
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
