import { writeFileSync } from 'node:fs';
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

  test('Grok waits for delayed initialization before creating a session', async ({ cliOrkas }) => {
    const page = await createAgent(cliOrkas, 'GrokDelayedInitE2E', 'grok');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), acpInitializeMode: 'delayed' }));
    await page.locator('#new-chat-input').fill('@GrokDelayedInitE2E Reply when ready');
    await page.locator('#new-chat-send-btn').click();
    await expect(assistantReply(page, 'E2E_GROK_FIRST_OK')).toBeVisible({ timeout: 30_000 });
    const state = cliOrkas.readCliState();
    expect(state.acpRequests).toEqual([
      { cli: 'grok', method: 'initialize' },
      { cli: 'grok', method: 'session/new' },
      { cli: 'grok', method: 'session/prompt' },
    ]);
    expect(state.invocations).toHaveLength(1);
    await expect(page.locator('#chat-history')).not.toContainText('Authentication required');
  });

  test('Grok displays an initialization error without creating a session', async ({ cliOrkas }) => {
    const page = await createAgent(cliOrkas, 'GrokInitErrorE2E', 'grok');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), acpInitializeMode: 'error' }));
    await page.locator('#new-chat-input').fill('@GrokInitErrorE2E Reply when ready');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#chat-history .chat-message.assistant')).toContainText('Grok initialization rejected', { timeout: 30_000 });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    const state = cliOrkas.readCliState();
    expect(state.acpRequests).toEqual([{ cli: 'grok', method: 'initialize' }]);
    expect(state.invocations).toHaveLength(0);
    await expect(page.locator('.bubble-retry-btn')).toBeVisible();
    await expect(page.locator('.grok-sign-in-control')).toHaveCount(0);
  });

  test('Grok can be stopped while initialization is pending', async ({ cliOrkas }) => {
    const page = await createAgent(cliOrkas, 'GrokPendingInitE2E', 'grok');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), acpInitializeMode: 'pending' }));
    await page.locator('#new-chat-input').fill('@GrokPendingInitE2E Reply when ready');
    await page.locator('#new-chat-send-btn').click();
    await expect.poll(() => cliOrkas.readCliState().acpRequests).toEqual([{ cli: 'grok', method: 'initialize' }]);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    await page.locator('#chat-send-btn').click();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    const state = cliOrkas.readCliState();
    expect(state.acpRequests).toEqual([{ cli: 'grok', method: 'initialize' }]);
    expect(state.invocations).toHaveLength(0);
    await expect(page.locator('#chat-history')).not.toContainText('Authentication required');
  });

  test('Grok sign-in can be cancelled, restarted, and followed by a manual retry', async ({ cliOrkas }) => {
    const page = await createAgent(cliOrkas, 'GrokSignInE2E', 'grok');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), grokSignedOut: true }));
    await page.locator('#new-chat-input').fill('@GrokSignInE2E Reply when ready');
    await page.locator('#new-chat-send-btn').click();
    const control = page.locator('.grok-sign-in-control');
    await expect(control.locator('.grok-sign-in-btn')).toBeVisible();
    await expect(page.locator('#chat-history')).toContainText('Grok needs you to sign in.');
    await expect(control.locator('.grok-sign-in-cancel')).toBeHidden();
    await expect(control.locator('.grok-sign-in-reopen')).toBeHidden();
    await control.locator('.grok-sign-in-btn').click();
    await expect(control).toHaveAttribute('data-state', 'waiting');
    await expect(control.locator('.grok-sign-in-reopen')).toBeVisible();
    await expect.poll(() => cliOrkas.readCliState().grokLoginCalls).toBe(1);
    await page.reload();
    await expect(control).toHaveAttribute('data-state', 'waiting');
    await expect(control.locator('.grok-sign-in-reopen')).toBeVisible();
    await control.locator('.grok-sign-in-cancel').click();
    await expect(control).toHaveAttribute('data-state', 'cancelled');
    await control.locator('.grok-sign-in-btn').click();
    await expect(control).toHaveAttribute('data-state', 'waiting');
    await expect.poll(() => cliOrkas.readCliState().grokLoginCalls).toBe(2);
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), grokLoginReady: true }));
    await expect(control).toHaveAttribute('data-state', 'success');
    await page.reload();
    await expect(control).toHaveAttribute('data-state', 'success');
    expect(cliOrkas.readCliState().invocations).toHaveLength(0);
    await expect(assistantReply(page, 'E2E_GROK_FIRST_OK')).toHaveCount(0);
    await page.locator('.bubble-retry-btn').last().click();
    await expect(assistantReply(page, 'E2E_GROK_FIRST_OK')).toBeVisible({ timeout: 30000 });
    expect(cliOrkas.readCliState().invocations).toHaveLength(1);
  });

  test('Grok sign-in failure remains recoverable after reloading the conversation', async ({ cliOrkas }) => {
    const page = await createAgent(cliOrkas, 'GrokSignInFailureE2E', 'grok');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), grokSignedOut: true, grokLoginOutcome: 'failure' }));
    await page.locator('#new-chat-input').fill('@GrokSignInFailureE2E Reply when ready');
    await page.locator('#new-chat-send-btn').click();
    let control = page.locator('.grok-sign-in-control');
    await expect(control.locator('.grok-sign-in-btn')).toBeVisible();
    await page.reload();
    control = page.locator('.grok-sign-in-control');
    await expect(control.locator('.grok-sign-in-btn')).toBeVisible();
    await control.locator('.grok-sign-in-btn').click();
    await expect(control).toHaveAttribute('data-state', 'waiting');
    writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), grokLoginReady: true }));
    await expect(control).toHaveAttribute('data-state', 'failed');
    await expect(control.locator('.grok-sign-in-btn')).toBeEnabled();
    await expect(page.locator('.bubble-retry-btn').last()).toBeVisible();
    expect(cliOrkas.readCliState().invocations).toHaveLength(0);
  });

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
