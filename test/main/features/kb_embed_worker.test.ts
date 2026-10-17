import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createPackageFromStreams } from '@electron/asar';

const workerSourceFile = path.resolve(__dirname, '../../../bin/kb-embed-worker.cjs');
const requestFixture = path.resolve(__dirname, '../../fixtures/kb/embed-worker-request.cjs');
const { requestWorker } = createRequire(import.meta.url)(requestFixture);
const disk = createRequire(import.meta.url)('original-fs') as typeof fs;
let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-embed-worker-')); });
afterEach(async () => {
  // Remove physical archive bytes, rather than traversing Electron's ASAR view.
  await disk.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function write(relative: string, body: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const embedPackage = `
const marker = require('@fixture/tokenizer');
exports.EmbeddingModel = { BGESmallZH: 'fixture-model' };
exports.FlagEmbedding = { init: async () => ({
  async *embed(texts) { yield texts.map(() => new Float32Array(marker)); }
}) };
`;

async function request(workerDir: string, isolatedArchive = false): Promise<Record<string, any>> {
  if (!isolatedArchive) return requestWorker(workerSourceFile, workerDir, path.join(root, 'model'));
  const child = spawnSync(process.execPath, [requestFixture, workerSourceFile, workerDir, path.join(root, 'model')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 5000,
  });
  // Preserve native diagnostics for the owning test log policy.
  if (child.stderr) process.stderr.write(child.stderr);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

describe('Library embedding worker dependency loading', () => {
  it.each(['development', 'packaged'] as const)(
    'loads the full dependency graph from the %s application root', async layout => {
      const appRoot = layout === 'packaged' ? 'stage' : 'source';
      const workerRoot = layout === 'packaged' ? 'app.asar.unpacked' : 'source';
      write(`${appRoot}/package.json`, '{}');
      write(`${appRoot}/node_modules/fastembed/index.js`, embedPackage);
      write(`${appRoot}/node_modules/@fixture/tokenizer/index.js`, 'module.exports = [7, 11];');
      if (layout === 'packaged') {
        // electron-builder unpacks FastEmbed, while a JS-only transitive
        // dependency remains exclusively in the archive. A source-only test
        // cannot catch a worker resolving from the physical unpacked tree.
        const stage = path.join(root, appRoot);
        const entries: Parameters<typeof createPackageFromStreams>[1] = [
          'node_modules', 'node_modules/fastembed', 'node_modules/@fixture', 'node_modules/@fixture/tokenizer',
        ].map(relative => ({ type: 'directory', path: relative, unpacked: false }));
        for (const relative of ['package.json', 'node_modules/fastembed/index.js', 'node_modules/@fixture/tokenizer/index.js']) {
          const file = path.join(stage, relative);
          entries.push({ type: 'file', path: relative, unpacked: relative === 'node_modules/fastembed/index.js',
            stat: disk.statSync(file), streamGenerator: () => disk.createReadStream(file) });
        }
        await finished(await createPackageFromStreams(path.join(root, 'app.asar'), entries));
        expect(fs.existsSync(path.join(root, workerRoot, 'node_modules/fastembed/index.js'))).toBe(true);
        expect(fs.existsSync(path.join(root, workerRoot, 'node_modules/@fixture/tokenizer/index.js'))).toBe(false);
      }
      const result = await request(path.join(root, workerRoot, 'bin'), layout === 'packaged');
      expect(result).toEqual({ id: 17, ok: true, vectors: [[7, 11], [7, 11]] });
    },
  );

  it('reports a genuinely missing dependency as failure rather than empty embeddings', async () => {
    write('source/node_modules/fastembed/index.js', embedPackage);
    const result = await request(path.join(root, 'source/bin'));
    expect(result).toMatchObject({ id: 17, ok: false });
    expect(result.error).toContain("Cannot find module '@fixture/tokenizer'");
    expect(result).not.toHaveProperty('vectors');
  });

  it('preserves the existing private native-load diagnostic through the worker protocol', async () => {
    write('source/node_modules/fastembed/index.js', `
      throw Object.assign(new Error('onnxruntime native fixture failed'), { code: 'ERR_DLOPEN_FAILED' });
    `);
    expect(await request(path.join(root, 'source/bin'))).toEqual({
      id: 17, ok: false,
      error: 'native embedding runtime failed to load',
      errorCode: 'E_LIBRARY_NATIVE_ONNX_LOAD',
    });
  });
});
