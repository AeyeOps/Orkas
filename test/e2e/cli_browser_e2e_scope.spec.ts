import { createServer } from 'node:http';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './fixtures/orkas';

// Native executor and real MCP child -> run-local bridge -> real Electron page.
// Local HTTP receipts and rendered responses prove submission without a model.
test('native and CLI browsers read fields, fill credentials, upload and submit once within task scope', async ({ orkas }) => {
  const submissions: string[] = [];
  const credentialReceipts: string[] = [];
  const uploadReceipts: Buffer[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url === '/submit') submissions.push(body.toString('utf8'));
        else if (req.url === '/upload') uploadReceipts.push(body);
        else credentialReceipts.push(body.toString('utf8'));
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(req.url === '/submit' ? `Received: ${body.toString('utf8')}` : 'Accepted');
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Browser scope fixture</title>
      <form id="question"><label>Question<input id="draft"></label><button>发送</button></form>
      <p id="answer" role="status"></p>
      <label>Extra field<input id="conditional" form="question"></label>
      <form id="credentials"><button>Continue</button></form>
      <label>Password<input id="password" type="password" form="credentials" value="fixture-private-value"></label>
      <button id="purchase" type="button">Pay now</button>
      <input aria-label="Attachment" id="upload" type="file" form="question" style="display:none">
      <label>Long draft<textarea id="long"></textarea></label>
      <label>Language<select aria-label="Language"><option value="en">English</option><option value="ja">日本語</option></select></label>
      <script>
        window.protectedActions = 0;
        document.querySelector('#password').addEventListener('input', event => {
          if (!(event instanceof InputEvent)) event.target.value = 'fixture-private-value';
        });
        document.querySelector('#question').addEventListener('submit', async event => {
          event.preventDefault();
          const file = document.querySelector('#upload').files[0];
          if (file) await fetch('/upload', { method: 'POST', body: file, signal: AbortSignal.timeout(5000) });
          const response = await fetch('/submit', { method: 'POST', body: document.querySelector('#draft').value, signal: AbortSignal.timeout(5000) });
          document.querySelector('#answer').textContent = await response.text();
        });
        document.querySelector('#credentials').addEventListener('submit', event => {
          event.preventDefault();
          window.protectedActions++;
          void fetch('/protected', { method: 'POST', body: document.querySelector('#password').value, signal: AbortSignal.timeout(5000) });
        });
        for (const id of ['purchase']) document.getElementById(id).addEventListener('click', () => { window.protectedActions++; });
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = path.resolve(__dirname, '../../');
  const client = new Client({ name: 'browser-scope-test', version: '1' });
  let stderr = '';
  const createTask = async (title: string) => (await orkas.invoke<any>('conversations.create', { title })).conversation.conversation_id as string;
  const selectTask = async (cid: string) => orkas.page!.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
    (window as any).ConversationInfo.openAndSetTab('browser');
  }, cid);
  const cid = await createTask('CLI current browser');
  const otherCid = await createTask('Other conversation browser');
  try {
    await selectTask(otherCid);
    const foreign = await orkas.invoke<any>('webAssist.open', { conversationId: otherCid, url: origin + '/foreign' });
    expect(foreign.ok).toBe(true);
    const foreignId = foreign.state.active_tab_id;
    await selectTask(cid);
    const uploadPath = await orkas.electronApp!.evaluate(async (_electron, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const require = (process as any).mainModule.require;
      const fs = require('node:fs');
      const dir = require(args.root + '/src/main/util/project-layout.ts').chatAttachmentDirForConversation('account-e2e', args.cid);
      fs.mkdirSync(dir, { recursive: true });
      const file = require('node:path').join(dir, 'browser-upload.txt');
      fs.writeFileSync(file, 'Browser upload\n中文\0exact bytes');
      return file;
    }, { root, cid });
    const env = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const require = (process as any).mainModule.require;
      // The production groupChat entry binds its sender before dispatch.
      require(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      require(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
      (globalThis as any).__nativeBrowserTestTool = require(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
      const bridge = await require(args.root + '/src/main/features/local_agents/bridge.ts').startBridge({
        uid: 'account-e2e', cid: args.cid, agentId: 'browser-cli', agentName: 'Browser CLI', cli: 'codex',
        permissionPolicy: 'ask', currentMessageId: 'fixture-message', runId: 'cli-browser-e2e',
        configDir: args.configDir,
        sandboxEnv: { ORKAS_PC_DIR: args.root, ORKAS_NODE: args.node, ORKAS_BUNDLED_NODE: args.node, ORKAS_WORKSPACE_ROOT: args.workspace },
      });
      (globalThis as any).__cliBrowserTestBridge = bridge;
      return bridge.serverEnv;
    }, { root, cid, node: process.execPath, configDir: path.join(orkas.root, 'browser-bridge'), workspace: orkas.workspaceRoot });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/orkas-bridge.cjs')], env, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === 'inner_browser')).toBe(true);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'inner_browser', arguments: args });
      const data = JSON.parse((result.content as any[])[0].text);
      return { ...data, isError: result.isError === true };
    };
    const nativeCall = async (args: Record<string, unknown>) => orkas.electronApp!.evaluate(async (_electron, input) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const result = await (globalThis as any).__nativeBrowserTestTool.execute(input, { state: {} });
      return { ...JSON.parse(result.content), isError: result.isError === true };
    }, args);
    const opened = await call({ operation: 'open', url: origin + '/current' });
    expect(opened).toMatchObject({ ok: true });
    const tabId = opened.active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    const listed = await call({ operation: 'tabs' });
    expect(listed.tabs.some((tab: any) => tab.tab_id === tabId)).toBe(true);
    expect(listed.tabs.some((tab: any) => tab.tab_id === foreignId)).toBe(false);
    let observed = await call({ operation: 'observe', tab_id: tabId });
    const field = observed.elements.find((element: any) => element.label === 'Question');
    expect(field).toBeTruthy();
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'orkas' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'Revised draft' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'read_value', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref })).toMatchObject({ ok: true, value: 'Revised draft' });
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'orkas' })).toMatchObject({ ok: true });
    const readPageState = () => orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url)!;
      return page.executeJavaScript(`({ answer: document.querySelector('#answer').textContent, password: document.querySelector('#password').value, protectedActions: window.protectedActions })`);
    }, origin + '/current');
    let expectedSubmissions = 0;
    for (const [lane, submitCall] of [['CLI', call], ['native', nativeCall]] as const) {
      await test.step(`${lane}: exact readback, sensitive fill without echo, upload and submission`, async () => {
        const observe = () => submitCall({ operation: 'observe', tab_id: tabId });
        const control = (snapshot: any, label: string) => {
          const entry = snapshot.elements.find((element: any) => element.label === label);
          expect(entry, label).toBeTruthy();
          return { tab_id: tabId, page_id: snapshot.page_id, element_ref: entry.ref };
        };
        observed = await observe();
        expect(JSON.stringify(observed)).not.toContain('fixture-private-value');
        expect(await submitCall({ operation: 'read_value', ...control(observed, 'Question') })).toMatchObject({ ok: true, value: 'orkas', untrusted_content: true });
        const longValue = ('  中文🙂\tJapanese\n\n').repeat(800) + '  tail\n';
        expect(await submitCall({ operation: 'act', ...control(observed, 'Long draft'), page_action: 'fill', text: longValue })).toMatchObject({ ok: true });
        observed = await observe();
        let actual = '', offset = 0;
        for (;;) {
          const chunk = await submitCall({ operation: 'read_value', ...control(observed, 'Long draft'), text_offset: offset });
          expect(chunk).toMatchObject({ ok: true, value_total: longValue.length, untrusted_content: true });
          actual += chunk.value;
          if (chunk.value_next_offset === null) break;
          offset = chunk.value_next_offset;
        }
        expect(actual).toBe(longValue);
        expect(await submitCall({ operation: 'act', ...control(observed, 'Language'), page_action: 'select', text: 'ja' })).toMatchObject({ ok: true });
        observed = await observe();
        expect(await submitCall({ operation: 'read_value', ...control(observed, 'Language') })).toMatchObject({ ok: true, value: 'ja', selected_options: ['日本語'] });

        const secret = `fixture-secret-${lane}`;
        const filled = await submitCall({ operation: 'act', ...control(observed, 'Password'), page_action: 'fill', text: secret });
        expect(filled).toMatchObject({ ok: true });
        expect(JSON.stringify(filled)).not.toContain(secret);
        observed = await observe();
        expect(JSON.stringify(observed)).not.toContain(secret);
        const unreadable = await submitCall({ operation: 'read_value', ...control(observed, 'Password') });
        expect(unreadable).toMatchObject({ ok: false, code: 'value_not_readable' });
        expect(JSON.stringify(unreadable)).not.toContain(secret);
        expect(unreadable).not.toHaveProperty('value_total');
        expect(await submitCall({ operation: 'act', ...control(observed, 'Continue'), page_action: 'click' })).toMatchObject({ ok: true });
        await expect.poll(() => credentialReceipts.at(-1)).toBe(secret);
        observed = await observe();
        expect(await submitCall({ operation: 'act', ...control(observed, 'Pay now'), page_action: 'click' })).toMatchObject({ ok: true });
        expect(await readPageState()).toMatchObject({ password: secret, protectedActions: 2 * (expectedSubmissions + 1) });
        observed = await observe();
        const upload = await submitCall({ operation: 'act', ...control(observed, 'Attachment'), page_action: 'upload', file_paths: [uploadPath] });
        expect(upload, JSON.stringify(upload)).toMatchObject({ ok: true, file_count: 1 });
        expect(JSON.stringify(upload)).not.toContain(uploadPath);
        expect(uploadReceipts).toHaveLength(expectedSubmissions);
        observed = await observe();
        const click = { operation: 'act', ...control(observed, '发送'), page_action: 'click' };
        // A field becomes sensitive after observation. Submission is authorized;
        // stale-page replay must still never submit it twice.
        await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
          await webContents.getAllWebContents().find(contents => contents.getURL() === url)!
            .executeJavaScript("document.querySelector('#conditional').type = 'password'");
        }, origin + '/current');
        expect(await submitCall(click)).toMatchObject({ ok: true, outcome: 'acted', isError: false });
        expect(await submitCall(click)).toMatchObject({ ok: false, code: 'stale_page', isError: true });
        expectedSubmissions += 1;
        await expect.poll(() => submissions.length).toBe(expectedSubmissions);
        expect(submissions).toEqual(Array(expectedSubmissions).fill('orkas'));
        await expect.poll(() => uploadReceipts.length).toBe(expectedSubmissions);
        expect(uploadReceipts.at(-1)).toEqual(Buffer.from('Browser upload\n中文\0exact bytes'));
        expect(await submitCall({ operation: 'wait', tab_id: tabId, wait_condition: 'text', text: 'Received: orkas' })).toMatchObject({ ok: true });
        expect(await orkas.page!.locator('.bash-permission-dialog').count()).toBe(0);
      });
    }
    for (const input of [
      { operation: 'observe' }, { operation: 'read_value', page_id: observed.page_id, element_ref: field.ref },
      { operation: 'act', page_id: observed.page_id, element_ref: field.ref, page_action: 'upload', file_paths: [uploadPath] }, { operation: 'navigate', navigation: 'goto', url: origin + '/forbidden' },
      { operation: 'act', page_id: observed.page_id, element_ref: field.ref, page_action: 'click' },
      { operation: 'wait' }, { operation: 'retain', retention: 'temporary' }, { operation: 'close' },
    ]) expect(await call({ ...input, tab_id: foreignId })).toMatchObject({ ok: false, code: 'unknown_tab', isError: true });
    // Switching the UI does not transfer this CLI's authority to that task. It
    // also no longer stops the CLI from driving its own task: the work keeps
    // running in the background, it just lands in its own tabs.
    await selectTask(otherCid);
    const backgroundList = await call({ operation: 'tabs' });
    expect(backgroundList).toMatchObject({ ok: true });
    expect(backgroundList.tabs.some((tab: any) => tab.tab_id === foreignId)).toBe(false);
    expect(await call({ operation: 'open', url: origin + '/forbidden' })).toMatchObject({ ok: true });
    const state = (await orkas.invoke<any>('webAssist.state', {})).state;
    // The task the user is now watching keeps its own page: the background open
    // landed in the CLI's task, never in this one.
    expect(state.tabs.find((tab: any) => tab.tab_id === foreignId).address_url).toBe(origin + '/foreign');
    expect(state.tabs.find((tab: any) => tab.address_url === origin + '/forbidden')?.tab_id)
      .not.toBe(foreignId);
    await selectTask(cid);
    const policies: Array<{ id: string; path: string; retention: string }> = [];
    for (const [lane, openCall] of [['native', nativeCall], ['CLI', call]] as const) {
      for (const retention of ['temporary', 'deliverable', 'handoff']) {
        const path = `/${lane}-${retention}`;
        const result = await openCall({ operation: 'open', url: origin + path, retention });
        expect(result).toMatchObject({ ok: true, tab: { retention } });
        expect(await openCall({ operation: 'wait', tab_id: result.active_tab_id })).toMatchObject({ ok: true });
        policies.push({ id: result.active_tab_id, path, retention });
      }
    }
    await orkas.electronApp!.evaluate((_electron, args) => {
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    const remaining = (await orkas.invoke<any>('webAssist.state', {})).state.tabs.map((tab: any) => tab.tab_id);
    for (const policy of policies) expect(remaining.includes(policy.id)).toBe(policy.retention !== 'temporary');
    expect(remaining).toContain(tabId); // An unmarked model page stays open.
    expect(remaining).toContain(foreignId); // A user page in another task stays open.
    const nativePaths = await orkas.electronApp!.evaluate(({ webContents }, base) => webContents.getAllWebContents()
      .map(contents => contents.getURL()).filter(url => url.startsWith(base)).map(url => new URL(url).pathname), origin);
    for (const policy of policies) expect(nativePaths.includes(policy.path)).toBe(policy.retention !== 'temporary');
    expect(await call({ operation: 'open', url: origin + '/late' })).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
    expect(await nativeCall({ operation: 'open', url: origin + '/late' })).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
    expect(submissions).toEqual(['orkas', 'orkas']);
    expect(credentialReceipts).toEqual(['fixture-secret-CLI', 'fixture-secret-native']);
  } finally {
    await client.close();
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      await (globalThis as any).__cliBrowserTestBridge?.close();
      delete (globalThis as any).__cliBrowserTestBridge;
      delete (globalThis as any).__nativeBrowserTestTool;
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(stderr).toBe('');
  }
});
