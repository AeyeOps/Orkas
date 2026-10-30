import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMarketplace() {
  const users = await import('../../../src/main/features/users');
  users.activateUser('u_marketplace_projects');
  return import('../../../src/main/features/marketplace');
}

describe('marketplace projects catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps the bundled catalog self-consistent', () => {
    const bundled = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../../src/main/data/oss-projects.json'),
      'utf8',
    ));
    const categoryCodes = bundled.categories.map((category: any) => category.code);
    const projectIds = bundled.projects.map((project: any) => project.id);

    expect(new Set(categoryCodes).size).toBe(categoryCodes.length);
    expect(new Set(projectIds).size).toBe(projectIds.length);
    expect(bundled.categories.every((category: any) =>
      category.name_zh && category.name_en && Number.isFinite(category.sort_order)))
      .toBe(true);
    expect(bundled.projects.every((project: any) =>
      categoryCodes.includes(project.category)
      && project.repo
      && project.description_zh
      && project.description_en))
      .toBe(true);
  });

  it('uses bundled projects without contacting vendor services', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const marketplace = await loadMarketplace();
    const home = await marketplace.listMarketplaceProjects({ home_only: true });

    expect(home.list.map((p) => p.id)).toEqual(['hyperframes', 'ppt-master', 'OfficeCLI', 'Lark-CLI', 'crawl4ai']);
    expect(home.categories.map((c) => c.code)).toEqual(['anim', 'browser', 'office', 'slides']);
    expect(home.source).toBe('bundled');
    expect(home.stale).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies category, search, and pagination to the bundled catalog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const marketplace = await loadMarketplace();
    const browser = await marketplace.listMarketplaceProjects({ category: 'browser', q: '结构化', size: 1 });

    expect(browser.total).toBe(1);
    expect(browser.list).toHaveLength(1);
    expect(browser.list[0].id).toBe('crawl4ai');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches translated descriptions in the offline catalog', async () => {
    const marketplace = await loadMarketplace();
    for (const query of ['editable', 'modifiable', '편집 가능한', 'bearbeitbare', 'редактируемую', 'modificabile']) {
      const data = await marketplace.listMarketplaceProjects({ local_only: true, q: query });
      expect(data.list.map((p) => p.id), query).toContain('ppt-master');
    }
  });
});
