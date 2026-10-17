import type { Page } from '@playwright/test';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

// A full memory store refuses new entries until the AI consolidates it. The
// real renderer must show that state on the memory page and the project Memory
// tab, and a user add must be refused without asking the user to clean up.
const COPY = {
  en: {
    notice: 'Memory is full. Before saving something new, the AI will merge existing entries.',
    refused: "Memory is full, so this entry can't be added right now.",
  },
  zh: {
    notice: '记忆已满。AI 保存新记忆前会先整理合并现有条目。',
    refused: '记忆已满，暂时无法添加这条内容。',
  },
} as const;

async function fill(app: OrkasTestApp, payload: Record<string, string>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await app.invoke<{ ok: boolean }>('memory.add', { ...payload, content: `Durable fact number ${i + 1} kept for later conversations.` });
    expect(res.ok).toBe(true);
  }
}

async function openPersonalMemory(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-settings-tab="data"]').click();
  await page.locator('#memory-entry-card').click();
  await expect(page.locator('#panel-memory')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#memory-page .memory-section')).toHaveCount(2);
}

for (const locale of ['en', 'zh'] as const) {
  test(`shows the full-memory notice and refuses a user add without data loss (${locale})`, async ({}, info) => {
    const app = new OrkasTestApp(info, { seedLanguage: locale });
    try {
      await app.launch();
      const page = app.page!;
      await page.setViewportSize({ width: 1100, height: 740 });

      // Memory page: only the full store shows the notice.
      await fill(app, { target: 'shared' }, 16);
      await openPersonalMemory(page);
      const sections = page.locator('#memory-page .memory-section');
      const shared = sections.nth(1);
      await expect(shared.getByRole('status')).toHaveText(COPY[locale].notice);
      await expect(sections.nth(0).getByRole('status')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`memory-page-full-${locale}.png`) });

      // Project Memory tab.
      const created = await app.invoke<{ ok: boolean; project: { project_id: string } }>('projects.create', { name: `Full memory ${locale}` });
      expect(created.ok).toBe(true);
      const projectId = created.project.project_id;
      await fill(app, { target: 'project', projectId }, 16);
      await page.evaluate((id) => (window as any).setView('project', id), projectId);
      await page.locator('[data-project-side-tabs="context"] [data-project-side-tab="memory"]').click();
      const notice = page.locator('#project-memory-full');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveText(COPY[locale].notice);
      await page.screenshot({ path: info.outputPath(`project-memory-full-${locale}.png`) });

      // A user add is refused with the full message; nothing is evicted.
      await page.locator('#project-memory-add-btn').click();
      await page.locator('#project-memory-editor-input').fill('One more fact.');
      await page.locator('#project-memory-editor-save').click();
      await expect(page.getByText(COPY[locale].refused)).toBeVisible();
      await page.screenshot({ path: info.outputPath(`project-memory-refused-${locale}.png`) });
      const stored = await app.invoke<{ entries: string[]; usage: { full: boolean } }>('memory.list', { target: 'project', projectId });
      expect(stored.entries).toHaveLength(16);
      expect(stored.entries[0]).toContain('number 1 ');
      expect(stored.entries).not.toContain('One more fact.');
      expect(stored.usage.full).toBe(true);
    } finally {
      await app.dispose();
    }
  });
}
