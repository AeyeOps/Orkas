import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, openSidebarEntry, OrkasTestApp, test } from './fixtures/orkas';

test('New and Edit Auto share saved directories and keep each run’s selected cwd', async ({}, info) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(info, { cliStub: true, modelStub: true, nativeWindowVisible: true });
  try {
    const first = path.join(app.root, 'first project');
    const second = path.join(app.root, 'second project');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    for (const [dir, content] of [[first, 'First skill body'], [second, 'Second skill body']]) {
      const root = path.join(dir, '.agents', 'skills', 'shared-name');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'SKILL.md'), `---\nname: shared-name\ndescription: ${content}\n---\n${content}\n`);
    }
    await app.launch();
    const page = app.page!;
    const agent = await app.invoke<any>('agents.create', { name: 'DirectoryCLIE2E', description: 'Directory test', category: 'general', runtime: { kind: 'cli', cli: 'opencode' } });
    await app.electronApp!.evaluate(({ dialog }, directory) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, first);
    await openSidebarEntry(page, '#auto-btn');
    await page.locator('#auto-add-btn').click();
    await page.locator('#auto-directory-browse').click();
    await expect(page.locator('#auto-directory-list .auto-directory-row')).toHaveCount(1);
    const saved = await app.invoke<any>('workingDirectories.list');
    const firstId = saved.directories.find((row: any) => row.path === first).id;
    const secondId = (await app.invoke<any>('workingDirectories.add', { path: second })).directory.id;
    await page.locator('#auto-dialog-cancel-btn').click();
    await page.locator('#auto-add-btn').click();
    await page.locator('#auto-directory-saved').selectOption(firstId);
    await page.locator('#auto-directory-saved').selectOption(secondId);
    await page.locator(`input[name="auto-main-directory"][value="${firstId}"]`).check();
    await page.locator('#auto-task-input').fill('Directory execution');
    await page.locator('#auto-recipient-chip').click();
    await page.locator('#agent-picker [data-agent-picker-tab="skills"]').click();
    const directorySkills = page.locator('#agent-picker .skill-picker-item[data-kind="skill"][data-source="directory"]');
    await expect(directorySkills).toHaveCount(2);
    const secondSkill = directorySkills.filter({ hasText: second });
    const selectedSkillId = await secondSkill.getAttribute('data-id');
    await secondSkill.click();
    await page.locator('#auto-title-input').fill('Directory execution');
    await page.locator('#auto-enabled-input').uncheck();
    await page.locator('#auto-recipient-chip').click();
    await page.locator(`#agent-picker .skill-picker-item[data-id="${agent.agent.agent_id}"]`).click();
    await page.locator('#auto-submit-btn').click();
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    const task = (await app.invoke<any>('autoTasks.list')).tasks.find((row: any) => row.title === 'Directory execution');
    expect(task).toMatchObject({ directory_ids: [firstId, secondId], working_directory_id: firstId });
    const firstRun = await app.invoke<any>('autoTasks.runNow', { taskId: task.id });
    await expect.poll(() => app.readCliState().invocations.length, { timeout: 30000 }).toBe(1);
    expect(app.readCliState().invocations[0].cwd).toBe(first);
    expect(app.readCliState().invocations[0].prompt).toContain(selectedSkillId);
    const root = path.resolve(__dirname, '../..');
    const env = await app.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require;
      const bridge = await require(args.root + '/src/main/features/local_agents/bridge.ts').startBridge({
        uid: 'account-e2e', cid: args.cid, agentId: args.agentId, agentName: 'DirectoryCLIE2E', cli: 'codex',
        permissionPolicy: 'ask', currentMessageId: 'fixture-message', runId: 'directory-skill-e2e',
        configDir: args.configDir,
        sandboxEnv: { ORKAS_PC_DIR: args.root, ORKAS_NODE: args.node, ORKAS_BUNDLED_NODE: args.node, ORKAS_WORKSPACE_ROOT: args.workspace },
      });
      (globalThis as any).__directorySkillBridge = bridge;
      return bridge.serverEnv;
    }, { root, cid: firstRun.cid, agentId: agent.agent.agent_id, configDir: path.join(app.root, 'skill-bridge'), node: process.execPath, workspace: app.workspaceRoot });
    const client = new Client({ name: 'directory-skill-e2e', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/orkas-bridge.cjs')], env, stderr: 'pipe' }));
      const read = await client.callTool({ name: 'orkas_read_skill', arguments: { id: selectedSkillId } });
      expect(JSON.stringify(read)).toContain('Second skill body');
      expect(JSON.stringify(read)).not.toContain('First skill body');
      const ambiguous = await client.callTool({ name: 'orkas_read_skill', arguments: { id: 'shared-name' } });
      expect(ambiguous.isError).toBe(true);
    } finally {
      await client.close();
      await app.electronApp!.evaluate(async () => { await (globalThis as any).__directorySkillBridge.close(); });
    }
    await page.evaluate(async () => (window as any).loadAutoList(true));
    const row = page.locator(`.auto-row[data-task-id="${task.id}"]`);
    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu [data-action="edit"]').click();
    await page.locator(`[data-directory-id="${firstId}"] .auto-directory-remove`).click();
    await page.locator(`input[name="auto-main-directory"][value="${secondId}"]`).check();
    await page.locator('#auto-submit-btn').click();
    await expect(page.locator('#auto-task-dialog-overlay')).toBeHidden();
    const secondRun = await app.invoke<any>('autoTasks.runNow', { taskId: task.id });
    await expect.poll(() => app.readCliState().invocations.length, { timeout: 30000 }).toBe(2);
    expect(app.readCliState().invocations[1].cwd).toBe(second);
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator(`#conversation-list .conv-item[data-cid="${firstRun.cid}"]`).click();
    await page.locator('#chat-input').fill('Follow up');
    await page.locator('#chat-input').press('Enter');
    await expect.poll(() => app.readCliState().invocations.length, { timeout: 30000 }).toBe(3);
    expect(app.readCliState().invocations[2].cwd).toBe(first);
    expect(secondRun.cid).not.toBe(firstRun.cid);
    rmSync(second, { recursive: true });
    await openSidebarEntry(page, '#auto-btn');
    await row.hover();
    await row.locator('.auto-row-more').click();
    await page.locator('.auto-row-menu [data-action="run-now"]').click();
    await expect(page.getByText(/main working directory is unavailable/)).toBeVisible();
    expect(app.readCliState().invocations).toHaveLength(3);
    await app.acknowledgeInvokeFailures('autoTasks.runNow', 1);
  } finally {
    await app.dispose();
  }
});

test('native automation sees selected directories and runs shell in its Main directory', async ({ modelOrkas: app }) => {
  test.setTimeout(90000);
  const first = path.join(app.root, 'native first');
  const second = path.join(app.root, 'native second');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const a = (await app.invoke<any>('workingDirectories.add', { path: first })).directory;
  const b = (await app.invoke<any>('workingDirectories.add', { path: second })).directory;
  await app.invoke('permissions.setLocalExecMode', { mode: 'workspace_approval' });
  const marker = path.join(first, 'native-write.txt');
  app.setWriteFileScenario(marker, 'native write confirmed', 'Directory checked');
  const task = (await app.invoke<any>('autoTasks.create', { title: 'Native directory', content: 'Check directory', enabled: false, schedule: { type: 'one_time', at: '2099-12-31T09:00:00.000Z' }, directory_ids: [a.id, b.id], working_directory_id: a.id })).task;
  await app.invoke('autoTasks.runNow', { taskId: task.id });
  await expect.poll(() => { try { return readFileSync(marker, 'utf8').trim(); } catch { return ''; } }, { timeout: 30000 }).toBe('native write confirmed');
  const request = JSON.stringify(app.modelRequests);
  expect(request).toContain(first);
  expect(request).toContain(second);
  const cwdMarker = path.join(first, 'native-pwd.txt');
  app.setBashSequenceScenario([`pwd > '${cwdMarker}'`], 'Cwd checked');
  await app.invoke('autoTasks.runNow', { taskId: task.id });
  await expect.poll(() => { try { return readFileSync(cwdMarker, 'utf8').trim(); } catch { return ''; } }, { timeout: 30000 }).toBe(first);
});

test('native model reads the selected non-Main Skill when names collide', async ({ modelOrkas: app }) => {
  test.setTimeout(90000);
  const dirs = ['native-skill-a', 'native-skill-b'].map(name => path.join(app.root, name));
  for (const [index, dir] of dirs.entries()) {
    const skill = path.join(dir, '.agents', 'skills', 'shared-name');
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: shared-name\ndescription: Directory skill ${index}\n---\nUnique body ${index}\n`);
  }
  const ids = [];
  for (const dir of dirs) ids.push((await app.invoke<any>('workingDirectories.add', { path: dir })).directory.id);
  const skills = (await app.invoke<any>('skills.listDirectory', { directoryIds: ids })).skills;
  const selected = skills.find((skill: any) => skill.directory_id === ids[1]);
  const marker = path.join(dirs[0], 'marker.txt');
  writeFileSync(marker, 'marker');
  await app.invoke('permissions.setLocalExecMode', { mode: 'workspace_approval' });
  const reads = [{ path: marker, commentary: 'Checking the main directory.' }, { path: '', commentary: 'Reading the selected skill.' }];
  await app.setChatCommentaryScenario({ reads, finalText: 'Skill checked.' });
  const task = (await app.invoke<any>('autoTasks.create', {
    title: 'Native selected skill', content: 'Use the selected skill', enabled: false,
    schedule: { type: 'one_time', at: '2099-12-31T09:00:00.000Z' },
    directory_ids: ids, working_directory_id: ids[0], skill: { id: selected.id, name: selected.name, source: 'directory' },
  })).task;
  await app.invoke('autoTasks.runNow', { taskId: task.id });
  await expect.poll(() => app.commentaryStage, { timeout: 30000 }).toBe(1);
  const messages = (app.modelRequests[0] as any).messages as Array<{ content?: string }>;
  const line = messages.flatMap(message => typeof message.content === 'string' ? message.content.split('\n') : []).find(value => value.includes('Directory skill 1'));
  const match = line?.match(/read ref: (@skill\/[^ )]+)/);
  expect(match).toBeTruthy();
  reads[1].path = match![1];
  app.releaseCommentaryStage();
  await expect.poll(() => app.commentaryStage, { timeout: 30000 }).toBe(2);
  app.releaseCommentaryStage();
  await expect.poll(() => app.commentaryStage, { timeout: 30000 }).toBe(3);
  expect(JSON.stringify(app.modelRequests[2])).toContain('Unique body 1');
  expect(JSON.stringify(app.modelRequests[2])).not.toContain('Unique body 0');
  app.releaseCommentaryStage();
});
