import { expect, OrkasTestApp, test } from './fixtures/orkas';
import { expectComposerText } from './fixtures/composer';

test('New Task keeps only the centered composer with and without existing work', async ({}, info) => {
  const app = new OrkasTestApp(info);
  try {
    await app.launch();
    const page = app.page!;
    const panel = page.locator('#panel-new-chat');
    const composer = panel.locator('.new-chat-input-area');
    const input = page.locator('#new-chat-input');
    const controls = [
      '#new-chat-attach-btn', '[data-composer-model-chip="new-chat"]',
      '#new-chat-recipient-chip', '#panel-new-chat .workspace-chip', '#new-chat-send-btn',
    ];
    const check = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await expect(panel).toHaveClass(/\bactive\b/);
      await expect(page.locator('#new-chat-btn')).toBeVisible();
      await expect(composer).toBeVisible();
      for (const selector of controls) await expect(page.locator(selector)).toBeVisible();
      await expect(panel.locator('.new-chat-header, .home-below, #home-work, #new-chat-scenarios')).toHaveCount(0);
      const layout = await panel.evaluate(element => {
        const region = element.querySelector('.new-chat-center')!.getBoundingClientRect();
        const box = element.querySelector('.new-chat-input-area')!.getBoundingClientRect();
        return { x: Math.abs((box.left + box.right - region.left - region.right) / 2),
          y: Math.abs((box.top + box.bottom - region.top - region.bottom) / 2),
          fits: box.left >= region.left && box.right <= region.right && box.top >= region.top && box.bottom <= region.bottom };
      });
      expect(layout.x).toBeLessThanOrEqual(2);
      expect(layout.y).toBeLessThanOrEqual(2);
      expect(layout.fits).toBe(true);
    };
    await check(1280, 800);
    await input.fill('A draft to keep while browsing');
    await page.locator('#new-chat-recipient-chip').click();
    await expect(page.locator('#agent-picker')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#todos-btn').click();
    await page.locator('#new-chat-btn').click();
    await expectComposerText(input, 'A draft to keep while browsing');
    await app.invoke('projects.tasks.create', { content: 'Existing follow-up' });
    const created = await app.invoke<any>('conversations.create', { title: 'Existing result' });
    await page.evaluate(cid => (window as any)._markConversationUnread(cid, {
      finishedAt: Date.now(), status: 'completed', entryPoint: 'chat_send',
    }), created.conversation.conversation_id);
    await check(1280, 800);
    await check(650, 600);
    await check(1280, 400);
    await expectComposerText(input, 'A draft to keep while browsing');
  } finally {
    await app.dispose();
  }
});
