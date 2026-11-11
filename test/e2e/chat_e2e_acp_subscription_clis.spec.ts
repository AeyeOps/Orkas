import type { Page } from '@playwright/test';

import { expect, test, type OrkasTestApp } from './fixtures/orkas';

const CASES = [
  { cli: 'cursor', agent: 'CursorAcpE2E', tag: 'CURSOR', args: 'acp' },
  { cli: 'grok', agent: 'GrokAcpE2E', tag: 'GROK', args: 'agent --always-approve stdio' },
  { cli: 'agy', agent: 'AgyAcpE2E', tag: 'AGY', args: 'acp --dangerously-skip-permissions' },
] as const;

async function createAgent(app: OrkasTestApp, name: string, cli: 'cursor' | 'grok' | 'agy'): Promise<Page> {
  await app.invoke('agents.create', {
    name,
    description: `Deterministic ${cli} ACP E2E agent`,
    category: 'general',
    runtime: { kind: 'cli', cli },
  });
  if (!app.page) throw new Error('Orkas renderer is unavailable');
  await app.page.locator('#new-chat-btn').click();
  return app.page;
}

function assistantReply(page: Page, text: string) {
  return page.locator('#chat-history .chat-message.assistant .chat-bubble .markdown-body', { hasText: text });
}

test.describe('Subscription CLIs over ACP', () => {
  test.describe.configure({ timeout: 120_000 });

  for (const item of CASES) {
    test(`${item.cli} runs with full access by default and bridges visible history`, async ({ cliOrkas }) => {
      const detected = await cliOrkas.invoke<any>('localAgents.detect', { type: item.cli });
      expect(detected.entry.available).toBe(true);

      const page = await createAgent(cliOrkas, item.agent, item.cli);
      await page.locator('#new-chat-input').fill(`@${item.agent} Remember E2E_ACP_PRIOR_FACT=blue-orbit`);
      await page.locator('#new-chat-send-btn').click();
      await expect(assistantReply(page, `E2E_${item.tag}_FIRST_OK`)).toBeVisible({ timeout: 30_000 });

      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
      await page.locator('#chat-input').fill(`@${item.agent} E2E_ACP_CONTINUE and use the prior fact`);
      await page.locator('#chat-input').press('Enter');
      await expect(assistantReply(page, `E2E_${item.tag}_HISTORY_BRIDGED`)).toBeVisible({ timeout: 30_000 });

      const runs = cliOrkas.readCliState().invocations.filter(run => run.cli === item.cli);
      expect(runs).toHaveLength(2);
      expect(runs.every(run => run.args.join(' ') === item.args)).toBe(true);
      expect(runs.every(run => run.permissionOutcome === 'allow-once')).toBe(true);
      expect(runs[0].sessionId).not.toBe(runs[1].sessionId);
      expect(runs[1].prompt).toContain('E2E_ACP_PRIOR_FACT');
    });
  }
});
