import type { Page } from '@playwright/test';

import { expect, openSidebarEntry, test, OrkasTestApp } from './fixtures/orkas';

function assistantReply(page: Page, text: string) {
  return page.locator('#chat-history .chat-message.assistant .chat-bubble .markdown-body', { hasText: text });
}

async function connectCliAgent(page: Page, cli: string, name: string): Promise<void> {
  await openSidebarEntry(page, '#agents-btn');
  await page.locator('#agents-connect-cli-btn').click();
  await expect(page.locator('#agent-modal')).toHaveClass(/\bopen\b/);
  await page.locator('#agent-modal-ext-cli-select-trigger').click();
  await page.locator(`#agent-modal-ext-cli-select-listbox .ai-select-item[data-value="${cli}"]:not(.disabled)`).click();
  await page.locator('#agent-ext-name-input').fill(name);
  await page.locator('#agent-modal .modal-actions .btn').last().click();
  await expect(page.locator('#agent-modal')).not.toHaveClass(/\bopen\b/);
}

test.describe('Saved local CLI paths', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a CLI agent runs the executable saved in local-cli-paths.json', async ({}, info) => {
    const app = new OrkasTestApp(info, { cliStub: true, configuredModel: false, savedCliPaths: true });
    try {
      await app.launch();
      const page = app.page!;

      const listed = await page.evaluate(() => (window as any).orkas.invoke('localAgents.list', { validate: false }));
      const savedPaths = Object.fromEntries(listed.entries.map((entry: { type: string; path: string | null }) => [entry.type, entry.path]));
      expect(savedPaths.cursor).toBe(app.fakeCursorPath);
      expect(savedPaths.claude).toBe(app.fakeClaudePath);
      expect(savedPaths.codex).toBe(app.fakeCodexPath);

      await connectCliAgent(page, 'cursor', 'SavedPathE2E');
      await page.locator('#new-chat-btn').click();
      await page.locator('#new-chat-input').fill('@SavedPathE2E Remember E2E_ACP_PRIOR_FACT=blue-orbit');
      await page.locator('#new-chat-send-btn').click();
      await expect(assistantReply(page, 'E2E_CURSOR_FIRST_OK')).toBeVisible({ timeout: 30_000 });
      expect(app.readCliState().invocations.filter(run => run.cli === 'cursor')).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });
});
