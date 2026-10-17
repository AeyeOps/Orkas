import { expect, test } from './fixtures/orkas';

// Commander home (PATTERNS.md P15): an open to-do or a finished run the user
// has not opened turns the New task view into its populated state. The
// greeting and composer keep their place at the top in both states; the work
// to pick up is listed below them. Opening a run takes the user to it and it
// leaves the home; opening a to-do lands on the To-dos page on that to-do.
// The empty state's layout is covered by the landing case in
// composer_e2e_interactions.spec.ts.
test.describe('Commander home continuation', () => {
  test('lists open work below a composer that keeps its place, and drops a run once it is opened', async ({ orkas, appPage }) => {
    await appPage.setViewportSize({ width: 1280, height: 720 });
    const panel = appPage.locator('#panel-new-chat');
    await expect(panel).toHaveAttribute('data-home-state', 'empty');
    await expect(appPage.locator('.home-paths')).toBeVisible();
    await expect(appPage.locator('#home-work')).toBeHidden();
    // Layout position, so the composer's focus lift transition does not count.
    const composerTop = () => panel.locator('.new-chat-input-area').evaluate((element) => (element as HTMLElement).offsetTop);
    const emptyComposerTop = await composerTop();

    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'Weekly competitor brief',
    });
    const cid = created.conversation.conversation_id;
    await orkas.invoke('projects.tasks.create', { content: 'Confirm the pricing table\nDetails in the brief' });
    // What the sidebar records when a run finishes while the user is elsewhere.
    await appPage.evaluate((id) => (window as any)._markConversationUnread(id, {
      finishedAt: Date.now(), status: 'failed', entryPoint: 'chat_send',
    }), cid);

    await expect(panel).toHaveAttribute('data-home-state', 'populated');
    const todos = appPage.locator('.home-group[data-section="todos"]');
    const tasks = appPage.locator('.home-group[data-section="tasks"]');
    await expect(todos.locator('.home-row-title')).toHaveText(['Confirm the pricing table']);
    await expect(tasks.locator('.home-row-title')).toHaveText(['Weekly competitor brief']);
    await expect(tasks.locator('.home-row-action')).toHaveText('See why');
    await expect(appPage.locator('.home-group[data-section="automations"]')).toHaveCount(0);
    await expect(appPage.locator('#new-chat-scenarios')).toBeHidden();
    await expect(appPage.locator('.home-paths')).toBeHidden();

    const layout = await appPage.evaluate(() => {
      const landing = document.querySelector('#panel-new-chat .new-chat-center')!.getBoundingClientRect();
      const greeting = document.querySelector('#panel-new-chat .new-chat-header')!.getBoundingClientRect();
      const composer = document.querySelector('#panel-new-chat .new-chat-input-area')!.getBoundingClientRect();
      const send = document.getElementById('new-chat-send-btn')!.getBoundingClientRect();
      const work = document.getElementById('home-work')!.getBoundingClientRect();
      return {
        greetingOnScreen: greeting.height > 0 && greeting.top >= landing.top,
        composerOnScreen: composer.top >= landing.top && composer.bottom <= landing.bottom,
        sendOnScreen: send.bottom <= landing.bottom,
        workBelowComposer: work.top >= composer.bottom,
      };
    });
    expect(layout).toEqual({ greetingOnScreen: true, composerOnScreen: true, sendOnScreen: true, workBelowComposer: true });
    // The state change did not move the composer.
    expect(await composerTop()).toBe(emptyComposerTop);

    await tasks.locator('.home-row').click();
    await expect(appPage.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await appPage.locator('#new-chat-btn').click();
    await expect(panel).toHaveClass(/\bactive\b/);
    // Opened means read: it is gone from the home, the to-do stays.
    await expect(appPage.locator('.home-group[data-section="tasks"]')).toHaveCount(0);
    await expect(todos.locator('.home-row')).toHaveCount(1);
    await expect(panel).toHaveAttribute('data-home-state', 'populated');

    await todos.locator('.home-row').click();
    await expect(appPage.locator('#panel-todos')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('#todos-content .project-todo-item.is-highlighted')).toHaveCount(1);
  });
});
