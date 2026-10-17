import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/orkas';

test.describe('inline historical task cleanup', () => {
  for (const inProject of [false, true]) test(`previews, cancels, excludes, cleans and restores ${inProject ? 'project' : 'personal'} history using real IPC and storage`, async ({ orkas }, testInfo) => {
    const projectId = inProject ? (await orkas.invoke<any>('projects.create', { name: 'Cleanup project' })).project.project_id : '';
    const dataRoot = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', ...(projectId ? ['projects', projectId] : []));
    const root = path.join(dataRoot, 'chats');
    const cids: string[] = [];
    for (const title of ['Old completed task', 'Keep this completed task', 'Old failed task', 'Old pinned task', 'Unread completed task', 'Draft task', 'Attachment-only draft']) {
      const { conversation } = await orkas.invoke<any>('conversations.create', { title, projectId });
      cids.push(conversation.conversation_id);
    }
    const old = '2020-01-01T00:00:00Z';
    const indexFile = path.join(root, '_index.json');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    for (const [i, cid] of cids.entries()) {
      const row = index.find((r: any) => r.conversation_id === cid);
      row.created_at = old; row.updated_at = old;
      if (i === 3) row.pinned_at = old;
      const dir = path.join(root, cid); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, status: 'idle', in_flight: [], last_active_at: old }));
      writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{ task_id: `t_${cid}`, cid, assignee: 'commander', instruction: 'Fixture task', created_by: 'user', source_msg_id: 'source', status: i === 2 ? 'failed' : 'done', created_at: old, ended_at: old }]));
      writeFileSync(path.join(root, `${cid}.jsonl`), JSON.stringify({ id: 'source', from: 'user', content: 'Preserved history', ts: old }) + '\n');
    }
    const projectBefore = projectId ? readFileSync(path.join(dataRoot, 'project.json'), 'utf8') : '';
    const attachment = (cid: string) => path.join(dataRoot, 'chat_attachments', cid, 'notes.txt');
    for (const cid of [cids[0], cids[6]]) {
      mkdirSync(path.dirname(attachment(cid)), { recursive: true });
      writeFileSync(attachment(cid), 'Attachment contents');
    }
    writeFileSync(path.join(root, `${cids[0]}.jsonl`), JSON.stringify({ id: 'source', from: 'user', content: 'Preserved history', attachments: ['notes.txt'], ts: old }) + '\n');
    writeFileSync(indexFile, JSON.stringify(index));
    const page = await orkas.relaunch();
    await page.evaluate(([unread, draft, pid]) => {
      localStorage.setItem('task_unread_v1_account-e2e', JSON.stringify({ unread: [{ cid: unread, projectId: pid || null, finishedAt: Date.now(), status: 'completed' }], read: [] }));
      localStorage.setItem(`draft_${draft}`, JSON.stringify({ text: 'Keep this unsent draft' }));
    }, [cids[4], cids[5], projectId]);
    await page.reload();
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await expect(section).toContainText('Selected tasks: 2');
    await expect(page.locator('#settings-section-local h2')).toHaveText('Data directory');
    await expect(page.locator('#settings-section-local .settings-row-title')).toHaveCount(0);
    await section.screenshot({ path: testInfo.outputPath('cleanup-preview.png') });
    await section.locator('[data-cleanup-action="view"]').click();
    await expect(section.locator('[data-cleanup-cid]')).toHaveCount(2);
    await section.locator('[data-cleanup-action="prepare"]').click();
    await expect(section.locator('[data-cleanup-action="confirm"]')).toBeVisible();
    await section.locator('[data-cleanup-action="cancel"]').click();
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(true);
    await section.locator(`[data-cleanup-cid="${cids[1]}"]`).uncheck();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await page.setViewportSize({ width: 1000, height: 900 });
    await section.screenshot({ path: testInfo.outputPath('cleanup-en.png') });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await page.setViewportSize({ width: 620, height: 780 });
    await expect(section.locator('[data-cleanup-action="confirm"]')).toHaveText('移入回收站（1）');
    await expect(section.getByRole('combobox')).toContainText('90 天以前');
    const geometry = await section.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    await section.screenshot({ path: testInfo.outputPath('cleanup-zh-narrow.png') });
    // Hold the real deletion at IPC so the in-flight UI can be inspected
    // deterministically, then release it to exercise storage and restoration.
    await orkas.electronApp!.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke');
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', async (event, request) => {
        if (request.channel === 'conversations.cleanup.remove') {
          ipcMain.removeHandler('orkas.invoke');
          ipcMain.handle('orkas.invoke', original);
          await new Promise<void>(resolve => ipcMain.once('cleanup-test-resume', () => resolve()));
        }
        return original(event, request);
      });
    });
    await section.locator('[data-cleanup-action="confirm"]').click();
    try {
      await expect(section.getByRole('status')).toHaveCount(1);
      await expect(section.getByRole('status')).toContainText('正在清理 0 / 1');
      await expect(section.locator('[data-cleanup-action="stop"]')).toBeEnabled();
      await section.screenshot({ path: testInfo.outputPath('cleanup-progress-zh.png') });
    } finally {
      await orkas.electronApp!.evaluate(({ ipcMain }) => { ipcMain.emit('cleanup-test-resume'); });
    }
    await expect(section).toContainText('已移入回收站 1 项');
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(false);
    expect(existsSync(attachment(cids[0]))).toBe(false);
    expect(readFileSync(attachment(cids[6]), 'utf8')).toBe('Attachment contents');
    for (const cid of cids.slice(1)) expect(existsSync(path.join(root, `${cid}.jsonl`))).toBe(true);
    if (projectId) expect(readFileSync(path.join(dataRoot, 'project.json'), 'utf8')).toBe(projectBefore);
    const { batches } = await orkas.invoke<any>('recycle.list');
    const prefix = projectId ? `cloud/projects/${projectId}` : 'cloud';
    const batch = batches.find((b: any) => b.items.some((item: any) => item.path === `${prefix}/chats/${cids[0]}.jsonl`));
    expect(batch).toBeTruthy();
    const recycle = page.locator('#settings-recycle-group');
    // The public build has one local list, including retained historical batches.
    await expect(recycle.locator('[data-recycle-source="local"]')).toBeVisible();
    await expect(recycle.locator('[data-recycle-tab]')).toHaveCount(0);
    await recycle.locator(`[data-recycle-restore="${batch.id}"]`).click();
    await page.evaluate(() => {
      const state = { samples: [] as unknown[], observer: null as MutationObserver | null };
      state.observer = new MutationObserver(() => {
        const toasts = Array.from(document.querySelectorAll('.ui-toast')).map((el) => ({
          text: el.textContent?.trim(), classes: el.className,
          visible: el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0
            && getComputedStyle(el).visibility === 'visible',
        }));
        if (state.samples.length < 30 && toasts.length) state.samples.push({ at: performance.now(), toasts });
      });
      state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      (window as any).__cleanupRestoreToasts = state;
    });
    try {
      await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
      // Observe the real transient UI from before the action. A later polling
      // snapshot can miss a correctly displayed toast after it naturally closes.
      await expect.poll(() => page.evaluate(() => (window as any).__cleanupRestoreToasts.samples.some(
        (sample: any) => sample.toasts.some((toast: any) => toast.visible && /^已恢复 \d+ 个文件$/.test(toast.text)),
      ))).toBe(true);
    } finally {
      const diagnostics = await page.evaluate(() => {
        const state = (window as any).__cleanupRestoreToasts;
        state.observer.disconnect();
        return state.samples;
      }).catch(() => ({ unavailable: true }));
      await testInfo.attach('restore-toast-observations.json', {
        body: JSON.stringify(diagnostics), contentType: 'application/json',
      });
    }
    // History is restored before attachments and index reactivation. Wait for
    // the whole restore operation rather than treating its first file as done.
    await expect.poll(() => {
      if (!existsSync(attachment(cids[0]))) return false;
      const row = JSON.parse(readFileSync(indexFile, 'utf8')).find((item: any) => item.conversation_id === cids[0]);
      return !!row && !row.deleted_at;
    }).toBe(true);
    await expect.poll(() => existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(true);
    expect(readFileSync(path.join(root, `${cids[0]}.jsonl`), 'utf8')).toContain('Preserved history');
    expect(readFileSync(attachment(cids[0]), 'utf8')).toBe('Attachment contents');
    if (projectId) {
      const restored = JSON.parse(readFileSync(indexFile, 'utf8')).find((row: any) => row.conversation_id === cids[0]);
      expect(restored.project_id).toBe(projectId); expect(restored.deleted_at).toBeFalsy();
      expect(readFileSync(path.join(dataRoot, 'project.json'), 'utf8')).toBe(projectBefore);
    }
  });
});
