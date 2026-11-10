import type { Page } from '@playwright/test';

import { expect, openSidebarEntry, test, OrkasTestApp } from './fixtures/orkas';

function assistantReply(page: Page, text: string) {
  return page.locator('#chat-history .chat-message.assistant .chat-bubble .markdown-body', { hasText: text });
}

test.describe('CLI agents without a built-in model', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a CLI agent answers new and follow-up sends while Commander still asks for a model', async ({}, info) => {
    const app = new OrkasTestApp(info, { cliStub: true, configuredModel: false });
    try {
      await app.launch();
      const page = app.page!;
      const guardAlert = page.locator('.ui-dialog-overlay.open .ui-dialog-message');
      await expect.poll(() => page.evaluate(() => (window as any).isModelConfigured())).toBe(false);

      await openSidebarEntry(page, '#agents-btn');
      await page.locator('#agents-connect-cli-btn').click();
      await expect(page.locator('#agent-modal')).toHaveClass(/\bopen\b/);
      await page.locator('#agent-modal-ext-cli-select-trigger').click();
      await page.locator('#agent-modal-ext-cli-select-listbox .ai-select-item[data-value="cursor"]:not(.disabled)').click();
      await page.locator('#agent-ext-name-input').fill('CliOnlyE2E');
      await page.locator('#agent-modal .modal-actions .btn').last().click();
      await expect(page.locator('#agent-modal')).not.toHaveClass(/\bopen\b/);

      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('@CliOnlyE2E Remember E2E_ACP_PRIOR_FACT=blue-orbit');
      await page.locator('#new-chat-send-btn').click();
      await expect(assistantReply(page, 'E2E_CURSOR_FIRST_OK')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

      await page.locator('#chat-input').fill('E2E_ACP_CONTINUE and use the prior fact');
      await page.locator('#chat-input').press('Enter');
      await expect(assistantReply(page, 'E2E_CURSOR_HISTORY_BRIDGED')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
      await expect(guardAlert).toHaveCount(0);
      expect(app.readCliState().invocations.filter(run => run.cli === 'cursor')).toHaveLength(2);

      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('Plan my week');
      await page.locator('#new-chat-send-btn').click();
      await expect(guardAlert).toContainText('No model has been added');
      expect(app.readCliState().invocations).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });
});
