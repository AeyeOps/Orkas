import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test as base, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const test = base.extend({
  orkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info, { });
    try { await app.launch(); await use(app); }
    finally {
      try { await app.dispose(); }
      finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const logPath = info.outputPath('electron-main.log');
        expect(existsSync(logPath)).toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(logPath, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review retained native dialog log findings').toBe(true);
      }
    }
  },
});

test('AI native dialogs resume website scripts without modal UI and preserve manual handling', async ({ orkas }) => {
  test.setTimeout(90_000);
  // Playwright normally dismisses unattended dialogs itself. Observe only so
  // the production host, rather than the harness, determines website results.
  orkas.electronApp!.context().on('page', page => page.on('dialog', () => {}));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Dialog journey</title><script>alert('Welcome'); window.alertFinished = true;</script>
      <button onclick="window.confirmResult = confirm('Continue?'); window.effects = (window.effects || 0) + 1">Confirm</button>
      <button onclick="window.promptResult = prompt('Your name?', 'private-default')">Prompt</button>
      <button onclick="window.wakeResult='pending'; navigator.wakeLock.request('screen').then(lock => {window.wakeResult='allowed'; window.wake=lock;}, error => window.wakeResult=error.name)">Wake</button>
      <button onclick="window.notificationResult='pending'; Notification.requestPermission().then(value => window.notificationResult=value)">Notify</button>
      <input aria-label="Draft"><iframe srcdoc="<button onclick=&quot;parent.frameResult = confirm('Frame confirmation')&quot;>Frame confirm</button>"></iframe>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const created = await orkas.invoke<any>('conversations.create', { title: 'Native dialogs' });
  const args = { cid: created.conversation.conversation_id,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    webPath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    lifePath: path.resolve(__dirname, '../../src/main/features/web_assist_lifecycle.ts') };
  try {
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, dialog }, a) => {
      const web = (process as any).mainModule.require(a.webPath);
      const state = (globalThis as any).__dialogTest = { nativeCalls: 0, original: dialog.showMessageBox, tabId: '' };
      dialog.showMessageBox = (async () => { state.nativeCalls++; return { response: 1, checkboxChecked: false }; }) as any;
      (process as any).mainModule.require(a.lifePath).beginBrowserTaskRun('account-e2e', a.cid, 'dialogs');
      web.bindWebAssistConversation('account-e2e', a.cid, BrowserWindow.getAllWindows()[0].webContents);
      state.tabId = (await web.openModelWebAssist('account-e2e', a.cid, { url: a.url })).active_tab_id;
    }, args);
    const observe = (frameId?: string) => orkas.electronApp!.evaluate(async (_electron, a) => {
      return (process as any).mainModule.require(a.webPath).observeModelWebAssist('account-e2e', a.cid,
        (globalThis as any).__dialogTest.tabId, 'full', a.frameId ? { frameId: a.frameId } : {});
    }, { ...args, frameId });
    const act = (s: any, action: string, ref: string, text?: string) => orkas.electronApp!.evaluate(async (_electron, a) => {
      return (process as any).mainModule.require(a.webPath).actOnModelWebAssist('account-e2e', a.cid, {
        tabId: (globalThis as any).__dialogTest.tabId, pageId: a.pageId, elementRef: a.ref, action: a.action,
        ...(a.text === undefined ? {} : { text: a.text }),
      });
    }, { ...args, pageId: s.page_id, ref, action, text });
    const facts = () => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return { nativeCalls: (globalThis as any).__dialogTest.nativeCalls,
        page: await view.webContents.executeJavaScript('({ alertFinished, confirmResult: window.confirmResult, promptResult: window.promptResult, effects: window.effects, frameResult: window.frameResult })') };
    });
    await expect.poll(async () => (await facts()).page.alertFinished).toBe(true);
    let s = await observe();
    expect(s).toMatchObject({ ok: true, dismissed_dialogs: [{ type: 'alert', message: 'Welcome' }] });
    expect((await facts()).nativeCalls).toBe(0);
    const ref = (s: any, label: string) => s.elements.find((e: any) => e.label === label)?.ref;
    for (const label of ['Wake', 'Notify']) {
      s = await observe();
      expect(await act(s, 'click', ref(s, label))).toMatchObject({ ok: true });
      await expect.poll(async () => (await observe()).dialog_type).toBe('permission');
      const waited = await orkas.electronApp!.evaluate(async (_e, a) => (process as any).mainModule.require(a.webPath)
        .waitForModelWebAssist('account-e2e', a.cid, { condition: 'loaded' }), args);
      expect(waited).toMatchObject({ dialog_type: 'permission', condition_matched: false });
      s = await observe();
      expect(s).toMatchObject({ requires_user_action: label !== 'Wake' });
      expect(await act(s, 'click', ref(s, label === 'Wake' ? 'Allow' : 'Deny'))).toMatchObject({ ok: true });
      await expect.poll(() => orkas.electronApp!.evaluate(async ({ webContents }, a) => webContents.getAllWebContents()
        .find(w => w.getURL() === a.url)!.executeJavaScript(a.label === 'Wake' ? 'window.wakeResult' : 'window.notificationResult'), { ...args, label }))
        .toBe(label === 'Wake' ? 'allowed' : 'denied');
    }
    for (const accepted of [true, false]) {
      s = await observe();
      const clicked = await act(s, 'click', ref(s, 'Confirm'));
      expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true });
      s = await observe();
      expect(s).toMatchObject({ ok: true, dialog_type: 'confirm', text: 'Continue?', untrusted_content: true });
      expect(await act(s, 'click', ref(s, accepted ? 'OK' : 'Cancel'))).toMatchObject({ ok: true });
      expect(await act(s, 'click', ref(s, 'OK'))).toMatchObject({ ok: false, code: 'stale_page' });
      await expect.poll(async () => (await facts()).page.confirmResult).toBe(accepted);
    }
    expect((await facts()).page.effects).toBe(2);
    for (const accepted of [true, false]) {
      s = await observe();
      expect(await act(s, 'click', ref(s, 'Prompt'))).toMatchObject({ ok: true });
      s = await observe();
      expect(s.dialog_type).toBe('prompt');
      expect(JSON.stringify(s)).not.toContain('private-default');
      const value = '  张三\n😀  ';
      expect(await act(s, 'fill', s.elements.find((e: any) => e.fillable).ref, value)).toMatchObject({ ok: true });
      expect(await act(s, 'click', ref(s, accepted ? 'OK' : 'Cancel'))).toMatchObject({ ok: true });
      await expect.poll(async () => (await facts()).page.promptResult).toBe(accepted ? value : null);
    }
    s = await observe();
    const frame = s.frames.find((f: any) => f.frame_id !== s.frame_id);
    s = await observe(frame.frame_id);
    expect(await act(s, 'click', ref(s, 'Frame confirm'))).toMatchObject({ ok: true });
    s = await observe();
    expect(s).toMatchObject({ dialog_type: 'confirm', text: 'Frame confirmation' });
    expect(await act(s, 'click', ref(s, 'Cancel'))).toMatchObject({ ok: true });
    await expect.poll(async () => (await facts()).page.frameResult).toBe(false);
    expect((await facts()).nativeCalls).toBe(0);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, a) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("document.querySelector('input').value = 'unsaved'; window.onbeforeunload = () => true; true");
      await (process as any).mainModule.require(a.webPath).navigateModelWebAssist('account-e2e', a.cid, { action: 'goto', url: a.url + 'leave' });
    }, args);
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
    expect(await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return view.webContents.getURL();
    })).toBe(args.url);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, a) => {
      (process as any).mainModule.require(a.lifePath).finishBrowserTaskRun('account-e2e', a.cid, 'dialogs');
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("alert('Manual alert')");
    }, args);
    expect((await facts()).nativeCalls).toBe(1);
    const manualPrompt = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return view.webContents.executeJavaScript("(() => { try { prompt('Manual'); return 'unexpected'; } catch (error) { return error.message; } })()");
    });
    expect(manualPrompt).toBe('prompt() is not supported.');
    // Session preloads also run in unowned authorization windows. Their sync
    // prompt request must be released without access to task browser decisions.
    const unowned = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, a) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      const popup = new BrowserWindow({ show: false, webPreferences: { session: view.webContents.session, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      // Supply the existing activity preload's viewport handshake so this
      // unowned-window case isolates prompt fallback without a viewport stall.
      popup.webContents.ipc.on('web-assist:viewport-factor', event => { event.returnValue = 1; });
      try {
        await popup.loadURL(a.url);
        return await popup.webContents.executeJavaScript("(() => { try { prompt('Manual'); return 'unexpected'; } catch (error) { return error.message; } })()");
      } finally { popup.destroy(); }
    }, args);
    expect(unowned).toBe('prompt() is not supported.');
  } finally {
    await orkas.electronApp?.evaluate(({ dialog }, a) => {
      (process as any).mainModule.require(a.lifePath).finishBrowserTaskRun('account-e2e', a.cid, 'dialogs');
      const state = (globalThis as any).__dialogTest;
      if (state) dialog.showMessageBox = state.original;
    }, args);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
