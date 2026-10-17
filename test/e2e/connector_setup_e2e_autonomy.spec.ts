import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test as base, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';
import { CONNECTOR_AUTONOMY_LIMITS } from './fixtures/connector-autonomy-main';
import { connectorCompletionAccepted, connectorHandbackAccepted, connectorSilentHandbackAccepted } from './fixtures/connector-autonomy-evidence';

// Reuse the existing log classifier. Retain every stream even on success;
// unexpected errors, stderr and coverage gaps invalidate the model evidence.
const test = base.extend<{ autonomyOrkas: OrkasTestApp }>({
  autonomyOrkas: async ({}, use, info) => {
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
        expect(analysis.passed, 'Review complete retained log findings').toBe(true);
      }
    }
  },
});
test.describe.configure({ retries: 0, timeout: CONNECTOR_AUTONOMY_LIMITS.timeoutMs + 60_000 });
const helper = path.resolve(__dirname, 'fixtures/connector-autonomy-main.ts');

// A logged-in merchant asks Commander to complete application registration.
// The sample's failure was premature human handoff. Real trusted browser input
// and a service-owned receipt distinguish delivery from prose or direct fetch.
for (const mode of ['calibration', 'early-stop', 'omit-page', 'blank-ref'] as const) {
  const selectedTest = test;
  const argumentFault = mode === 'omit-page' || mode === 'blank-ref' ? mode : undefined;
  selectedTest(`${mode} Commander ${argumentFault ? 'rejects unusable shop browser arguments'
    : 'completes a shop application without manual browser relay'}`, async ({ autonomyOrkas: orkas }, info) => {
    const saved: Array<{ callback: string; trusted: boolean }> = [];
    const consoleClicks: boolean[] = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url?.startsWith('/console?')) {
        consoleClicks.push(new URL(request.url, 'http://localhost').searchParams.get('trusted') === 'true');
        response.end('Console opened'); return;
      }
      if (request.url === '/save' && request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => { saved.push(JSON.parse(body)); response.end('Application saved'); });
        return;
      }
      if (request.url === '/application') {
        response.end(`<!doctype html><h2>Merchant application</h2><form>
          <label>Callback<input aria-label="Callback"></label><button>Save application</button></form><output></output>
          <script>document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();
          const result=await fetch('/save',{method:'POST',body:JSON.stringify({callback:document.querySelector('input').value,trusted:event.isTrusted})});
          document.querySelector('output').textContent=await result.text();})</script>`); return;
      }
      response.end(`<!doctype html><style>body{margin:0;font:18px sans-serif}h1{font-size:20px;margin:10px 80px}
        #console{position:absolute;left:80px;top:80px;width:150px;height:40px;background:#ccc;text-align:center;line-height:40px}
        iframe{display:none;position:absolute;left:80px;top:150px;width:450px;height:220px}</style>
        <h1>Fixture shop — signed in</h1><div id="console">Console</div><iframe src="/application"></iframe>
        <script>document.getElementById('console').addEventListener('click',event=>{
        fetch('/console?trusted='+event.isTrusted);document.querySelector('iframe').style.display='block';})</script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Merchant application' })).conversation.conversation_id;
    try {
      await orkas.page.evaluate(async id => {
        await (window as any).loadConversations(); (window as any).setView('conversation', id);
      }, cid);
      await orkas.electronApp!.evaluate(async (_electron, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        (globalThis as any).__connectorAutonomy = await (process as any).mainModule.require(args.helper)
          .installConnectorAutonomy(args.input);
      }, { helper, input: { cid, url, earlyStop: mode === 'early-stop', argumentFault,
         } });
      // The sampled handoff occurs after login in an already-open provider
      // page. A prose claim of login with an empty browser is not this state.
      const seeded = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const web = (process as any).mainModule.require(args.root + '/src/main/features/web_assist.ts');
        web.bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
        const opened = await web.openControlledWebAssist('account-e2e', args.cid,
          { scope: 'connector_setup', scopeId: 'fixture-shop', url: args.url });
        if (!opened.ok) return opened;
        return web.waitForControlledWebAssist('account-e2e', args.cid, 'fixture-shop', { condition: 'loaded' });
      }, { root: path.resolve(__dirname, '../..'), cid, url });
      expect(seeded.ok, 'Signed-in provider page must exist before the user turn').toBe(true);
      // Natural task requirements only; refs, coordinates and evaluator
      // expectations never enter this user turn or the production prompt.
      const sent = await orkas.invoke<any>('groupChat.send', { cid,
        content: '帮我完成 Fixture shop 的店铺应用登记。店铺主账号已经登录，回调地址填 https://merchant.example/callback。我确认提交，请保存应用并检查页面上的保存结果。' });
      expect(sent.ok, 'User turn must be admitted').toBe(true);
      await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy.snapshot().terminal),
        { timeout: 30_000 }).toBeTruthy();
      const evidence = await orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy.snapshot());
      mkdirSync(info.outputDir, { recursive: true });
      writeFileSync(info.outputPath('connector-evidence.json'), JSON.stringify({ ...evidence, consoleClicks, saved }, null, 2));
      expect(evidence.overflow).toBe(false);
      expect(evidence.argumentAuditOverflow, 'Incomplete argument correlation is not valid model evidence').toBe(false);
      expect(evidence.terminal).toBe('completed');
      if (argumentFault) {
        expect(saved).toEqual([]);
        expect(connectorCompletionAccepted(evidence, saved)).toBe(false);
        expect(evidence.traces.filter((trace: any) => trace.failed)).toEqual([{ name: 'inner_browser', failed: true }]);
        const failed = evidence.argumentAudits.find((audit: any) => audit.tool === 'inner_browser'
          && audit.operation === 'act' && audit.action === 'click' && !audit.providerHasPoint);
        expect(failed).toMatchObject({ schemaHasPageId: true, schemaHasElementRef: true,
          contextComplete: true, contextHasPageId: true, contextHasElementRef: true, runtimeSkipped: false,
          providerInputObject: true, runtimeInputObject: true });
        if (argumentFault === 'omit-page') expect(failed).toMatchObject({ providerHasPageIdKey: false,
          providerHasPageId: false, runtimeHasPageIdKey: false, runtimeHasPageId: false,
          historyHasPageIdKey: false, historyHasPageId: false, runtimeElementRefMatchesProvider: true });
        else expect(failed).toMatchObject({ providerHasElementRefKey: true, providerHasElementRef: false,
          runtimeHasElementRefKey: true, runtimeHasElementRef: false,
          historyHasElementRefKey: true, historyHasElementRef: false,
          runtimeElementRefMatchesProvider: true, runtimePageIdMatchesProvider: true });
      } else if (mode === 'early-stop') {
        expect(saved).toEqual([]); expect(consoleClicks).toEqual([]);
        expect(connectorCompletionAccepted(evidence, saved), 'The completion gate must reject an early human handoff').toBe(false);
      } else {
        expect(saved, 'Prose completion or human handoff cannot replace the provider receipt')
          .toEqual([{ callback: 'https://merchant.example/callback', trusted: true }]);
        expect(connectorCompletionAccepted(evidence, saved), 'Completion requires trusted save and browser readback').toBe(true);
        expect(connectorCompletionAccepted(evidence, [...saved, ...saved]), 'Duplicate submission must fail acceptance').toBe(false);
        expect(connectorCompletionAccepted(evidence, [{ ...saved[0], trusted: false }]), 'Direct fetch is not browser completion').toBe(false);
        if (mode === 'calibration') {
          expect(Array.isArray(evidence.argumentAudits), 'Retain provider arguments and their model-visible context').toBe(true);
          expect(evidence.argumentAuditOverflow).toBe(false);
          const fillAudit = evidence.argumentAudits.find((audit: any) => audit.tool === 'inner_browser' && audit.action === 'fill');
          expect(fillAudit).toMatchObject({ schemaHasPageId: true, schemaHasElementRef: true,
            contextHasPageId: true, contextHasElementRef: true, providerHasPageId: true, providerHasElementRef: true,
            pageIdInContext: true, elementRefOnPageInContext: true, historyHasPageId: true, historyHasElementRef: true,
            runtimeSkipped: false, runtimeHasPageId: true, runtimeHasElementRef: true,
            runtimePageIdMatchesProvider: true, runtimeElementRefMatchesProvider: true });
          // This actor specifically calibrates the visual Console/iframe path.
          // The live actor may instead navigate to the provider's same-site form.
          expect(consoleClicks).toEqual([true]);
          expect(evidence.traces.filter((trace: any) => trace.failed)).toEqual([]);
          expect(evidence.screenshotReceipts, 'Actual screenshot must reach the calibration actor').toBeGreaterThan(0);
          // Console's generic click must not mask rejection of the actual
          // connector-controlled Save click. Keep the independent save/readback.
          const connectorClickEvidence = { ...evidence, receipts: evidence.receipts.filter((receipt: any) =>
            !(receipt.name === 'inner_browser' && receipt.operation === 'act' && receipt.action === 'click')) };
          expect(connectorCompletionAccepted(connectorClickEvidence, saved),
            'Connector browser submission has the same completion contract').toBe(true);
        }
        expect(evidence.savedObserved, 'Commander must read the saved page result').toBe(true);
      }
    } finally {
      const snapshot = await orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy?.snapshot());
      mkdirSync(info.outputDir, { recursive: true });
      writeFileSync(info.outputPath('connector-evidence.json'), JSON.stringify({ ...snapshot, consoleClicks, saved,
        outcomePassed: connectorCompletionAccepted(snapshot, saved) }, null, 2));
      await orkas.electronApp!.evaluate(async () => {
        if ((globalThis as any).__connectorAutonomy) await (globalThis as any).__connectorAutonomy.restore();
        delete (globalThis as any).__connectorAutonomy;
      });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

// The human handles the private challenge and sends a normal acknowledgement.
// The assistant receives no refs, coordinates, scripted continuation or OTP.
for (const journey of ['acknowledged', 'silent'] as const) for (const mode of ['calibration', 'early-stop'] as const) {
  const selectedTest = test;
  selectedTest(`${mode} Commander ${journey === 'silent' ? 'continues after verification without another message'
    : 'resumes the existing shop draft after human verification'}`, async ({ autonomyOrkas: orkas }, info) => {
    const saved: Array<{ callback: string; trusted: boolean }> = [];
    const verifications: Array<{ callback: string; trusted: boolean }> = [];
    let applicationLoads = 0;
    let humanControlled = false;
    let tabId: string;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const data = JSON.parse(body);
          const receipt = { callback: data.callback, trusted: data.trusted === true };
          if (request.url === '/verify' && data.code === '741852') {
            verifications.push(receipt); response.end('Verification complete'); return;
          }
          if (request.url === '/save' && verifications.length === 1) {
            saved.push(receipt); response.end('Application saved'); return;
          }
          response.writeHead(403); response.end('Verification required');
        });
        return;
      }
      applicationLoads++;
      response.end(`<!doctype html><h2>Fixture shop — signed in</h2>
        <form id="application"><label>Callback<input id="callback" value="https://merchant.example/callback"></label>
        <button>Save application</button></form><section id="challenge">
        <form id="verification"><label>Verification code<input id="code" autocomplete="one-time-code"></label>
        <button>Verify code</button></form></section><output id="result"></output><script>
        let verified=false;
        application.addEventListener('submit',async event=>{event.preventDefault();
          if(!verified){challenge.hidden=false;return;}
          result.textContent=await (await fetch('/save',{method:'POST',body:JSON.stringify({callback:callback.value,trusted:event.isTrusted})})).text();});
        verification.addEventListener('submit',async event=>{event.preventDefault();
          const response=await fetch('/verify',{method:'POST',body:JSON.stringify({code:code.value,callback:callback.value,trusted:event.isTrusted})});
          if(response.ok){verified=true;challenge.hidden=true;result.textContent=await response.text();}});
        </script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const root = path.resolve(__dirname, '../..');
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Merchant verification handback' })).conversation.conversation_id;
    const tabs = () => orkas.electronApp!.evaluate(async (_electron, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return (process as any).mainModule.require(args.root + '/src/main/features/web_assist.ts')
        .listModelWebAssistTabs('account-e2e', args.cid);
    }, { root, cid });
    try {
      await orkas.page.evaluate(async id => {
        await (window as any).loadConversations(); (window as any).setView('conversation', id);
      }, cid);
      const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const web = (process as any).mainModule.require(args.root + '/src/main/features/web_assist.ts');
        const owner = BrowserWindow.getAllWindows()[0];
        web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
        const result = await web.openControlledWebAssist('account-e2e', args.cid,
          { scope: 'connector_setup', scopeId: 'fixture-shop', url: args.url });
        if (result.ok) await web.waitForControlledWebAssist('account-e2e', args.cid, 'fixture-shop', { condition: 'loaded' });
        owner.setFocusable(true); owner.show(); owner.focus();
        return result;
      }, { root, cid, url });
      expect(opened.ok).toBe(true);
      await orkas.page.evaluate(() => (window as any).ConversationInfo.openAndSetTab('browser'));
      await expect(orkas.page.locator('.web-assist-shell')).toBeVisible();
      tabId = (await tabs()).tabs[0].tab_id;
      // Only the human actor inspects this fixture DOM for pointer positioning.
      // Native events exercise the real activity lease and trusted verification.
      const human = (selector: string, text?: string) => orkas.electronApp!.evaluate(async ({ BrowserWindow, webContents }, args) => {
        const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(args.url))!;
        contents.focus();
        const point = await contents.executeJavaScript(`(() => {
          const element=document.querySelector(${JSON.stringify(args.selector)}); element.focus();
          if(element.select) element.select(); const rect=element.getBoundingClientRect();
          return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,width:window.innerWidth};})()`);
        if (args.text !== undefined) {
          for (const character of args.text) for (const type of ['keyDown', 'char', 'keyUp'] as const)
            contents.sendInputEvent({ type, keyCode: character });
        } else {
          const view = BrowserWindow.getAllWindows()[0].contentView.children.find(view => (view as any).webContents === contents)!;
          const scale = view.getBounds().width / point.width;
          const position = { x: Math.round(point.x * scale), y: Math.round(point.y * scale) };
          contents.sendInputEvent({ type: 'mouseMove', ...position });
          contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
          contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
        }
      }, { url, selector, text });
      const verify = async () => {
        await human('#code', '741852');
        await expect.poll(async () => (await tabs()).tabs[0].user_controlled).toBe(true);
        humanControlled = true;
        await human('#verification button');
        await expect.poll(() => verifications).toEqual([{ callback: 'https://merchant.example/callback', trusted: true }]);
        expect(saved).toEqual([]);
        // The human watches the conversation after verification. Native focus
        // changes only; no handback API, acknowledgement or new user turn.
        await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.focus());
      };
      await orkas.electronApp!.evaluate(async (_electron, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        (globalThis as any).__connectorAutonomy = await (process as any).mainModule.require(args.helper)
          .installConnectorAutonomy(args.input);
      }, { helper, input: { cid, url, earlyStop: mode === 'early-stop', handback: true,
        silentHandback: journey === 'silent',
         } });
      // Cold fixture setup can exceed the real 10-second human-input lease.
      // Install the driver before the human acts, then acknowledge verification.
      if (journey === 'acknowledged') await verify();
      if (journey === 'acknowledged') expect((await tabs()).tabs[0].user_controlled,
        'User acknowledgement follows actual native verification').toBe(true);
      const sent = await orkas.invoke<any>('groupChat.send', { cid,
        content: journey === 'silent'
          ? '请完成 Fixture shop 这份申请，主账号已登录，回调地址已填好。验证码我来处理，之后请接着保存申请并检查保存结果。我确认提交。'
          : 'Fixture shop 的主账号已登录，申请表里的回调地址已填好。验证码我刚刚处理完成了，请接着保存这份申请并检查保存结果。我确认提交。' });
      expect(sent.ok).toBe(true);
      if (journey === 'silent') {
        // Authoritative tool receipts/lifecycle schedule the human actor. Never
        // inspect the assistant's prose to synthesize an acknowledgement.
        await expect.poll(() => orkas.electronApp!.evaluate(() => {
          const state = (globalThis as any).__connectorAutonomy.snapshot();
          return state.challengeObserved || state.pageWaitStarted || !!state.terminal;
        }), { timeout: 30_000 }).toBe(true);
        await verify();
      }
      await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy.snapshot().terminal),
        { timeout: 30_000 }).toBeTruthy();
      const evidence = await orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy.snapshot());
      const facts = { humanControlled, verifications, applicationLoads,
        sameTab: JSON.stringify((await tabs()).tabs.map((tab: any) => tab.tab_id)) === JSON.stringify([tabId]) };
      expect(evidence.overflow).toBe(false);
      expect(evidence.argumentAuditOverflow).toBe(false);
      expect(evidence.terminal).toBe('completed');
      expect(evidence.userMessages, 'No synthetic user acknowledgement may resume the assistant').toBe(1);
      const accepted = journey === 'silent' ? connectorSilentHandbackAccepted : connectorHandbackAccepted;
      expect(accepted(evidence, saved, facts)).toBe(mode !== 'early-stop');
      if (mode === 'early-stop') expect(saved).toEqual([]);
      else {
        expect(saved).toEqual([{ callback: 'https://merchant.example/callback', trusted: true }]);
        expect(facts).toMatchObject({ applicationLoads: 1, sameTab: true });
        if (mode === 'calibration') expect(evidence.traces.filter((trace: any) => trace.failed)).toEqual([]);
      }
    } finally {
      const snapshot = await orkas.electronApp!.evaluate(() => (globalThis as any).__connectorAutonomy?.snapshot());
      const currentTabs = await tabs();
      const facts = { humanControlled, verifications, applicationLoads,
        sameTab: currentTabs.tabs.length === 1 && currentTabs.tabs[0].tab_id === tabId! };
      mkdirSync(info.outputDir, { recursive: true });
      writeFileSync(info.outputPath('connector-evidence.json'), JSON.stringify({ ...snapshot, saved, handback: facts,
        outcomePassed: (journey === 'silent' ? connectorSilentHandbackAccepted : connectorHandbackAccepted)(snapshot, saved, facts) }, null, 2));
      await orkas.electronApp!.evaluate(async () => {
        await (globalThis as any).__connectorAutonomy?.restore(); delete (globalThis as any).__connectorAutonomy;
      });
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
