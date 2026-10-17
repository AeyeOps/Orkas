import { createServer } from 'node:http';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';

test('visual browser input reaches off-center canvas targets and masked HD crops', async ({ modelOrkas: orkas }) => {
  const hits: Array<{ x: number; y: number; trusted: boolean }> = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/hit?')) {
      const query = new URL(request.url, 'http://localhost').searchParams;
      hits.push({ x: Number(query.get('x')), y: Number(query.get('y')), trusted: query.get('trusted') === 'true' });
      response.end('received'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>body{margin:0;height:4000px}canvas{position:absolute;left:80px;top:70px}input{position:absolute;left:100px;top:280px;width:150px;height:30px}a{position:absolute;top:350px}</style>
      <canvas width="600" height="180"></canvas><div id="custom" style="position:absolute;left:700px;top:70px;width:100px;height:100px;background:purple">Listener only</div><input autocomplete="one-time-code" value="987654">
      <a href="/business?code=product&key=record#/board?tab=1&key=k">Business link</a>
      <script>const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='rgb(13,177,89)';ctx.fillRect(0,0,600,180);
      for(const target of [canvas,document.getElementById('custom')]) target.addEventListener('click',e=>fetch('/hit?x='+e.offsetX+'&y='+e.offsetY+'&trusted='+e.isTrusted));</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = path.resolve(__dirname, '../..');
  try {
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Browser visual controls' })).conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations(); (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      await new Promise<void>(resolve => setImmediate(resolve)); const req = (process as any).mainModule.require;
      req(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      req(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'visual-run');
      (globalThis as any).__visualTool = req(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
    }, { root, cid });
    const call = async (input: Record<string, unknown>) => {
      const result = await orkas.electronApp!.evaluate(async (_e, args) => {
        await new Promise<void>(resolve => setImmediate(resolve)); return (globalThis as any).__visualTool.execute(args, {});
      }, input);
      return { ...JSON.parse(result.content), images: result.images };
    };
    const tabId = (await call({ operation: 'open', url: origin })).active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    const observation = await call({ operation: 'observe', tab_id: tabId });
    expect(observation.elements.some((e: any) => e.label === 'Listener only')).toBe(false);
    expect(observation.elements.find((e: any) => e.label === 'Business link').href).toBe(origin + '/business?code=product&key=record#/board?tab=1&key=k');
    const shot = () => call({ operation: 'screenshot', tab_id: tabId });
    const point = (page: any, extras = {}) => call({ operation: 'act', tab_id: tabId, page_id: page.page_id, page_action: 'click', point: [110, 100], ...extras });
    expect(await point(observation)).toMatchObject({ ok: false, code: 'screenshot_required' });
    const captured = await shot(); expect(captured.ok, JSON.stringify({ ok: captured.ok, code: captured.code })).toBe(true);
    expect(await point(captured, { point: [captured.viewport.width, 100] })).toMatchObject({ ok: false, code: 'invalid_point' });
    expect(hits).toHaveLength(0);
    expect(await point(captured)).toMatchObject({ ok: true });
    await expect.poll(() => hits).toEqual([{ x: 30, y: 30, trusted: true }]);
    expect(await point(captured)).toMatchObject({ ok: false, code: 'stale_page' }); expect(hits).toHaveLength(1);
    // A large native viewport independently exercises whole-image downsampling.
    // Crop detail must survive without changing page layout during capture.
    await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1900, 1100));
    await orkas.invoke('webAssist.layout', { x: 0, y: 0, width: 1800, height: 1000 });
    const full = await shot();
    const scale = await orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === args.origin + '/')!;
      const viewport = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight })');
      const sharp = (process as any).mainModule.require(args.root + '/node_modules/sharp');
      const bitmap = await sharp((await wc.capturePage(undefined, { stayHidden: true })).toPNG()).metadata();
      return { x: bitmap.width / viewport.width, y: bitmap.height / viewport.height };
    }, { root, origin });
    const crop = await call({ operation: 'screenshot', tab_id: tabId, clip: [90, 80, 180, 240] });
    expect(crop.ok, JSON.stringify({ ok: crop.ok, code: crop.code })).toBe(true);
    expect(crop).toMatchObject({ ok: true, viewport: full.viewport });
    // Native pixel edges enclose the CSS request on fractional-DPI displays.
    const left = Math.floor(90 * scale.x), pixelTop = Math.floor(80 * scale.y);
    const right = Math.ceil(270 * scale.x), bottom = Math.ceil(320 * scale.y);
    expect(crop.clip).toEqual([left / scale.x, pixelTop / scale.y, (right - left) / scale.x, (bottom - pixelTop) / scale.y]);
    expect(Math.max(crop.width, crop.height)).toBeLessThanOrEqual(1600);
    const pixel = await orkas.electronApp!.evaluate(async (_e, args) => {
      const sharp = (process as any).mainModule.require(args.root + '/node_modules/sharp');
      const { data, info } = await sharp(Buffer.from(args.image, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => { const i = (Math.floor(y * info.height / 240) * info.width + Math.floor(x * info.width / 180)) * info.channels; return Array.from(data.subarray(i, i + 3)); };
      return { width: info.width, height: info.height, green: at(20, 20), secret: at(80, 220) };
    }, { root, image: crop.images[0].data });
    // Native display color conversion can quantize canvas channels by one level.
    expect(pixel.secret).toEqual([0, 0, 0]);
    for (const [index, expected] of [13, 177, 89].entries()) expect(Math.abs(Number(pixel.green[index]) - expected)).toBeLessThanOrEqual(2);
    // A crop retains more source detail than the bounded whole-image output.
    expect(pixel.width / 180).toBeGreaterThan(full.width / full.viewport.width);
    expect(pixel.height / pixel.width).toBeCloseTo(240 / 180, 1);
    expect(await call({ operation: 'screenshot', tab_id: tabId, clip: [0, 0, 0, 10] })).toMatchObject({ ok: false, code: 'invalid_clip' });
    const outside = await call({ operation: 'screenshot', tab_id: tabId, clip: [full.viewport.width - 5, 0, 10, 10] });
    expect(outside).toMatchObject({ ok: false, code: 'invalid_clip' }); expect(outside.images).toBeUndefined();
    expect(outside.error).toContain(String(full.viewport.width));
    expect(await point(full)).toMatchObject({ ok: false, code: 'stale_page' });
    const stale = await shot();
    await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url + '/')!;
      await wc.executeJavaScript('scrollTo(0,100)');
    }, origin);
    expect(await point(stale)).toMatchObject({ ok: false, code: 'stale_page' }); expect(hits).toHaveLength(1);
    const afterScroll = await call({ operation: 'screenshot', tab_id: tabId, clip: [90, 0, 180, 240] });
    expect(afterScroll.ok).toBe(true);
    const secretAfterScroll = await orkas.electronApp!.evaluate(async (_e, args) => {
      const sharp = (process as any).mainModule.require(args.root + '/node_modules/sharp');
      const { data, info } = await sharp(Buffer.from(args.image, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const index = (Math.floor(195 * info.height / 240) * info.width + Math.floor(80 * info.width / 180)) * info.channels;
      return Array.from(data.subarray(index, index + 3));
    }, { root, image: afterScroll.images[0].data });
    expect(secretAfterScroll).toEqual([0, 0, 0]);
    const refreshed = await shot();
    expect(refreshed.page_id).not.toBe(stale.page_id);
    expect(await point(stale)).toMatchObject({ ok: false, code: 'stale_page' });
    const reloaded = await shot();
    expect(await call({ operation: 'navigate', tab_id: tabId, navigation: 'reload' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    expect(await point(reloaded)).toMatchObject({ ok: false, code: 'stale_page' }); expect(hits).toHaveLength(1);
    // Chromium reload can preserve scroll; explicitly return the target to view.
    const top = await call({ operation: 'observe', tab_id: tabId });
    expect(await call({ operation: 'act', tab_id: tabId, page_id: top.page_id, page_action: 'scroll', direction: 'top' })).toMatchObject({ ok: true });
    const listenerShot = await shot();
    expect(await point(listenerShot, { point: [760, 100] })).toMatchObject({ ok: true });
    await expect.poll(() => hits).toEqual([{ x: 30, y: 30, trusted: true }, { x: 60, y: 30, trusted: true }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
