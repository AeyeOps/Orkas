import { expect, OrkasTestApp, test } from './fixtures/orkas';

const NAV_ORDER = [
  ['new-chat', 'new-chat', '新任务'],
  ['todos', 'todos', '待办'],
  ['auto', 'auto', '自动化'],
  ['agents', 'agents', 'AI 团队'],
  ['skills', 'skills', '技能库'],
  ['connectors', 'connectors', '连接器'],
  ['contexts', 'contexts', '资料库'],
  ['apps', 'apps', '应用'],
];

test('shows every navigation entry in the release 1.8.0 order and opens each destination', async ({}, info) => {
  const app = new OrkasTestApp(info, { marketplaceStub: true, seedLanguage: 'zh' });
  try {
    await app.launch();
    const page = app.page!;
    await page.setViewportSize({ width: 1100, height: 740 });
    // The retired 日常运营 / 能力资源 groups leave no toggles behind.
    await expect(page.locator('#operations-section-toggle, #capabilities-section-toggle')).toHaveCount(0);
    const ids = await page.locator('.sidebar-actions > .sidebar-btn').evaluateAll(
      (buttons) => buttons.map((button) => button.id),
    );
    expect(ids).toEqual(NAV_ORDER.map(([entry]) => `${entry}-btn`));
    for (const [entry, , label] of NAV_ORDER) {
      const button = page.locator(`#${entry}-btn`);
      await expect(button).toBeVisible();
      await expect(button.locator('[data-i18n]').first()).toHaveText(label);
    }
    await page.screenshot({ path: info.outputPath('sidebar-flat-navigation.png') });

    for (const [entry, panel] of NAV_ORDER.slice(1)) {
      await page.locator(`#${entry}-btn`).click();
      await expect(page.locator(`#panel-${panel}`)).toBeVisible();
      await expect(page.locator(`#${entry}-btn`)).toHaveClass(/\bactive\b/);
    }
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#panel-new-chat')).toBeVisible();
    await expect(page.locator('#new-chat-btn')).toHaveClass(/\bactive\b/);
  } finally {
    await app.dispose();
  }
});

test('ignores retired navigation-group preferences across real Electron relaunches without resetting task sections', async ({}, info) => {
  const app = new OrkasTestApp(info, { seedLanguage: 'zh' });
  try {
    await app.launch();
    let page = app.page!;
    // An upgraded installation still stores collapsed navigation groups.
    await page.evaluate(() => localStorage.setItem('sidebar.sectionCollapsed', JSON.stringify({
      operations: true, capabilities: true, today: true, projects: false, tasks: true,
    })));
    page = await app.relaunch();
    for (const [entry] of NAV_ORDER) await expect(page.locator(`#${entry}-btn`)).toBeVisible();
    await expect(page.locator('#today-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#tasks-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#projects-section-toggle')).toHaveAttribute('aria-expanded', 'true');

    await page.locator('#projects-section-toggle').click();
    await expect(page.locator('#projects-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sidebar.sectionCollapsed') || '{}'));
    expect(stored).toEqual({ today: true, projects: true, tasks: true });

    page = await app.relaunch();
    await expect(page.locator('#projects-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#today-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#auto-btn')).toBeVisible();
  } finally {
    await app.dispose();
  }
});
