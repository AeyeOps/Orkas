import { expect, test } from './fixtures/orkas';
import path from 'node:path';


async function selectContents(
  locator: import('@playwright/test').Locator,
): Promise<void> {
  await locator.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

test.describe('chat selection context menu', () => {
  test('owns only chat selections and exposes keyboard scratch-edit and copy failure results', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    const page = orkas.page;
    const prompt = 'E2E context menu selection text.';
    const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create', { title: 'Context menu selection' },
    );
    // This journey starts from settled history. Seed canonical records through
    // the same resolver as history E2E, independently of cold model preparation.
    await orkas.electronApp!.evaluate((_electron, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const file = req(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      const rows = [
        { id: 'selection-user', from: 'user', to: ['commander'], ts: '2026-10-15T08:00:00Z', text: input.prompt },
        { id: 'selection-answer', from: 'commander', to: ['user'], ts: '2026-10-15T08:00:01Z', text: 'E2E context menu reply.' },
      ];
      req('node:fs').writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }, { root: path.resolve(__dirname, '../..'), cid: conversation.conversation_id, prompt });
    await page.evaluate(async cid => {
      const app = window as any;
      await app.loadConversations();
      app.setView('conversation', cid);
    }, conversation.conversation_id);
    const bubble = page.locator('#chat-history .chat-message.user').last();
    await expect(bubble).toContainText(prompt);
    // Settled canonical history renders a normal bubble, without live stream slots.
    await expect(page.locator('#chat-history .chat-message.assistant')).toContainText(
      'E2E context menu reply.',
    );
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

    await selectContents(page.locator('#sidebar-search-btn'));
    await bubble.click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(0);

    await selectContents(bubble.locator('.markdown-body'));
    await bubble.click({ button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.context-menu-item').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.context-menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#chat-md-drawer-panel')).toHaveClass(/\bis-open\b/);
    await expect(page.locator('#chat-md-drawer-body textarea')).toHaveValue(prompt);
    await page.locator('#chat-md-drawer-close').click();

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard unavailable'); } },
      });
    });
    await selectContents(bubble.locator('.markdown-body'));
    await bubble.click({ button: 'right' });
    await page.locator('.context-menu-item').first().click();
    await expect(page.locator('.ui-toast.is-error')).toContainText('Copy failed');
  });
});
