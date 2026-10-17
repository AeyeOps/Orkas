import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';

test.describe('recycle-bin recovery', () => {
  test('shows legacy automation names in a compact batch on wide and narrow windows', async ({ orkas, appPage }, testInfo) => {
    const batchId = 'legacy-automation-display';
    const batchDir = path.join(orkas.workspaceRoot, 'account-e2e', 'local', 'recycle', batchId);
    const names = ['Daily sales digest', 'Weekly project report', 'Inbox summary', 'Release checklist',
      'Monitor build results', 'Monthly review', 'Daily sales digest'];
    const configs = names.map((title, index) => {
      const id = `at_display${index}`;
      const relPath = index % 2 ? `cloud/projects/p_launch/auto_tasks/${id}/config.json`
        : `cloud/auto_tasks/${id}/config.json`;
      const file = path.join(batchDir, 'files', relPath.slice('cloud/'.length));
      mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify({ id, title, content: title, enabled: false,
        ...(index % 2 ? { project_id: 'p_launch' } : {}) });
      writeFileSync(file, text);
      return { id, path: relPath, size: Buffer.byteLength(text) };
    });
    const metaFile = path.join(batchDir, 'batch.json');
    writeFileSync(metaFile, JSON.stringify({
      id: batchId, source: 'cloud_sync', reason: 'remote_tombstone', created_at_ms: Date.now(),
      items: configs.map(({ path, size }) => ({ path, size })),
      metadata: { project_rows: [{ project_id: 'p_launch', name: 'Client Launch' }] },
      display_items: configs.map(config => ({ category: 'auto_task', id: config.id, title: config.id,
        path: `cloud/auto_tasks/${config.id}/config.json` })),
    }));
    const original = readFileSync(metaFile, 'utf8');
    await appPage.evaluate(async () => { await (window as any).setLang('zh'); });
    await appPage.locator('#settings-btn').click();
      await appPage.locator('[data-settings-tab="data"]').click();
    const row = appPage.locator('.settings-recycle-row').filter({
      has: appPage.locator(`[data-recycle-view="${batchId}"]`),
    });
    await expect(row.locator('.settings-recycle-name')).toHaveText('自动化 · 7 个任务');
    await row.locator('[data-recycle-view]').click();
    await expect(row.locator('.settings-recycle-detail-title')).toHaveText(names);
    await expect(row.locator('.settings-recycle-details .settings-recycle-meta')).toHaveText([
      'Client Launch', 'Client Launch', 'Client Launch',
    ]);
    await expect(row.locator('.settings-recycle-detail-path')).toHaveCount(0);
    await expect(row.locator('.settings-recycle-detail-category')).toHaveCount(0);
    await expect(row.locator('.settings-recycle-detail-row').nth(1)).toHaveAttribute('title',
      'Weekly project report\nat_display1\nprojects/p_launch/auto_tasks/at_display1/config.json');
    await appPage.setViewportSize({ width: 1000, height: 900 });
    await row.screenshot({ path: testInfo.outputPath('automation-wide.png') });
    await appPage.setViewportSize({ width: 620, height: 900 });
    await expect(row.locator('[data-recycle-restore]')).toBeVisible();
    await expect(row.locator('[data-recycle-delete]')).toBeVisible();
    const bounds = await row.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
    await row.screenshot({ path: testInfo.outputPath('automation-narrow.png') });
    await row.locator('.settings-recycle-detail-title').last().scrollIntoViewIfNeeded();
    await expect(row.locator('.settings-recycle-detail-title').last()).toBeInViewport();
    await appPage.evaluate(async () => { await (window as any).setLang('en'); });
    await expect(row.locator('.settings-recycle-name')).toHaveText('Automation · 7 tasks');
    await expect(row.locator('.settings-recycle-detail-title')).toHaveText(names);
    expect(readFileSync(metaFile, 'utf8')).toBe(original);
  });

  test('a corrupt snapshot reports failure without recreating an empty project', async ({ orkas }) => {
    const created = await orkas.invoke<{
      project: { project_id: string };
    }>('projects.create', { name: 'E2E Corrupt Recovery Project' });
    const projectId = created.project.project_id;
    await orkas.invoke('projects.delete', { projectId });

    const listed = await orkas.invoke<{
      batches: Array<{ id: string; items: Array<{ path: string }> }>;
    }>('recycle.list');
    const batch = listed.batches.find((item) => (
      item.items.some((entry) => entry.path === `cloud/projects/${projectId}/project.json`)
    ));
    if (!batch) throw new Error('project recycle batch was not created');

    for (const item of batch.items) {
      rmSync(path.join(
        orkas.workspaceRoot,
        'account-e2e',
        'local',
        'recycle',
        batch.id,
        'files',
        ...item.path.slice('cloud/'.length).split('/'),
      ), { recursive: true, force: true });
    }

    const restored = await orkas.invoke<{
      ok: boolean;
      restored: number;
      failed_paths: string[];
      reactivated_paths: string[];
    }>('recycle.restore', { id: batch.id });
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(0);
    expect(restored.failed_paths.sort()).toEqual(batch.items.map((item) => item.path).sort());
    expect(restored.reactivated_paths).toEqual([]);

    const projects = await orkas.invoke<{
      projects: Array<{ project_id: string }>;
    }>('projects.list');
    expect(projects.projects).not.toContainEqual(expect.objectContaining({ project_id: projectId }));
  });
});
