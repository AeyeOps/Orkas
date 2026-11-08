import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInBundledNode } from '../../helpers/bundled-node';
import sharp from '../../helpers/bundled-node-sharp';

const driverPath = path.resolve(__dirname, '../../fixtures/image-asset-with-faults.cjs');
const operations = ['process', 'remove_background', 'upscale'] as const;
type Operation = typeof operations[number];
let root = '';
let original: Buffer;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-replacement-')));
  original = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#cc2244' } }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'output.png'), original);
  fs.writeFileSync(path.join(root, 'source.png'), await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#22cc44' },
  }).png().toBuffer());
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runner(op: Operation, invalidPreparedImage = false, renameFault?: string) {
  return (overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({
      op, input_path: 'source.png', output_path: 'output.png', overwrite: true, ...overrides,
    }));
    return runInBundledNode(driverPath, { op, invalidPreparedImage, renameFault, args: ['--project', root, '--request', 'request.json'] });
  };
}

function expectOriginalPreserved() {
  expect(fs.readFileSync(path.join(root, 'output.png'))).toEqual(original);
  expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
}

async function expectReplacement() {
  const decoded = await sharp(path.join(root, 'output.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: 8, height: 8, channels: 4 });
  expect([...decoded.data.subarray(0, 4)]).toEqual([34, 204, 68, 255]);
  expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
}

describe.each(operations)('ImageStudio %s file replacement', (op) => {
  it('replaces the requested file with a readable new image', async () => {
    const source = fs.readFileSync(path.join(root, 'source.png'));
    expect(await runner(op)()).toMatchObject({ ok: true, output_path: path.join(root, 'output.png') });
    await expectReplacement();
    expect(fs.readFileSync(path.join(root, 'source.png'))).toEqual(source);
  });

  it('supports using the original path as both input and output', async () => {
    const run = runner(op);
    const result = await run({ input_path: 'output.png', operations: [{ type: 'resize', width: 4, height: 4 }] });
    expect(result.ok).toBe(true);
    expect((await sharp(path.join(root, 'output.png')).metadata()).width).toBe(op === 'process' ? 4 : 8);
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it.each(['EPERM', 'EACCES'])('preserves the original on %s and can retry after the obstruction is removed', async (code) => {
    await expect(runner(op, false, code)()).rejects.toMatchObject({ code });
    expectOriginalPreserved();
    expect((await runner(op)()).ok).toBe(true);
    await expectReplacement();
  });

  it('preserves the original when preparing or validating the replacement fails', async () => {
    const run = runner(op, true);
    if (op === 'process') fs.writeFileSync(path.join(root, 'source.png'), 'invalid image');
    await expect(run()).rejects.toThrow(op === 'process' ? /unsupported image format/i : /E_IMAGE_ASSET_INVALID/);
    expectOriginalPreserved();
  });

  it('requires explicit overwrite for an existing output', async () => {
    await expect(runner(op)({ overwrite: false })).rejects.toMatchObject({ code: 'E_IMAGE_ASSET_EXISTS' });
    expectOriginalPreserved();
  });
});
