import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('explains auto-advance on hover, click and keyboard without changing execution settings', async ({ modelOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const created = await orkas.invoke<any>('projects.create', { name: 'Auto-advance help' });
  const pid = created.project.project_id;
  const before = await orkas.invoke('projects.driver.get', { projectId: pid });
  await page.evaluate(async id => (window as any).setView('project', id), pid);
  await page.locator('[data-project-tab="todo"]').click();
  const hint = page.locator('.project-driver-hint');
  const tooltip = page.getByRole('tooltip');
  await hint.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('AI 自动处理待办，完成后由你确认。仅在开启开关的设备上执行。');
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await hint.click();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeVisible();
  await page.evaluate(() => (window as any).setLang('en'));
  await expect(tooltip).toContainText('Runs only on the device where you turn it on.');
  await page.evaluate(() => (window as any).setLang('zh'));
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await hint.blur();
  await hint.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(tooltip).toBeVisible();
  await page.locator('#project-detail-title').click();
  await expect(tooltip).toBeHidden();
  await hint.hover();
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await hint.click();
  await hint.click();
  await expect(tooltip).toBeHidden();
  await hint.blur();
  await page.mouse.move(0, 0);

  for (const [width, height, lang] of [[1440, 900, 'zh'], [1024, 720, 'en'], [1024, 720, 'ar']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(value => (window as any).setLang(value), lang);
    await hint.hover();
    await expect(tooltip).toBeVisible();
    if (lang === 'en') await expect(tooltip).toContainText('Runs only on the device where you turn it on.');
    const bounds = await tooltip.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: testInfo.outputPath(`auto-advance-help-${lang}-${width}.png`) });
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
  }
  await page.evaluate(() => (window as any).setLang('zh'));
  await hint.click();
  await page.locator('[data-project-tab="tasks"]').click();
  await expect(tooltip).toBeHidden();
  await page.locator('[data-project-tab="todo"]').click();
  await hint.click();
  await page.evaluate(() => (window as any).setView('new-chat'));
  await expect(tooltip).toBeHidden();
  expect(await orkas.invoke('projects.driver.get', { projectId: pid })).toEqual(before);
});

test('uses the same auto-advance switch and help in both account backlog views with one create entry', async ({ modelOrkas: orkas }, testInfo) => {
  const page = orkas.page!;
  await page.evaluate(() => (window as any).setLang('zh'));
  const created = await orkas.invoke<any>('projects.create', { name: 'A project with a longer name for wrapping' });
  const pid = created.project.project_id;
  await orkas.invoke('projects.tasks.create', { content: 'Completed account work', status: 'done' });
  await orkas.invoke('projects.tasks.create', { projectId: pid, content: 'Completed project work', status: 'done' });
  await openSidebarEntry(page, '#todos-btn');
  const content = page.locator('#todos-content');
  await content.locator('.todo-scope-chip[data-pid=""]').click();
  const toggle = content.locator('.todo-scope-driver-toggle[data-pid=""]');
  const hint = content.locator('.project-driver-hint').first();
  const tooltip = page.getByRole('tooltip');
  await expect(toggle.locator('.project-driver-switch')).toBeVisible();
  await expect(toggle).toHaveText('自动推进');
  await expect(content.locator('.todo-project-add')).toHaveCount(0);
  await expect(page.locator('#todos-add-btn')).toBeVisible();
  await hint.hover();
  await expect(tooltip).toHaveText('AI 自动处理待办，完成后由你确认。仅在开启开关的设备上执行。');
  await hint.click();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeVisible();
  expect((await orkas.invoke<any>('projects.driver.get', { projectId: '' })).config.enabled).toBe(false);
  await page.keyboard.press('Escape');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('自动推进 · 本机');
  expect((await orkas.invoke<any>('projects.driver.get', { projectId: pid })).config.enabled).toBe(false);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  for (const [mode, lang, width, height] of [
    ['project', 'zh', 1440, 900], ['status', 'en', 1024, 720], ['status', 'ar', 1024, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(value => (window as any).setLang(value), lang);
    await page.locator(`[data-todo-group="${mode}"]`).click();
    await expect(content.locator('.project-driver-switch')).toHaveCount(mode === 'status' ? 2 : 1);
    // Status grouping shares one hint after its Auto-advance label.
    await expect(content.locator('.project-driver-hint')).toHaveCount(1);
    if (mode === 'status') {
      await expect(content.locator('.todo-driver-bar-head .project-driver-hint')).toHaveCount(1);
    } else {
      await expect(content.locator('.todo-scope-row .todo-scope-actions .project-driver-hint')).toHaveCount(1);
    }
    if (lang === 'en') await expect(toggle).toHaveText('Global');
    if (lang === 'ar') await expect(toggle).toHaveText('عام');
    await hint.hover();
    await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`account-auto-help-${mode}-${lang}-${width}.png`) });
    await hint.click();
    // Keep the pointer off the replacement trigger, which may legitimately
    // show fresh hover help after the refresh removes the pinned anchor.
    await page.mouse.move(0, 0);
    await page.evaluate(() => (window as any)._refreshGlobalTodos(''));
    await expect(tooltip).toBeHidden();
    await expect(page.locator('.project-driver-tooltip')).toHaveCount(1);
  }
  await page.evaluate(() => (window as any).setLang('zh'));
  await page.locator('#todos-add-btn').click();
  await expect(page.locator('#project-todo-project')).toHaveAttribute('data-value', '');
  await expect(page.locator('#project-todo-project .ai-select-trigger')).toBeEnabled();
  await page.locator('#project-todo-cancel').click();
});
