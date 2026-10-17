import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

const modulePath = path.resolve(__dirname, '../../src/main/features/image_studio.ts');
const scores = { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 };

function createPoster(orkas: { createWorkspaceFile(name: string, content: string): string }, name: string, content: string, height = 1080) {
  const entry = orkas.createWorkspaceFile(`${name}/index.html`, `<!doctype html><html><head><style>
    html,body{margin:0}main{position:relative;width:1080px;height:${height}px;background:#f6efdc}
    p{margin:0}svg{position:absolute;right:0;bottom:0;width:40px;height:40px}
    </style></head><body><main><p>City Coffee Fest</p>${content}
    <svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="#2468ae"/></svg>
    <div style="position:absolute;left:0;bottom:0;width:40px;height:40px;background:#b82e37"></div>
    </main></body></html>`);
  orkas.createWorkspaceFile(`${name}/image-manifest.json`, JSON.stringify({
    schema_version: 1, route: 'compose', entry: 'index.html', canvas: { width: 1080, height },
    brief: { purpose: 'Event poster', audience: 'Coffee lovers', required_copy: ['City Coffee Fest'], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Coffee festival', one_job: 'Announce the event', visual_tradition: 'Editorial poster',
      composition: 'Title and illustration', signature_device: 'Coffee cup', typography: 'Sans serif', color_light_material: 'Cream paper' },
    generation_budget: { max_calls: 0 },
  }));
  return { projectDirAbs: path.dirname(entry), outputAbsPath: path.join(path.dirname(entry), 'evidence.png'),
    stateAbsPath: path.join(path.dirname(entry), 'state.json') };
}

test('exports all poster corners after the host initially constrains the capture window', async ({ sdkOrkas: orkas }) => {
  // Real Chromium pixels are the oracle. The event simulates work-area clamping
  // without supplying a mock screenshot or the expected rendered answer.
  // Native screenshots apply the display's color conversion before production.
  // Render an independent small reference rather than assume literal RGB bytes.
  const referencePng = await orkas.electronApp!.evaluate(async ({ BrowserWindow }) => {
    const win = new BrowserWindow({ width: 120, height: 60, useContentSize: true, show: false,
      backgroundColor: '#00000000', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    try {
      await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>
        html,body{margin:0}div{position:absolute;top:0;width:40px;height:40px}
        </style><div style="left:0;background:#b82e37"></div><div style="left:60px;background:#2468ae"></div>`));
      return (await win.webContents.capturePage()).toPNG().toString('base64');
    } finally { win.destroy(); }
  });
  const reference = await sharp(Buffer.from(referencePng, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const referencePixel = (x: number) => {
    const px = Math.floor(x * reference.info.width / 120), py = Math.floor(20 * reference.info.height / 60);
    return [...reference.data.subarray((py * reference.info.width + px) * 4, (py * reference.info.width + px) * 4 + 4)];
  };
  expect(referencePixel(20)[3]).toBe(255);
  expect(referencePixel(80)[3]).toBe(255);
  for (const height of [1080, 2160]) {
    const input = createPoster(orkas, `poster-${height}`, '', height);
    const output = path.join(input.projectDirAbs, 'delivery.png');
    const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const clamp = (_event: unknown, win: Electron.BrowserWindow) => win.setContentSize(640, 480);
      const before = BrowserWindow.getAllWindows().length;
      app.on('browser-window-created', clamp);
      try {
        const inspection = await studio.snapshotImageStudioProject(args.input);
        if (inspection.ok) {
          await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath,
            evidenceAbsPath: args.input.outputAbsPath, verdict: 'passed', scope: 'Complete poster', findings: [], qualityScores: args.scores });
          await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: 'png' });
        }
        return { ok: inspection.ok, blockers: inspection.blockers, remaining: BrowserWindow.getAllWindows().length - before };
      } finally { app.removeListener('browser-window-created', clamp); }
    }, { modulePath, input, output, scores });
    expect(result).toEqual({ ok: true, blockers: [], remaining: 0 });
    const decoded = await sharp(readFileSync(output)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 1080, height, channels: 4 });
    const pixel = (x: number, y: number) => [...decoded.data.subarray((y * 1080 + x) * 4, (y * 1080 + x) * 4 + 4)];
    expect(pixel(20, height - 20)).toEqual(referencePixel(20));
    expect(pixel(1060, height - 20)).toEqual(referencePixel(80));
  }
});

test('blocks page and nested scrolling before export and succeeds after the layout is repaired', async ({ sdkOrkas: orkas }) => {
  for (const [name, content] of [
    ['page', '<div style="position:absolute;top:1070px;width:1120px;height:100px">Event details</div>'],
    ['nested', '<section style="width:200px;height:100px;overflow:auto"><div style="width:300px;height:200px">Event details</div></section>'],
    ['forced', '<section style="width:200px;height:100px;overflow:scroll">Event details</section>'],
  ]) {
    const input = createPoster(orkas, `overflow-${name}`, content);
    const result = await orkas.electronApp!.evaluate(async (_, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const inspection = await studio.snapshotImageStudioProject(args.input);
      let reviewError = '';
      try {
        await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath,
          evidenceAbsPath: args.input.outputAbsPath, verdict: 'passed', scope: 'Complete poster', findings: [], qualityScores: args.scores });
      } catch (error) { reviewError = String(error); }
      return { ok: inspection.ok, blockers: inspection.blockers, reviewError };
    }, { modulePath, input, scores });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_IMAGE_LAYOUT_SCROLLING' })]));
    expect(result.reviewError).toContain('E_IMAGE_REVIEW_EVIDENCE_REQUIRED');
    expect(existsSync(input.outputAbsPath)).toBe(false);
    expect(existsSync(input.stateAbsPath)).toBe(false);
    // Intentional cropping of decorative bleed is valid; scrollable deliverables
    // are not. A repaired layout must be capturable without restarting the app.
    const repaired = createPoster(orkas, `overflow-${name}`, '<section style="width:200px;height:100px;overflow:hidden"><div style="width:300px;height:200px">Decoration</div></section>');
    const inspection = await orkas.electronApp!.evaluate(async (_, args) =>
      (process as any).mainModule.require(args.modulePath).snapshotImageStudioProject(args.input), { modulePath, input: repaired });
    expect(inspection.ok).toBe(true);
  }
});

test('rejects an unrecoverable viewport mismatch without replacing existing evidence', async ({ sdkOrkas: orkas }) => {
  const input = createPoster(orkas, 'unresizable', '');
  const good = await orkas.electronApp!.evaluate(async (_, args) =>
    (process as any).mainModule.require(args.modulePath).snapshotImageStudioProject(args.input), { modulePath, input });
  expect(good.ok).toBe(true);
  const imageBefore = readFileSync(input.outputAbsPath);
  const stateBefore = readFileSync(input.stateAbsPath);
  const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const constrain = (_event: unknown, win: Electron.BrowserWindow) => {
      win.setContentSize(640, 480);
      win.setContentSize = () => {};
    };
    const before = BrowserWindow.getAllWindows().length;
    app.on('browser-window-created', constrain);
    try {
      await studio.snapshotImageStudioProject(args.input);
      return { error: '', remaining: BrowserWindow.getAllWindows().length - before };
    } catch (error) {
      return { error: String(error), remaining: BrowserWindow.getAllWindows().length - before };
    } finally { app.removeListener('browser-window-created', constrain); }
  }, { modulePath, input });
  expect(result.error).toContain('E_IMAGE_STUDIO_VIEWPORT_MISMATCH');
  expect(result.remaining).toBe(0);
  expect(readFileSync(input.outputAbsPath)).toEqual(imageBefore);
  expect(readFileSync(input.stateAbsPath)).toEqual(stateBefore);
});
