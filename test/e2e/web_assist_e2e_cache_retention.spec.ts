import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

const { collectLogFiles } = require('./fixtures/electron-log-files.cjs') as { collectLogFiles(root: string): string };

// Exercise the platform's real backend. Chromium 148 defaults to blockfile on
// Windows and simple on macOS/Linux; do not claim a flag simulated Windows I/O.
for (const backend of [process.platform === 'win32' ? 'blockfile' : 'simple'] as const) {
  test(`startup cache retention preserves website data and skips an already used browser (${backend})`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const orkas = new OrkasTestApp(testInfo, { rootParent: homedir() });
    const hits = { old: 0, recent: 0 };
    const server = createServer((req, res) => {
      if (req.url === '/old' || req.url === '/recent') {
        hits[req.url.slice(1) as keyof typeof hits]++;
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        res.end('resource'.repeat(20_000));
      } else {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html');
        res.end('<title>Cache retention</title><h1>Ready</h1>');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await orkas.launch();
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const created = await orkas.invoke<any>('conversations.create', { title: 'Cache retention' });
      const open = async () => {
        expect(await orkas.invoke<any>('webAssist.open', { conversationId: created.conversation.conversation_id, url: origin })).toMatchObject({ ok: true });
        await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
      };
      const run = (code: string) => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, script) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v instanceof WebContentsView).at(-1) as InstanceType<typeof WebContentsView>;
        return view.webContents.executeJavaScript(script);
      }, code);
      const fetchBoth = async () => {
        expect(await run("Promise.all(['/old', '/recent'].map(url => fetch(url).then(r => r.text()).then(s => s.length)))")).toEqual([160_000, 160_000]);
      };
      const sweep = () => orkas.electronApp!.evaluate(async (_electron, modulePath) => {
        const mod = (process as any).mainModule.require(modulePath);
        return mod.sweepWebAssistCache('account-e2e');
      }, path.resolve(__dirname, '../../src/main/features/web_assist_cache.ts'));
      const sweepCount = () => collectLogFiles(orkas.root).split('HTTP cache maintenance finished').length - 1;
      const waitForBootSweep = async (previous: number) => {
        // Observe the real idle boot task before querying its memoized result;
        // this case must fail if index.ts forgets to register maintenance.
        await expect.poll(sweepCount, { timeout: 65_000, intervals: [500] }).toBeGreaterThan(previous);
        return sweep();
      };
      const data = path.join(orkas.workspaceRoot, 'account-e2e/local/web-assist/profile/Cache/Cache_Data');
      const old = new Date(Date.now() - 8 * 86_400_000);
      const ageFiles = (names: string[]) => {
        for (const name of names) utimesSync(path.join(data, name), new Date(), old);
      };
      const readStores = `(async () => {
        const db = await new Promise((resolve, reject) => { const q = indexedDB.open('retained', 1); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        const indexed = await new Promise((resolve, reject) => { const q = db.transaction('values').objectStore('values').get('key'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); db.close();
        return { local: localStorage.getItem('key'), cookie: document.cookie, indexed, cache: await (await caches.match('/saved')).text() };
      })()`;
      await open();
      await fetchBoth(); await fetchBoth();
      expect(hits).toEqual({ old: 1, recent: 1 });
      await run(`(async () => {
        localStorage.setItem('key', 'local'); document.cookie = 'retained=cookie; Max-Age=3600; Path=/';
        const db = await new Promise((resolve, reject) => { const q = indexedDB.open('retained', 1); q.onupgradeneeded = () => q.result.createObjectStore('values'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        await new Promise((resolve, reject) => { const t = db.transaction('values', 'readwrite'); t.objectStore('values').put('indexed', 'key'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); db.close();
        await (await caches.open('retained')).put('/saved', new Response('website-cache'));
      })()`);
      const stores = { local: 'local', cookie: 'retained=cookie', indexed: 'indexed', cache: 'website-cache' };
      expect(await run(readStores)).toEqual(stores);
      // Relaunch closes all previous native handles. The new process has not
      // created the browser Session; only now adjust isolated fixture mtimes.
      await orkas.relaunch();
      const previous = sweepCount();
      const header = readFileSync(path.join(data, 'index'));
      if (backend === 'simple') {
        expect(header.readBigUInt64LE(0)).toBe(0xfcfb6d1ba7725c30n);
        const names = readdirSync(data);
        const entry = names.find(name => /^[0-9a-f]{16}_0$/.test(name) && readFileSync(path.join(data, name)).includes(Buffer.from(origin + '/old')));
        expect(entry).toBeTruthy();
        ageFiles(names.filter(name => name.startsWith(entry!.slice(0, 17))));
        expect(await waitForBootSweep(previous)).toMatchObject({ status: 'complete' });
        expect(existsSync(path.join(data, entry!))).toBe(false);
      } else {
        expect(header.readUInt32LE(0)).toBe(0xc103cac3);
        ageFiles(readdirSync(data));
        utimesSync(path.join(data, 'data_0'), new Date(), new Date());
        expect(await waitForBootSweep(previous)).toMatchObject({ status: 'complete', removedFiles: 0 });
      }
      await open();
      expect(await run(readStores)).toEqual(stores);
      await fetchBoth();
      expect(hits).toEqual({ old: backend === 'simple' ? 2 : 1, recent: 1 });
      await orkas.invoke('webAssist.close');
      expect(await sweep()).toMatchObject({ status: 'in-use', removedFiles: 0 });
      if (backend === 'blockfile') {
        await orkas.relaunch();
        const previous = sweepCount();
        ageFiles(readdirSync(data));
        const result = await waitForBootSweep(previous);
        expect(result.status).toBe('complete');
        expect(result.removedFiles).toBeGreaterThan(0);
        expect(existsSync(data)).toBe(false);
        await open();
        expect(await run(readStores)).toEqual(stores);
        await fetchBoth();
        expect(hits).toEqual({ old: 2, recent: 2 });
      }
    } finally {
      await orkas.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
