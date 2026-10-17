import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expectComposerText } from './fixtures/composer';
import { openSidebarEntry, expect, test } from './fixtures/orkas';
declare const currentCid: string;

function historicalArtifact(root: string, cid: string, appType?: string, title = 'Historic app') {
  const artifactId = 'historical-' + (appType || 'untyped');
  const dir = path.join(root, 'account-e2e/cloud/chat_artifacts', cid, artifactId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>Retained historical app</h1>');
  writeFileSync(path.join(dir, '__orkas-meta.json'), JSON.stringify({ title, appType, entry: 'index.html', agentId: 'commander' }));
  return { ok: true, artifactId, title };
}




test('root-level Save as app explains the separate-folder requirement and saves only the recovered bundle', async ({ orkas }, testInfo) => {
  const page=orkas.page!;
  const source=orkas.createWorkspaceFile('小工具.html','<!doctype html><html lang="zh"><meta charset="utf-8"><title>小工具</title><body><h1>小工具</h1><p>一个待保存的应用</p></body></html>');
  const privateFile=orkas.createWorkspaceFile('客户名单.csv','private fixture');
  expect(await orkas.invoke('savedApps.inspectBundleFromPath',{path:source})).toMatchObject({canSave:false,reason:'app_bundle_root'});
  expect(await orkas.invoke('savedApps.saveFromPath',{path:source})).toMatchObject({ok:false,error:'app_bundle_root'});
  const preview=await orkas.openPreview(()=>page.evaluate(file=>(window as any).openChatFileViewer(file,'小工具.html'),source));
  for(const [language,width,height] of [['zh',1080,720],['en',560,600]] as const){
    await preview.evaluate(language=>(window as any).setLang(language),language);
    await preview.setViewportSize({width,height});
    await preview.locator('.chat-file-viewer-save-app').click();
    const dialog=preview.getByRole('alertdialog');
    await expect(dialog).toContainText(language==='zh'?'独立文件夹':'separate folder');
    await expect(dialog).toContainText(language==='zh'?'再保存为应用':'save as an app again');
    expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await preview.screenshot({path:testInfo.outputPath(`root-save-${language}.png`)});
    await dialog.getByRole('button').click();
    await expect(dialog).toHaveCount(0);
  }
  expect((await orkas.invoke<any>('savedApps.list')).apps).toHaveLength(0);
  expect(readFileSync(privateFile,'utf8')).toBe('private fixture');
  await orkas.closePreview(preview);
  const entry=orkas.createWorkspaceFile('tool/index.html',readFileSync(source,'utf8'));
  const saved=await orkas.invoke<any>('savedApps.saveFromPath',{path:entry});expect(saved.ok).toBe(true);
  expect(saved.fileCount).toBe(1);
  const folder=path.join(orkas.workspaceRoot,'account-e2e/cloud/saved_apps',saved.id);
  expect(readdirSync(folder).sort()).toEqual(['__orkas-meta.json','index.html']);
  await openSidebarEntry(page,'#apps-btn');
  await expect(page.locator(`.app-card[data-app-id="${saved.id}"]`)).toBeVisible();
  expect(orkas.modelRequests).toHaveLength(0);
});

test('operates app actions by keyboard and restores focus after cancelling rename', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const entry = orkas.createWorkspaceFile('keyboard-app/index.html', '<h1>Keyboard app</h1>');
  const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: entry, title: 'Keyboard app' });
  await openSidebarEntry(page, '#apps-btn');
  const card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
  const more = card.locator('[data-app-more]');
  await card.focus();
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  const menu = page.locator('.app-row-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Edit', 'Publish', 'Delete']);
  await menu.screenshot({ path: testInfo.outputPath('local-menu-order.png') });
  await expect(menu.locator('.app-row-menu-item').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Publish', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.ui-dialog-overlay:visible');
  await expect(dialog.locator('input')).toHaveValue('Keyboard app');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  expect((await orkas.invoke<any>('savedApps.list')).apps).toEqual([expect.objectContaining({ id: saved.id, title: 'Keyboard app' })]);
  expect((await orkas.invoke<any>('conversations.list')).conversations).toHaveLength(0);
  expect(orkas.electronApp!.windows()).toHaveLength(1);
});

test('retains the focused app through refresh and dismisses a removed app menu', async ({ orkas }) => {
  const page = orkas.page!;
  const entry = orkas.createWorkspaceFile('refresh-app/index.html', '<h1>Refresh app</h1>');
  const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: entry, title: 'Refresh app' });
  await openSidebarEntry(page, '#apps-btn');
  const card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
  const more = card.locator('[data-app-more]');
  await card.focus();
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await page.evaluate(() => (window as any).loadSavedApps(true));
  await expect(more).toBeFocused();
  await more.click();
  await expect(page.locator('.app-row-menu')).toBeVisible();
  await page.keyboard.press('End');
  await page.evaluate(() => (window as any).loadSavedApps(true));
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await orkas.invoke('savedApps.delete', { appId: saved.id });
  await page.evaluate(() => (window as any).loadSavedApps(true));
  await expect(card).toHaveCount(0);
  await expect(page.locator('.app-row-menu')).toBeHidden();
  await expect(page.locator('#apps-empty')).toBeVisible();
  await expect(page.locator('#apps-create-btn')).toBeFocused();
});

function expectAppCreationContext(request: Record<string, unknown>) {
  const messages = request.messages as Array<{ role: string; content: unknown }>;
  const userContext = JSON.stringify(messages.filter(message => message.role === 'user'));
  const tools = request.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
  const artifacts = tools.filter(tool => tool.function.name === 'create_artifact');
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].function.parameters).toMatchObject({
    type: 'object', required: expect.arrayContaining(['files']), properties: { files: { type: 'array' } },
  });
  expect(userContext).toContain('## App creation');
  expect(userContext).toContain('workspace.artifact with tool_load');
  expect(userContext).toContain('call create_artifact');
  expect(JSON.stringify(messages.filter(message => message.role === 'system'))).not.toContain('## App creation');
}

test.describe('My Apps', () => {
  test('keeps a cancelled creation draft only for the current application session', async ({ orkas }, testInfo) => {
    let page = orkas.page!;
    await openSidebarEntry(page, '#apps-btn');
    await page.locator('#apps-create-btn').click();
    const panel = page.locator('.apps-create-panel');
    const draft = '家庭菜单与购物清单\nKeep this idea <b>as text</b>';
    await panel.locator('textarea').fill(draft);
    for (const dismissal of ['cancel', 'escape', 'backdrop']) {
      if (dismissal === 'cancel') await panel.locator('[data-create-cancel]').click();
      else if (dismissal === 'escape') await page.keyboard.press('Escape');
      else await page.locator('.apps-create-overlay').click({ position: { x: 5, y: 5 } });
      await expect(panel).toHaveCount(0);
      await expect(page.locator('#apps-create-btn')).toBeFocused();
      await page.locator('#apps-create-btn').click();
      await expect(panel.locator('textarea')).toHaveValue(draft);
      await expect(panel.locator('[data-app-type="local"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.locator('[data-create-submit]')).toBeEnabled();
    }
    await panel.screenshot({ path: testInfo.outputPath('retained-create-draft.png') });
    await panel.locator('[data-create-cancel]').click();
    expect(orkas.modelRequests).toHaveLength(0);
    page = await orkas.relaunch();
    await openSidebarEntry(page, '#apps-btn');
    await page.locator('#apps-create-btn').click();
    await expect(page.locator('.apps-create-panel textarea')).toHaveValue('');
    await expect(page.locator('[data-create-submit]')).toBeDisabled();
  });

  test('keeps type buttons anchored when counts change or disappear', async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    const entry = orkas.createWorkspaceFile('stable-header/index.html', '<h1>Local app</h1>');
    for (let i = 0; i < 10; i++) await orkas.invoke('savedApps.saveFromPath', { path: entry, title: `App ${i}` });
    await openSidebarEntry(page, '#apps-btn');
    await page.evaluate(() => (window as any).setLang('zh'));
    const tabs = page.locator('#apps-type-tabs');
    const count = page.locator('#apps-page-header-count');
    for (const width of [1133, 560]) {
      await page.setViewportSize({ width, height: 720 });
      await tabs.locator('[data-app-filter="local"]').click();
      await expect(count).toHaveText('10');
      await page.evaluate(() => (window as any).loadSavedApps(true));
      await expect(tabs.locator('[data-app-filter="local"]')).toBeFocused();
      const local = await tabs.boundingBox();
      await tabs.locator('[data-app-filter="web"]').click();
      await expect(page.locator('.ui-dialog-overlay.open').last()).toBeVisible();
      await page.locator('.ui-dialog-overlay.open').last().locator('[data-act="cancel"]').click();
      await expect(count).toHaveText('10');
      const cloud = await tabs.boundingBox();
      expect(Math.abs(cloud!.x - local!.x)).toBeLessThan(1);
      expect(Math.abs(cloud!.y - local!.y)).toBeLessThan(1);
      await tabs.locator('[data-app-filter="local"]').click();
      await expect(page.locator('.app-card')).toHaveCount(10);
      await expect(page.locator('#apps-type-description')).toHaveText('在 Orkas 桌面端运行，可使用 AI、文件、知识库和连接器等能力，不支持发布为网页。');
      const description = page.locator('#apps-type-description');
      const tabBox = (await tabs.boundingBox())!;
      const descriptionBox = (await description.boundingBox())!;
      expect(tabBox.height).toBe(32);
      const createHeight = (await page.locator('#apps-create-btn').boundingBox())!.height;
      expect(createHeight).toBe(28);
      for (const tab of await tabs.getByRole('tab').all()) {
        expect((await tab.boundingBox())!.height).toBe(createHeight);
      }
      expect(descriptionBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width);
      expect(Math.abs(descriptionBox.y + descriptionBox.height / 2 - tabBox.y - tabBox.height / 2)).toBeLessThan(1);
      if (width === 1133) expect((await page.locator('.apps-page-header').boundingBox())!.height).toBeLessThanOrEqual(60);
      await page.locator('.apps-page-header').screenshot({ path: testInfo.outputPath(`stable-header-${width}.png`) });
    }
  });

  test('keeps local cards and the creation draft when web guidance is cancelled across languages and sizes', async ({ orkas }, testInfo) => {
    const page = orkas.page!;
    const entry = orkas.createWorkspaceFile('described-app/index.html', '<head><meta name="description" content="Track orders &amp; stock"></head><h1>Inventory</h1>');
    await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Inventory' });
    await openSidebarEntry(page, '#apps-btn');
    await expect(page.locator('.app-card')).toHaveCount(1);
    await expect(page.locator('.app-card-description')).toHaveCount(0);
    for (const width of [1133, 560]) for (const language of ['en', 'zh']) {
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(language => (window as any).setLang(language), language);
      const tab = page.locator('[data-app-filter="web"]'); await tab.click();
      const dialog = page.locator('.ui-dialog-overlay.open').last();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(language === 'zh' ? '商业版' : 'commercial version');
      await dialog.locator('[data-act="cancel"]').click();
      await expect(page.locator('[data-app-filter="local"]')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.app-card')).toHaveCount(1);
      await page.locator('#apps-create-btn').click();
      const panel = page.locator('.apps-create-panel');
      await panel.locator('textarea').fill('Keep my draft');
      await panel.locator('[data-app-type="web"]').click();
      const guidance = page.locator('.ui-dialog-overlay.open').last();
      await expect(guidance).toContainText(language === 'zh' ? '商业版' : 'commercial version');
      await guidance.screenshot({ path: testInfo.outputPath(`web-guidance-${language}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(panel.locator('textarea')).toHaveValue('Keep my draft');
      await expect(panel.locator('[data-app-type="local"]')).toHaveAttribute('aria-pressed', 'true');
      await panel.locator('[data-create-cancel]').click();
      expect((await orkas.invoke<any>('conversations.list')).conversations).toHaveLength(0);
    }
    const refused = await orkas.invoke<any>('conversations.create', { title: 'Denied', assistance: { kind: 'app_creation', appType: 'web' } });
    expect(refused).toMatchObject({ ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' });
  });

  for (const existingTaskCount of [0, 2]) {
    test(`creates a separate task once with ${existingTaskCount} existing tasks`, async ({ modelOrkas: orkas }) => {
      const page = orkas.page!;
      orkas.setModelTextReplies(['APP_CREATE_ACK']);
      // Existing history must remain usable when a new app task is inserted
      // and sorted, before the first model request is sent.
      for (let i = 0; i < existingTaskCount; i += 1) {
        await orkas.invoke('conversations.create', { title: `Existing task ${i + 1}` });
      }
      await page.evaluate(() => (window as any).loadConversations());
      await expect(page.locator('#conversation-list .conv-item')).toHaveCount(existingTaskCount);
      await page.locator('.chat-rich-editor[data-rich-input-id="new-chat-input"]').fill('Unrelated home draft');
      await page.locator('#apps-btn').click();
      const opener = page.locator('#apps-create-btn');
      await opener.click();
      const panel = page.getByRole('dialog', { name: 'Create app', exact: true });
      const idea = panel.getByRole('textbox', { name: 'Describe your idea' });
      const submit = panel.getByRole('button', { name: 'Create', exact: true });
      const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
      await expect(panel.locator('[data-app-template]')).toHaveCount(4);
      await expect(panel).not.toContainText('Next:');
      await expect(idea).toBeFocused();
      await idea.fill('   ');
      await expect(submit).toBeDisabled();
      await page.keyboard.press('Shift+Tab');
      await expect(panel.locator('[data-app-type=web]')).toBeFocused();
      await idea.focus();
      await idea.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      for (const [id, topic] of [
        ['products', /product inventory/i], ['converter', /unit converter/i],
        ['flashcards', /vocabulary flashcard/i], ['game', /snake game/i],
      ] as const) {
        await panel.locator(`[data-app-template="${id}"]`).click();
        await expect(idea).toHaveValue(topic);
        await expect(idea).toBeFocused();
      }
      expect(orkas.modelRequests).toHaveLength(0);
      await cancel.click();
      await expect(opener).toBeFocused();
      await opener.click();
      await expect(panel.locator('[data-app-type=local]')).toHaveAttribute('aria-pressed', 'true');
      await expect(idea).toHaveValue(/snake game/i);
      await idea.fill('Create an app to plan family meals');
      await idea.press('Enter');
      await idea.pressSequentially('Include a shopping list');
      const prompt = await idea.inputValue();
      expect(prompt).toContain('\n');
      // Two synchronous clicks cover a fast repeat before IPC returns.
      await submit.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
      await expect(panel).toHaveCount(0);
      await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
      await expect(page.locator('#chat-header .chat-app-type-tag')).toHaveCount(0);
      await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
      await expect(page.locator('#chat-history .chat-message.user')).toContainText(prompt);
      await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', { hasText: 'APP_CREATE_ACK' })).toBeVisible({ timeout: 20_000 });
      expect(orkas.modelRequests).toHaveLength(1);
      expectAppCreationContext(orkas.modelRequests[0]);
      await expect(page.locator('#chat-history .chat-message.user')).not.toContainText('## App creation');
      const listed = await orkas.invoke<{ conversations: unknown[] }>('conversations.list');
      expect(listed.conversations).toHaveLength(existingTaskCount + 1);
      expect(listed.conversations.filter((conversation: any) => conversation.assistance?.kind === 'app_creation')).toHaveLength(1);
      expect((listed.conversations.find((conversation:any)=>conversation.assistance?.kind==='app_creation') as any).assistance.appType).toBe('local');
      await expect(page.locator('#conversation-list .conv-item')).toHaveCount(existingTaskCount + 1);
      await expect(page.locator('#conversation-list .conv-item').first()).toHaveClass(/\bactive\b/);
      for (let i = 0; i < existingTaskCount; i += 1) {
        await expect(page.locator('#conversation-list')).toContainText(`Existing task ${i + 1}`);
      }
      expect(JSON.stringify(orkas.modelRequests)).not.toContain('Unrelated home draft');
      await page.locator('#new-chat-btn').click();
      await expectComposerText(page.locator('#new-chat-input'), 'Unrelated home draft');
    });
  }

  test('keeps the description in the new task when sending is rejected and supports retry', async ({ modelOrkas: orkas }) => {
    const page = orkas.page!;
    orkas.setModelTextReplies(['APP_RETRY_ACK']);
    await openSidebarEntry(page, '#apps-btn');
    await page.locator('#apps-create-btn').click();
    const panel = page.locator('.apps-create-panel');
    await panel.locator('[data-app-template="products"]').click();
    const description = await panel.locator('textarea').inputValue();
    await page.evaluate(() => {
      const w = window as any;
      w.__createRecoveryNotifications = [];
      window.addEventListener('error', event => {
        w.__createRecoveryNotifications.push({ message: event.message, hasException: event.error != null });
      });
      const fetch = w.apiFetch;
      w.apiFetch = (...args: any[]) => {
        if (String(args[0]).endsWith('/send/stream')) {
          w.apiFetch = fetch;
          return Promise.resolve({ ok: false, status: 503 });
        }
        return fetch(...args);
      };
    });
    await panel.locator('[data-create-submit]').click();
    const alert = page.locator('.ui-dialog-overlay:visible').last();
    await expect(alert).toContainText('Could not start app creation');
    await alert.locator('[data-act="ok"]').click();
    await expectComposerText(page.locator('#chat-input'), description);
    expect(orkas.modelRequests).toHaveLength(0);
    expect((await orkas.invoke<{ conversations: unknown[] }>('conversations.list')).conversations).toHaveLength(1);
    await page.locator('#chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]', { hasText: 'APP_RETRY_ACK' })).toBeVisible({ timeout: 20_000 });
    expect((await orkas.invoke<{ conversations: unknown[] }>('conversations.list')).conversations).toHaveLength(1);
    expect(orkas.modelRequests).toHaveLength(1);
    expectAppCreationContext(orkas.modelRequests[0]);
    await expect(page.locator('#chat-history .chat-message.user')).not.toContainText('## App creation');
    // Composer resize delivery notices also occur in the pre-existing edit
    // flow. Keep them visible, reject exceptions, and verify recovery above.
    for (const notification of await page.evaluate(() => (window as any).__createRecoveryNotifications)) {
      expect(notification).toEqual({ message: 'ResizeObserver loop completed with undelivered notifications.', hasException: false });
    }
  });

  test('keeps cards and the idea draft usable across sizes and languages', async ({ modelOrkas: orkas }, testInfo) => {
    const page = orkas.page!;
    const entry = orkas.createWorkspaceFile('app-gallery/index.html', '<!doctype html><h1>My app</h1>');
    for (const title of ['Orkas · SDK 能力体验馆', '像素贪吃蛇', '霓虹贪吃蛇', '指挥官 · 智能体详情', '计算器应用', 'ROI 计算器', '长标题应用 <img src=x onerror=alert(1)> '.repeat(5)]) {
      await orkas.invoke('savedApps.saveFromPath', { path: entry, title });
    }
    await openSidebarEntry(page, '#apps-btn');
    await expect(page.locator('.app-card')).toHaveCount(7);
    await expect(page.locator('.app-card img')).toHaveCount(0);
    const scrollArea = page.locator('#panel-apps .agents-grid-scroll');
    expect(await scrollArea.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => (window as any).setLang('zh'));
    await page.locator('#panel-apps').screenshot({ path: testInfo.outputPath('apps-grid.png') });
    await page.locator('#apps-create-btn').click();
    const panel = page.locator('.apps-create-panel');
    const idea = panel.locator('textarea');
    await expect(panel.getByRole('heading', { name: '创建应用', exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('apps-create.png') });
    const draft = '家庭菜单 <img src=x onerror=alert(1)> & shopping list';
    await idea.fill(draft);
    await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeVisible();
    for (const [lang, title, topic, cancelLabel] of [
      ['en', 'Create app', 'Unit converter', 'Cancel'],
      ['ja', 'アプリを作成', '単位換算', 'キャンセル'],
      ['pt', 'Criar aplicativo', 'Conversor de unidades', 'Cancelar'],
    ]) {
      await page.evaluate((language) => (window as any).setLang(language), lang);
      await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(panel).toContainText(topic);
      await expect(panel.getByRole('button', { name: cancelLabel, exact: true })).toBeVisible();
      await expect(panel).not.toContainText('apps.template_');
      await expect(idea).toHaveValue(draft);
      await expect(panel.locator('img')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 560, height: 720 });
    await expect(panel.locator('[data-app-template="game"]')).toBeVisible();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('apps-create-narrow.png') });
    await panel.locator('[data-app-template="converter"]').click();
    await expect(idea).toHaveValue(/Crie um conversor de unidades/);
    await panel.locator('[data-create-cancel]').click();
    await expect(panel).toHaveCount(0);
    expect(orkas.modelRequests.length).toBe(0);
    await openSidebarEntry(page, '#apps-btn');
    const grid = page.locator('#apps-grid');
    expect(await grid.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await scrollArea.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('#apps-create-btn').click();
    await page.locator('.apps-create-overlay').click({ position: { x: 2, y: 2 } });
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#apps-create-btn')).toBeFocused();
  });

  test('opens safely, renames, prepares an edit, persists, and deletes a saved app', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const indexPath = orkas.createWorkspaceFile(
      'e2e-app/index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="app-title">E2E App Running</h1></body></html>',
    );
    orkas.createWorkspaceFile('e2e-app/style.css', 'body { color: rgb(12, 34, 56); }');
    const saved = await orkas.invoke<{ ok: boolean; id: string; title: string }>('savedApps.saveFromPath', {
      path: indexPath,
      title: 'E2E Saved App',
    });
    expect(saved.ok).toBe(true);

    await openSidebarEntry(page, '#apps-btn');
    await expect(page.locator('#panel-apps')).toHaveClass(/\bactive\b/);
    let card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Saved App');
    await expect(page.locator('#apps-page-header-count')).toHaveText('1');

    const moreButton = card.locator('[data-app-more]');
    await expect(moreButton).toHaveCSS('position', 'absolute');
    await expect(moreButton).toHaveCSS('top', '12px');
    await expect(moreButton).toHaveCSS('right', '12px');
    await expect(moreButton).toBeHidden();
    await card.hover();
    await expect(moreButton).toBeVisible();
    await page.locator('.apps-page-header-title').hover();
    await expect(moreButton).toBeHidden();
    await card.focus();
    await expect(moreButton).toBeVisible();
    await page.locator('#apps-create-btn').focus();
    await expect(moreButton).toBeHidden();

    const opened = orkas.electronApp!.waitForEvent('window');
    await card.click();
    const preview = await opened;
    await preview.waitForLoadState('domcontentloaded');
    const viewer = preview.locator('.saved-app-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.saved-app-viewer-title')).toHaveText('E2E Saved App');
    const appFrame = viewer.locator('.saved-app-viewer-frame');
    await expect(appFrame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals',
    );
    await expect(appFrame.contentFrame().locator('#app-title')).toHaveText('E2E App Running');
    expect(await appFrame.contentFrame().locator('body').evaluate(() => typeof (window as any).orkas)).toBe('undefined');
    await page.locator('#new-chat-btn').click();
    await expect(appFrame.contentFrame().locator('#app-title')).toHaveText('E2E App Running');
    await openSidebarEntry(page, '#apps-btn');
    await card.click();
    expect(orkas.electronApp!.windows().filter(p => p.url().endsWith('/preview.html'))).toHaveLength(1);
    await orkas.closePreview(preview);
    await expect.poll(() => preview.isClosed()).toBe(true);

    await card.hover();
    await card.locator('[data-app-more]').click();
    await page.locator('.app-row-menu-item[data-action="rename"]').click();
    const prompt = page.locator('.ui-dialog-overlay:visible');
    await prompt.locator('.ui-dialog-input').fill('E2E Renamed App');
    await prompt.locator('[data-act="ok"]').click();
    card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');

    await card.hover();
    await card.locator('[data-app-more]').click();
    // The pre-change edit flow also emits Chromium's delivery-limit notice
    // during composer layout. Distinguish that notification from an exception
    // and verify the editable composer and source attachment still recover.
    await page.evaluate(() => {
      (window as any).__savedAppEditNotifications = [];
      window.addEventListener('error', event => {
        (window as any).__savedAppEditNotifications.push({ message: event.message, hasException: event.error != null });
      });
    });
    await page.locator('.app-row-menu-item[data-action="edit"]').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-header .chat-app-type-tag')).toHaveCount(0);
    await expectComposerText(page.locator('#chat-input'), /E2E Renamed App/);
    await expect(page.locator('#chat-attachments')).toContainText('app-source.md');
    const editComposer = page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]');
    await expect(editComposer).toBeFocused();
    await editComposer.fill('Change the app background to blue');
    await expectComposerText(page.locator('#chat-input'), 'Change the app background to blue');
    const notifications = await page.evaluate(() => (window as any).__savedAppEditNotifications);
    for (const notification of notifications) {
      expect(notification).toEqual({
        message: 'ResizeObserver loop completed with undelivered notifications.',
        hasException: false,
      });
    }

    const relaunchedPage = await orkas.relaunch();
    await openSidebarEntry(relaunchedPage, '#apps-btn');
    card = relaunchedPage.locator(`.app-card[data-app-id="${saved.id}"]`);
    await expect(card).toContainText('E2E Renamed App');
    await card.hover();
    await card.locator('[data-app-more]').click();
    await relaunchedPage.locator('.app-row-menu-item[data-action="delete"]').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog-danger')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(card).toHaveCount(0);
    await expect(relaunchedPage.locator('#apps-empty')).toBeVisible();
    await expect(relaunchedPage.locator('#apps-page-header-count')).toHaveText('');
  });
});


test('labels each application artifact inside its bubble across languages and reopening', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const created = await orkas.invoke<any>('conversations.create', { title: 'Application outputs' });
  const cid = created.conversation.conversation_id;
  const artifacts = [];
  for (const appType of ['local', 'web']) {
    const result = appType === 'web' ? historicalArtifact(orkas.workspaceRoot, cid, 'web', `${appType} application `.repeat(8)) : await orkas.electronApp!.evaluate(async (_electron, args) =>
      (process as any).mainModule.require(args.module).createArtifact('account-e2e', args.cid, 'commander', {
        appType: args.appType, title: args.title,
        files: [{ path: 'index.html', content: '<!doctype html><h1>Application ready</h1>' }],
      }), { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid, appType, title: `${appType} application `.repeat(8) });
    expect(result.ok).toBe(true);
    artifacts.push({ id: result.artifactId, title: result.title, agent_id: 'commander' });
  }
  appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), JSON.stringify({
    id: 'm_app_outputs', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: 'Applications ready.', artifacts,
  }) + '\n');
  const reopen = async () => {
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('new-chat');
      (window as any).setView('conversation', id);
    }, cid);
  };
  await reopen();
  const cards = page.locator('#chat-history .chat-bubble .chat-artifact-card');
  const tags = cards.locator('.chat-app-type-tag');
  await expect(cards).toHaveCount(2);
  await expect(tags).toHaveText(['Local app', 'Web app']);
  await expect(page.locator('#chat-header .chat-app-type-tag')).toHaveCount(0);
  await page.evaluate(() => (window as any).setLang('zh'));
  await expect(tags).toHaveText(['本地应用', '网页应用']);
  for (const width of [1133, 560]) {
    await page.setViewportSize({ width, height: 720 });
    for (const card of await cards.all()) {
      expect(await card.evaluate(el => {
        const title = el.querySelector('.chat-artifact-title')!.getBoundingClientRect();
        const tag = el.querySelector('.chat-app-type-tag')!.getBoundingClientRect();
        const menu = el.querySelector('.chat-artifact-more')!.getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        const bubble = el.closest('.chat-bubble')!.getBoundingClientRect();
        return title.right <= tag.left && tag.right <= menu.left && el.scrollWidth <= el.clientWidth
          && bounds.left >= bubble.left && bounds.right <= bubble.right;
      })).toBe(true);
    }
    for (let index = 0; index < await cards.count(); index++) {
      const header = cards.nth(index).locator('.chat-artifact-header');
      await header.scrollIntoViewIfNeeded();
      await header.screenshot({ path: testInfo.outputPath(`artifact-tag-${width}-${index}.png`) });
    }
  }
  await page.evaluate(() => (window as any).setLang('en'));
  await reopen();
  await expect(tags).toHaveText(['Local app', 'Web app']);
  await expect(cards.locator('iframe[src]')).toHaveCount(1);
  await expect(cards.nth(1)).toContainText('commercial version');
});


test('denies historical web resource URLs before and after restart while retaining their bytes', async ({ orkas }) => {
  const created = await orkas.invoke<any>('conversations.create', { title: 'Historical web resources' });
  const cid = created.conversation.conversation_id;
  const urls: string[] = [];
  const originals = new Map<string, Buffer>();
  for (const appType of ['web', 'cloud']) {
    const artifact = historicalArtifact(orkas.workspaceRoot, cid, appType);
    const savedId = 'historic-' + appType;
    const savedDir = path.join(orkas.workspaceRoot, 'account-e2e/cloud/saved_apps', savedId);
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(path.join(savedDir, 'index.html'), '<h1>Preserve saved app bytes</h1>');
    writeFileSync(path.join(savedDir, '__orkas-meta.json'), JSON.stringify({ title: 'Historic saved app', appType, entry: 'index.html' }));
    for (const dir of [savedDir, path.join(orkas.workspaceRoot, 'account-e2e/cloud/chat_artifacts', cid, artifact.artifactId)]) {
      for (const file of readdirSync(dir)) originals.set(path.join(dir, file), readFileSync(path.join(dir, file)));
    }
    urls.push(`chat-app://saved/${savedId}/index.html`, `chat-app://cid/${cid}/${artifact.artifactId}/index.html`);
  }
  for (const restart of [false, true]) {
    if (restart) await orkas.relaunch();
    const receipts = await orkas.electronApp!.evaluate(async ({ net }, urls) => Promise.all(urls.map(async url => {
      const response = await net.fetch(url);
      return { status: response.status, body: await response.json() };
    })), urls);
    for (const receipt of receipts) expect(receipt).toMatchObject({ status: 403, body: { ok: false, code: 'E_COMMERCIAL_REQUIRED', feature: 'web_apps' } });
    for (const [file, bytes] of originals) expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(orkas.electronApp!.windows()).toHaveLength(1);
    expect(orkas.modelRequests).toHaveLength(0);
  }
});


test('labels an untyped artifact from its task: web in a web creation task, local in an ordinary conversation', async ({ orkas }) => {
  const page = orkas.page!;
  const tags: string[] = [];
  for (const assistance of [{ kind: 'app_creation', appType: 'web' }, undefined]) {
    const created = await orkas.electronApp!.evaluate(async (_electron, args) => ({ conversation: await (process as any).mainModule.require(args.module).createConversation('account-e2e', { title: 'Untyped output', assistance: args.assistance }) }), { module: path.resolve(__dirname, '../../src/main/features/chats.ts'), assistance });
    const cid = created.conversation.conversation_id;
    const result = historicalArtifact(orkas.workspaceRoot, cid);
    expect(result.ok).toBe(true);
    // Legacy/synced metadata without a type must not default to local in a web task.
    writeFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chat_artifacts', cid, result.artifactId, '__orkas-meta.json'), JSON.stringify({ title: 'Untyped app' }));
    appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), JSON.stringify({
      id: 'm_untyped', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      text: 'Application ready.', artifacts: [{ id: result.artifactId, title: result.title, agent_id: 'commander' }],
    }) + '\n');
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('new-chat');
      (window as any).setView('conversation', id);
    }, cid);
    await page.evaluate(() => (window as any).setLang('en'));
    const tag = page.locator('#chat-history .chat-artifact-card .chat-app-type-tag');
    await expect(tag).toBeVisible();
    tags.push(await tag.innerText());
  }
  expect(tags).toEqual(['Web app', 'Local app']);
});

test('keeps the local application icon while the web entry only offers commercial guidance', async ({ orkas }) => {
  const page = orkas.page!;
  const local = orkas.createWorkspaceFile('icon-local/index.html', '<h1>Local</h1>');
  await orkas.invoke('savedApps.saveFromPath', { path: local, title: 'Local example' });
  await openSidebarEntry(page, '#apps-btn');
  await expect(page.locator('.app-card-icon svg.is-layout-grid')).toHaveCount(1);
  await page.locator('[data-app-filter="web"]').click();
  await expect(page.locator('.ui-dialog-overlay.open').last()).toBeVisible();
  await page.locator('.ui-dialog-overlay.open').last().locator('[data-act="cancel"]').click();
  await expect(page.locator('.app-card-icon svg.is-layout-grid')).toHaveCount(1);
});

/** Mono 8-bit PCM WAV whose sample bytes vary, so a shifted or truncated byte
 *  range is distinguishable from the requested slice. */
function wavFixture(seconds: number, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) wav[44 + i] = 96 + ((i * 7) % 61);
  return wav;
}

test('opens a non-index saved entry with its stylesheet, font and seekable audio', async ({ orkas }) => {
  const page = orkas.page!;
  const font = readFileSync(path.resolve(__dirname, '../../src/renderer/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Size3-Regular.woff'));
  const audio = wavFixture(0.5);
  const entry = orkas.createWorkspaceFile('cli-game/game.html', '<!doctype html><html><head><link rel="stylesheet" href="game.css"></head>'
    + '<body><h1 id="game-title">Jump game</h1><audio id="jump" src="jump.wav" preload="auto"></audio></body></html>');
  // A sibling page sorts before the entry: opening it instead is a wrong-entry regression.
  orkas.createWorkspaceFile('cli-game/about.html', '<!doctype html><h1 id="game-title">About page</h1>');
  orkas.createWorkspaceFile('cli-game/game.css', '@font-face { font-family: "E2E Game Font"; src: url("game-font.woff") format("woff"); }\n'
    + 'body { color: rgb(12, 34, 56); }\nh1 { font-family: "E2E Game Font", monospace; }');
  orkas.createWorkspaceFile('cli-game/game-font.woff', font);
  orkas.createWorkspaceFile('cli-game/jump.wav', audio);
  const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: entry, title: 'Jump game' });
  expect(saved).toMatchObject({ ok: true, entry: 'game.html' });

  await openSidebarEntry(page, '#apps-btn');
  const preview = await orkas.openPreview(() => page.locator(`.app-card[data-app-id="${saved.id}"]`).click());
  const viewer = preview.locator('.saved-app-viewer');
  await expect(viewer.locator('.saved-app-viewer-title')).toHaveText('Jump game');
  const appFrame = viewer.locator('.saved-app-viewer-frame').contentFrame();
  await expect(appFrame.locator('#game-title')).toHaveText('Jump game');
  const body = appFrame.locator('body');
  expect(await body.evaluate(() => new URL(location.href).pathname.split('/').at(-1))).toBe('game.html');
  await expect(body).toHaveCSS('color', 'rgb(12, 34, 56)');
  const fonts = await body.evaluate(async () => {
    await document.fonts.load('16px "E2E Game Font"').catch(() => []);
    await document.fonts.ready;
    return [...document.fonts].filter(face => face.family.replace(/"/g, '') === 'E2E Game Font').map(face => face.status);
  });
  expect(fonts).toEqual(['loaded']);
  const start = 100, end = 163;
  const ranged = await body.evaluate(async (_body, { start, end }) => {
    const response = await fetch('jump.wav', { headers: { Range: `bytes=${start}-${end}` } });
    return { status: response.status, contentRange: response.headers.get('Content-Range'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, { start, end });
  expect(ranged.status).toBe(206);
  expect(ranged.contentRange).toBe(`bytes ${start}-${end}/${audio.length}`);
  expect(Buffer.from(ranged.bytes).equals(audio.subarray(start, end + 1))).toBe(true);
  const duration = await body.evaluate(() => new Promise<number>((resolve, reject) => {
    const element = document.getElementById('jump') as HTMLAudioElement;
    if (element.readyState >= 1) { resolve(element.duration); return; }
    element.addEventListener('loadedmetadata', () => resolve(element.duration), { once: true });
    element.addEventListener('error', () => reject(new Error('audio failed to load')), { once: true });
  }));
  expect(duration).toBeCloseTo(0.5, 2);
  await orkas.closePreview(preview);
});

test('Enter and Space each open one preview and the icon tone survives rename', async ({ orkas }) => {
  const page = orkas.page!;
  const entry = orkas.createWorkspaceFile('key-open/index.html', '<h1 id="key-title">Key open</h1>');
  const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: entry, title: 'Key open' });
  await openSidebarEntry(page, '#apps-btn');
  const card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
  const toneBefore = await card.locator('.app-card-icon').getAttribute('class');
  const previews = () => orkas.electronApp!.windows().filter(surface => surface.url().endsWith('/preview.html'));
  for (const [index, key] of (['Enter', ' '] as const).entries()) {
    await card.focus();
    const preview = await orkas.openPreview(() => page.keyboard.press(key === ' ' ? 'Space' : key));
    await expect(preview.locator('.saved-app-viewer-frame').contentFrame().locator('#key-title')).toHaveText('Key open');
    expect(previews()).toHaveLength(1);
    await orkas.closePreview(preview);
  }

  await card.hover();
  await card.locator('[data-app-more]').click();
  await page.locator('.app-row-menu-item[data-action="rename"]').click();
  const prompt = page.locator('.ui-dialog-overlay:visible');
  await prompt.locator('.ui-dialog-input').fill('Renamed key app');
  await prompt.locator('[data-act="ok"]').click();
  await expect(card.locator('.app-card-name')).toHaveText('Renamed key app');
  await expect(card.locator('.app-card-icon')).toHaveAttribute('class', toneBefore!);
  await page.evaluate(() => (window as any).loadSavedApps(true));
  await expect(card.locator('.app-card-name')).toHaveText('Renamed key app');
  await expect(card.locator('.app-card-icon')).toHaveAttribute('class', toneBefore!);
  expect((await orkas.invoke<any>('savedApps.list')).apps).toEqual([expect.objectContaining({ id: saved.id, title: 'Renamed key app' })]);
});

test('saving an artifact shows exactly one confirmation toast and no dialog', async ({ orkas }) => {
  const page = orkas.page!;
  const created = await orkas.invoke<any>('conversations.create', { title: 'Artifact save' });
  const cid = created.conversation.conversation_id;
  const result = await orkas.electronApp!.evaluate(async (_electron, args) =>
    (process as any).mainModule.require(args.module).createArtifact('account-e2e', args.cid, 'commander', {
      title: 'Saved artifact', files: [{ path: 'index.html', content: '<!doctype html><h1>Saved artifact</h1>' }],
    }), { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid });
  expect(result.ok).toBe(true);
  appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), JSON.stringify({
    id: 'm_artifact_save', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: 'Artifact ready.', artifacts: [{ id: result.artifactId, title: result.title, agent_id: 'commander' }],
  }) + '\n');
  await page.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  const artifact = page.locator('#chat-history .chat-artifact-card');
  await expect(artifact).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    // Count distinct surfaces, including any that appear and leave between checks.
    const toasts = new Set<Element>(), dialogs = new Set<Element>();
    w.__saveSurfaces = () => ({ toasts: toasts.size, dialogs: dialogs.size });
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.ui-toast')) toasts.add(node);
      for (const node of document.querySelectorAll('.ui-dialog-overlay')) if ((node as HTMLElement).offsetParent !== null || getComputedStyle(node).display !== 'none') dialogs.add(node);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  });
  await artifact.locator('.chat-artifact-more').click();
  await page.locator('.chat-artifact-menu [data-action="save"]').click();
  await expect(page.locator('.ui-toast.is-success')).toHaveCount(1);
  await expect.poll(async () => (await orkas.invoke<any>('savedApps.list')).apps.map((app: any) => app.title)).toEqual(['Saved artifact']);
  await openSidebarEntry(page, '#apps-btn');
  await expect(page.locator('.app-card').filter({ hasText: 'Saved artifact' })).toHaveCount(1);
  await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__saveSurfaces())).toEqual({ toasts: 1, dialogs: 0 });
});

// UI review captures (zh, default window unless named -390): saved time, local delete
// confirmation without a publication, and the create dialog type choice.
test('reads saved time, local delete confirmation and the create dialog in Chinese at default and narrow widths', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const review = (name: string) => testInfo.outputPath('ui-review', name);
  const entry = orkas.createWorkspaceFile('review-app/index.html', '<!doctype html><h1>Review</h1>');
  const saved = await orkas.invoke<{ ok: boolean; id: string }>('savedApps.saveFromPath', { path: entry, title: '旅行清单' });
  expect(saved.ok).toBe(true);
  // An earlier save today (in the app's own time zone) reads as a clock time, not "just now".
  const savedAt = new Date(await page.evaluate(() => { const today = new Date(); today.setHours(0, 0, 0, 0); return Math.max(Date.now() - 5 * 60_000, today.getTime()); }));
  const meta = path.join(orkas.workspaceRoot, 'account-e2e/cloud/saved_apps', saved.id, '__orkas-meta.json');
  writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), savedAt: savedAt.toISOString() }));
  await openSidebarEntry(page, '#apps-btn');
  await page.evaluate(async () => { await (window as any).setLang('zh'); await (window as any).loadSavedApps(true); });
  const card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
  const clock = await page.evaluate(ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, savedAt.getTime());
  if (Date.now() - savedAt.getTime() >= 60_000) await expect(card).toContainText(`保存于 ${clock}`);
  await card.screenshot({ path: review('09-card-saved-time.png') });

  await card.hover(); await card.locator('[data-app-more]').click();
  await page.locator('.app-row-menu-item[data-action="delete"]').click();
  const confirm = page.locator('.ui-dialog-overlay:visible');
  await expect(confirm).toContainText('删除「旅行清单」及其本地记录和私有文件？数据无法恢复。');
  await expect(confirm).not.toContainText('已发布应用及线上数据将保留。');
  await expect(confirm.locator('[data-act="cancel"]')).toBeFocused();
  await confirm.locator('.ui-dialog').screenshot({ path: review('08-delete-confirm-local.png') });
  await page.setViewportSize({ width: 390, height: 720 });
  // Chromium can expose fractional visual CSS pixels while innerWidth is rounded.
  const dialogBounds = await confirm.locator('.ui-dialog').evaluate(node => {
    const rect = node.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    return { left: rect.left, right: rect.right, viewportLeft: left,
      viewportRight: left + (viewport?.width ?? window.innerWidth) };
  });
  expect(dialogBounds.left, JSON.stringify(dialogBounds)).toBeGreaterThanOrEqual(dialogBounds.viewportLeft);
  expect(dialogBounds.right, JSON.stringify(dialogBounds)).toBeLessThanOrEqual(dialogBounds.viewportRight);
  await page.screenshot({ path: review('08-delete-confirm-local-390.png') });
  await page.keyboard.press('Escape'); await expect(confirm).toHaveCount(0); await expect(card).toBeVisible();
  await page.setViewportSize({ width: 1133, height: 800 });

  await page.locator('#apps-create-btn').click();
  const panel = page.locator('.apps-create-panel');
  await expect(panel.getByRole('heading', { name: '创建应用', exact: true })).toBeVisible();
  await expect(panel.locator('[data-app-type]')).toHaveText(['本地应用', '网页应用']);
  await expect(panel.locator('[data-app-type="local"]')).toHaveAttribute('aria-pressed', 'true');
  await panel.screenshot({ path: review('12-create-dialog.png') });
  await page.setViewportSize({ width: 390, height: 720 });
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: review('12-create-dialog-390.png') });
  await page.setViewportSize({ width: 1133, height: 800 });
  await panel.locator('[data-create-cancel]').click(); await expect(panel).toHaveCount(0);
  expect((await orkas.invoke<{ apps: unknown[] }>('savedApps.list')).apps).toHaveLength(1);
  expect(orkas.modelRequests).toHaveLength(0);
});
