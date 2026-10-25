// Open-source-driven · new-chat Quick task entry + shared helpers for the
// marketplace「开源项目」专区.
//
// Data is the curated catalog served by `marketplace.listProjects` (config-as-
// code on the Server — see PC/docs/plans/oss-driven.md). Marketplace listings
// use the cache layer below, keyed by category/search options.
//
// The new-chat entry opens the marketplace's Open Source page in the current
// content surface. Marketplace owns the return stack, so Back returns directly
// to New Task without switching the selected sidebar tab.

const _ossLog = createLogger('oss');

// category code → centralized ui-icon name (icons.js). We deliberately do NOT
// render the unicode project glyph as an icon (CLAUDE.md: icons go through the
// icon module).
// Keyed by the OSS category codes the Server actually serves (see
// oss_catalog_mgr.py::DEFAULT_OSS_CATEGORIES + conf/marketplace/oss_projects.json).
// Unknown codes fall back to 'sparkles', so keep this in sync when a category is
// added Server-side (office/slides are first-party curated categories).
const _OSS_CAT_ICON = {
  anim: 'sparkles',
  browser: 'globe',
  office: 'file-text',
  slides: 'presentation',
};
function ossIconFor(cat) { return _OSS_CAT_ICON[cat] || 'sparkles'; }

function _ossNormalizeCatalogOpts(forceOrOpts) {
  if (typeof forceOrOpts === 'boolean') return { force: forceOrOpts };
  const raw = forceOrOpts && typeof forceOrOpts === 'object' ? forceOrOpts : {};
  const size = Number(raw.size);
  const revalidate = raw.revalidate === 'always' || raw.revalidate === 'cold-start'
    ? raw.revalidate
    : raw.revalidate !== false;
  return {
    homeOnly: raw.homeOnly === true || raw.home_only === true,
    category: String(raw.category || '').trim(),
    q: String(raw.q || '').trim(),
    ...(Number.isFinite(size) && size > 0 ? { size: Math.min(100, Math.max(1, Math.floor(size))) } : {}),
    force: raw.force === true,
    revalidate,
  };
}

function ossCatalogCacheKey(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  return [
    'project',
    opts.homeOnly ? 'home' : 'all',
    opts.category || '',
    opts.q || '',
    opts.size || '',
  ].join('|');
}

async function loadOssCatalog(forceOrOpts) {
  const opts = _ossNormalizeCatalogOpts(forceOrOpts);
  const result = await window.orkas.invoke('marketplace.listProjects', {
    home_only: opts.homeOnly,
    category: opts.category,
    q: opts.q,
    ...(typeof opts.size === 'number' ? { size: opts.size } : {}),
  });
  return {
    projects: result.list,
    categories: result.categories,
    total: result.total,
    sourceType: 'bundled',
    ts: 0,
  };
}

function _ossLang() { return (typeof getLang === 'function' ? getLang() : 'en'); }
function ossTaskFor(p) { return (_ossLang() === 'zh' ? p.task_zh : p.task_en) || p.task_en || p.task_zh || ''; }
function ossDescFor(p) { return p['description_' + _ossLang()] || p.description_en || p.description_zh || ''; }
function ossCatLabel(cat, categories) {
  const c = (categories || []).find((x) => x.code === cat);
  if (!c) return cat || '';
  return (typeof pickLocalizedName === 'function' ? pickLocalizedName(c, _ossLang()) : (c['name_' + _ossLang()] || c.name_en)) || c.code;
}

// Reusable driver badge (② only): install=box/blue · cli=terminal/violet ·
// mcp=plug/emerald. The colors live in CSS (.driver-badge--<driver>).
function ossDriverBadgeHtml(driver) {
  const map = { install: ['box', 'driver.install'], cli: ['terminal', 'driver.cli'], mcp: ['plug', 'driver.mcp'] };
  const m = map[driver];
  if (!m) return '';
  const label = (typeof t === 'function') ? t(m[1]) : m[1];
  return `<span class="driver-badge driver-badge--${escapeHtml(driver)}">${uiIconHtml(m[0], 'driver-badge-icon')}<span>${escapeHtml(label)}</span></span>`;
}

function ossGithubUrl(p) { return (p && p.repo) ? ('https://github.com/' + p.repo) : ''; }

function ossRepoInstallKey(repoOrUrl) {
  const raw = String(repoOrUrl || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/^git\+/i, '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
  return normalized ? `repo:${normalized}` : '';
}

// Prompt for ① capability cards: NAMES the project + URL, leaves the user's
// concrete task blank (a `[...]` placeholder the caret lands on), and tells the
// Commander to use the project. OfficeCLI is special: it is also the bundled
// Office engine, so point the model at built-in Office tools instead of install.
function ossPromptFor(p) {
  const isOfficeCli = p && (p.id === 'OfficeCLI' || p.name === 'OfficeCLI');
  const tmpl = (typeof t === 'function') ? t(isOfficeCli ? 'oss.office_prompt' : 'oss.prompt') : '';
  return tmpl
    .replace(/\{id\}/g, (p && p.id) || '')
    .replace(/\{name\}/g, (p && p.name) || '')
    .replace(/\{url\}/g, ossGithubUrl(p));
}

// Prompt for the ② marketplace「接入」button: an explicit install request (the
// button only shows for NOT-yet-installed packages, and there is no user task
// here). OfficeCLI is already bundled, so its marketplace action explains the
// built-in Office tools instead of asking for install.
function ossInstallPromptFor(p) {
  const isOfficeCli = p && (p.id === 'OfficeCLI' || p.name === 'OfficeCLI');
  const tmpl = (typeof t === 'function') ? t(isOfficeCli ? 'oss.office_install_prompt' : 'oss.install_prompt') : '';
  return tmpl
    .replace(/\{id\}/g, (p && p.id) || '')
    .replace(/\{name\}/g, (p && p.name) || '')
    .replace(/\{url\}/g, ossGithubUrl(p));
}

// Installed external packages (local/packages). Memoized; a row's `name`
// matches an OSS project `id` when the user already has it. Errors → empty set
// (everything shows as "接入"), and the memo is cleared so a later open retries.
let _ossInstalledPromise = null;
function loadOssInstalled(force) {
  if (force) _ossInstalledPromise = null;
  if (!_ossInstalledPromise) {
    _ossInstalledPromise = window.orkas.invoke('packages.list')
      .then((res) => {
        const keys = new Set();
        for (const p of (res && res.ok && Array.isArray(res.packages) ? res.packages : [])) {
          if (p && p.name) keys.add(String(p.name));
          const repoKey = ossRepoInstallKey(p && p.repo_url);
          if (repoKey) keys.add(repoKey);
        }
        return keys;
      })
      .catch(() => { _ossInstalledPromise = null; return new Set(); });
  }
  return _ossInstalledPromise;
}

function isOssProjectInstalled(p, installed) {
  if (!(installed instanceof Set) || !p) return false;
  return installed.has(p.id) || installed.has(ossRepoInstallKey(p.repo));
}

// Open the project's GitHub page in the system browser.
function ossOpenRepo(p) {
  const url = ossGithubUrl(p);
  if (url && window.orkas) window.orkas.invoke('auth.openExternal', { url }).catch(() => {});
}

// ③ behavior — prefill the Commander composer, focus, NO send. The caret lands
// on the first `[...]` placeholder (the blank task slot) when present, so the
// user types their specific task over it; otherwise it goes to the end.
function prefillCommander(text, opts = {}) {
  const value = String(text || '');
  if (!value) return false;
  if (typeof setView === 'function') setView('new-chat');
  if (typeof setChatRecipient === 'function') setChatRecipient('new-chat', { kind: 'commander' });
  const input = document.getElementById('new-chat-input');
  if (!input) {
    _ossLog.warn('Commander OSS prefill failed: composer missing');
    return false;
  }
  composerSetText(input, value);
  input.dataset.ossTemplateDraft = '1';
  const m = opts.trackPlaceholder === false ? null : value.match(/\[[^\]]*\]/);
  if (m) input.dataset.ossTemplatePlaceholder = m[0];
  else delete input.dataset.ossTemplatePlaceholder;
  input.focus();
  try {
    if (m && typeof m.index === 'number') composerSetSelection(input, m.index, m.index + m[0].length);
    else composerSetSelection(input, value.length, value.length);
  } catch (_e) { /* selection unsupported */ }
  composerNotify(input); // triggers autoGrow + chip state
  input.classList.add('is-prefilled');
  setTimeout(() => input.classList.remove('is-prefilled'), 1200);
  return true;
}

/**
 * Return the exact placeholder inserted by prefillCommander when the user has
 * not replaced it yet. Ordinary bracketed text is never inspected unless this
 * renderer-owned marker exists, so code/prompts containing `[value]` are safe.
 */
function unresolvedOssTemplatePlaceholder(input) {
  if (!input || !input.dataset) return '';
  const marker = String(input.dataset.ossTemplatePlaceholder || '');
  if (!marker) return '';
  const value = String(composerText(input) || '');
  if (!value.includes(marker)) {
    delete input.dataset.ossTemplatePlaceholder;
    return '';
  }
  const start = value.indexOf(marker);
  input.focus();
  try { composerSetSelection(input, start, start + marker.length); } catch (_) { /* unsupported */ }
  return marker;
}

// Shared helper retained for tool-specific task prompts outside the home rail.
// It preserves a manual or Quick start draft and avoids nesting OSS wrappers.
function _ossPromptForComposer(p, input) {
  const prompt = ossPromptFor(p);
  const existing = String((input && composerText(input)) || '').trim();
  const existingOssDraft = input?.dataset?.ossTemplateDraft === '1';
  if (!existing || existingOssDraft) return prompt;
  if (/\[[^\]]*\]/.test(prompt)) return prompt.replace(/\[[^\]]*\]/, () => existing);
  return `${prompt}\n\n${existing}`;
}

// Exposed for marketplace rendering.
window.loadOssCatalog = loadOssCatalog;
window.ossCatalogCacheKey = ossCatalogCacheKey;
window.OSS_MARKETPLACE_PAGE_SIZE = OSS_MARKETPLACE_PAGE_SIZE;
window.loadOssInstalled = loadOssInstalled;
window.isOssProjectInstalled = isOssProjectInstalled;
window.ossIconFor = ossIconFor;
window.ossTaskFor = ossTaskFor;
window.ossDescFor = ossDescFor;
window.ossCatLabel = ossCatLabel;
window.ossDriverBadgeHtml = ossDriverBadgeHtml;
window.ossGithubUrl = ossGithubUrl;
window.ossPromptFor = ossPromptFor;
window.ossInstallPromptFor = ossInstallPromptFor;
window.ossOpenRepo = ossOpenRepo;
window.prefillCommander = prefillCommander;
window.unresolvedOssTemplatePlaceholder = unresolvedOssTemplatePlaceholder;
