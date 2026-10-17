import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  download,
  ensureEmbeddingModel,
  installVerifiedModel,
} from '../../../scripts/fetch-embedding-model.mjs';

const require = createRequire(import.meta.url);
const { EMBEDDING_MODEL_CONTRACT, verifyEmbeddingModelRoot } = require('../../../bin/packaged-resource-gate.cjs');

let root = '';
const servers: http.Server[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-embedding-fetch-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
  fs.rmSync(root, { recursive: true, force: true });
});

async function serve(
  handler: http.RequestListener,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function strictVerifier(model = 'model') {
  return (resourceRoot: string): string => {
    expect(fs.readdirSync(resourceRoot).sort()).toEqual([model]);
    const marker = path.join(resourceRoot, model, 'valid');
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'good') {
      throw new Error(`invalid model root: ${resourceRoot}`);
    }
    return `resource:embedding-model:${model}`;
  };
}

describe('embedding model archive download', () => {
  it('follows a bounded relative redirect and writes the exact expected payload', async () => {
    const payload = Buffer.from('model');
    const base = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/archive' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    const output = path.join(root, 'model.tar.gz');

    await download(`${base}/start`, output, {
      expectedBytes: payload.length,
      get: http.get,
      maxRedirects: 2,
      writeProgress: vi.fn(),
    });

    expect(fs.readFileSync(output)).toEqual(payload);
  });

  it('rejects a redirect loop and leaves no partial archive', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    const output = path.join(root, 'model.tar.gz');

    await expect(download(`${base}/loop`, output, {
      expectedBytes: 5,
      get: http.get,
      maxRedirects: 1,
      writeProgress: vi.fn(),
    })).rejects.toThrow('too many redirects');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('rejects an interrupted or short response and removes its partial archive', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': 10 });
      res.write('part');
      res.destroy();
    });
    const output = path.join(root, 'model.tar.gz');

    await expect(download(`${base}/archive`, output, {
      expectedBytes: 10,
      get: http.get,
      writeProgress: vi.fn(),
    })).rejects.toThrow(/aborted|socket hang up/i);
    expect(fs.existsSync(output)).toBe(false);
  });
});

describe('embedding model staged installation', () => {
  it('installs the exact existing model from pinned public files without the retired archive service', async () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const source = path.join(process.cwd(), 'resources', 'embedding-model', EMBEDDING_MODEL_CONTRACT.id);
    const downloadArchive = vi.fn(async () => { throw new Error('HTTP 403 from retired archive service'); });
    const downloadFile = vi.fn(async (_url: string, output: string) => {
      fs.copyFileSync(path.join(source, path.basename(output)), output);
    });

    await ensureEmbeddingModel({ destination, downloadArchive, downloadFile, log: vi.fn(), warn: vi.fn() });

    expect(verifyEmbeddingModelRoot(destination)).toBe('resource:embedding-model:fast-bge-small-zh-v1.5');
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(downloadFile.mock.calls.map(([url]) => url)).toEqual(
      ['config.json', 'model_optimized.onnx', 'ort_config.json', 'special_tokens_map.json',
        'tokenizer.json', 'tokenizer_config.json', 'vocab.txt'].map(name =>
        `https://huggingface.co/Qdrant/bge-small-zh-v1.5/resolve/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/${name}`),
    );
    for (const call of downloadFile.mock.calls as unknown as Array<[string, string, { expectedBytes: number; totalTimeoutMs: number }]>) {
      expect(call[2].expectedBytes).toBeGreaterThan(0);
      expect(call[2].totalTimeoutMs).toBeGreaterThan(0);
      expect(call[2].totalTimeoutMs).toBeLessThanOrEqual(600_000);
    }
  });

  it('rejects a same-size changed public file before replacing the old payload or downloading later files', async () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const old = path.join(destination, EMBEDDING_MODEL_CONTRACT.id, 'old');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'preserve');
    const downloadFile = vi.fn(async (_url: string, output: string) => {
      fs.writeFileSync(output, Buffer.alloc(739, 0));
    });

    await expect(ensureEmbeddingModel({
      destination, downloadFile, downloadArchive: async () => { throw new Error('retired archive'); },
      log: vi.fn(), warn: vi.fn(),
    })).rejects.toThrow(/sha256 mismatch/);

    expect(downloadFile).toHaveBeenCalledOnce();
    expect(fs.readFileSync(old, 'utf8')).toBe('preserve');
    expect(fs.readdirSync(path.dirname(destination)).filter(name => name.startsWith('.embedding-model-fetch-'))).toEqual([]);
  });

  it('uses a verified installed model without downloading and cleans a legacy partial archive', async () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const modelDir = path.join(destination, 'model');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'valid'), 'good');
    fs.writeFileSync(path.join(destination, 'model.tar.gz'), 'partial');
    const downloadArchive = vi.fn();

    await ensureEmbeddingModel({
      destination,
      downloadArchive,
      log: vi.fn(),
      model: 'model',
      sourceUrl: 'https://example.invalid/model.tar.gz',
      verifyArchive: vi.fn(),
      verifyRoot: strictVerifier(),
      warn: vi.fn(),
    });

    expect(downloadArchive).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(destination, 'model.tar.gz'))).toBe(false);
  });

  it('keeps the previous payload when download, extraction, or staged verification fails', async () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const oldFile = path.join(destination, 'model', 'old');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, 'preserve');

    await expect(ensureEmbeddingModel({
      destination,
      downloadArchive: async (_url: string, archive: string) => {
        fs.writeFileSync(archive, 'archive');
      },
      extractArchive: async (_archive: string, extractionRoot: string) => {
        const modelDir = path.join(extractionRoot, 'model');
        fs.mkdirSync(modelDir);
        fs.writeFileSync(path.join(modelDir, 'valid'), 'bad');
      },
      log: vi.fn(),
      model: 'model',
      sourceUrl: 'https://example.invalid/model.tar.gz',
      verifyArchive: vi.fn(),
      verifyRoot: strictVerifier(),
      warn: vi.fn(),
    })).rejects.toThrow('invalid model root');

    expect(fs.readFileSync(oldFile, 'utf8')).toBe('preserve');
    expect(
      fs.readdirSync(path.dirname(destination))
        .filter((entry) => entry.startsWith('.embedding-model-fetch-')),
    ).toEqual([]);
  });

  it('installs a fully verified staged model and removes the previous invalid payload', async () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const oldFile = path.join(destination, 'model', 'old');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, 'replace');

    await ensureEmbeddingModel({
      destination,
      downloadArchive: async (_url: string, archive: string) => {
        fs.writeFileSync(archive, 'archive');
      },
      extractArchive: async (_archive: string, extractionRoot: string) => {
        const modelDir = path.join(extractionRoot, 'model');
        fs.mkdirSync(modelDir);
        fs.writeFileSync(path.join(modelDir, 'valid'), 'good');
      },
      log: vi.fn(),
      model: 'model',
      sourceUrl: 'https://example.invalid/model.tar.gz',
      verifyArchive: vi.fn(),
      verifyRoot: strictVerifier(),
      warn: vi.fn(),
    });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'model', 'valid'), 'utf8')).toBe('good');
  });

  it('restores the previous payload if final destination verification fails', () => {
    const destination = path.join(root, 'resources', 'embedding-model');
    const extractionRoot = path.join(root, 'extract');
    const oldFile = path.join(destination, 'model', 'old');
    const stagedFile = path.join(extractionRoot, 'model', 'valid');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
    fs.writeFileSync(oldFile, 'preserve');
    fs.writeFileSync(stagedFile, 'good');

    expect(() => installVerifiedModel({
      destination,
      extractionRoot,
      model: 'model',
      verifyRoot: () => {
        throw new Error('final verification failed');
      },
    })).toThrow('final verification failed');

    expect(fs.readFileSync(oldFile, 'utf8')).toBe('preserve');
    expect(fs.existsSync(stagedFile)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(destination))
        .filter((entry) => entry.startsWith('.embedding-model-backup-')),
    ).toEqual([]);
  });
});
