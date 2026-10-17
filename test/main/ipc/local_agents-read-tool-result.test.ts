/**
 * Tests for the `localAgents.readToolResult` IPC handler.
 *
 * Security invariants the handler MUST hold (CLAUDE.md §5 boundary):
 *   - active uid only, opaque refs resolve under <uid>/local/tool-results/
 *   - projected-history paths resolve only under cache entries' tool-results/
 *   - reject ENOENT, symlink-escape, traversal (`../`), non-file targets
 *   - byte-cap reads at 256 KB; signal truncation via `{truncated:true}`
 *
 * Never throws across the IPC boundary — all failure modes return
 * `{ok:false, error}` so a UI bug can't crash the renderer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readtoolresult-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Each test gets a fresh module graph so users.activateUser doesn't
  // bleed across.
  const { vi } = await import('vitest');
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callHandler(input: unknown): Promise<any> {
  const mod = await import('../../../src/main/ipc/local_agents');
  return (mod.invokeHandlers as any)['localAgents.readToolResult'](input as any);
}

function sessionDir(): string {
  // Mirror sessionToolResultsDir(uid, '<uid>-cli-claude-runX') so we
  // can drop fixtures into the same shape the runner spills into.
  const dir = path.join(
    tmpDir, TEST_UID, 'local', 'tool-results', `${TEST_UID}-cli-claude-runtest`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ipc/local_agents.readToolResult', () => {
  it('rejects when neither an opaque ref nor a legacy path is valid', async () => {
    expect(await callHandler({})).toMatchObject({ ok: false });
    expect(await callHandler({ path: 42 })).toMatchObject({ ok: false });
    expect(await callHandler({ path: '' })).toMatchObject({ ok: false });
  });

  it('resolves an opaque content ref without receiving a machine path', async () => {
    const dir = sessionDir();
    const ref = 'bash.0123456789abcdef';
    fs.writeFileSync(path.join(dir, `${ref}.txt`), 'opaque ref content');

    const r = await callHandler({ ref });

    expect(r).toMatchObject({ ok: true, content: 'opaque ref content', truncated: false });
  });

  it('rejects malformed opaque refs before searching the local result store', async () => {
    sessionDir();
    expect(await callHandler({ ref: '../private/result' })).toMatchObject({
      ok: false,
      error: 'invalid result ref',
    });
  });

  it('reads a small spill file when path is inside tool-results/', async () => {
    const dir = sessionDir();
    const filePath = path.join(dir, 'bash.abc.txt');
    fs.writeFileSync(filePath, 'hello world');
    const r = await callHandler({ path: filePath });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hello world');
    expect(r.truncated).toBe(false);
  });

  it('reads a lazy history-cache result while keeping other cache buckets out of scope', async () => {
    const historyResultDir = path.join(
      tmpDir, TEST_UID, 'local', 'cache', 'conversation-history', 'entry', 'tool-results',
    );
    fs.mkdirSync(historyResultDir, { recursive: true });
    const filePath = path.join(historyResultDir, 'bash.history.txt');
    fs.writeFileSync(filePath, 'cached history result');

    expect(await callHandler({ path: filePath })).toMatchObject({
      ok: true,
      content: 'cached history result',
      truncated: false,
    });

    const unrelatedCache = path.join(tmpDir, TEST_UID, 'local', 'cache', 'catalogs', 'private.txt');
    fs.mkdirSync(path.dirname(unrelatedCache), { recursive: true });
    fs.writeFileSync(unrelatedCache, 'not a tool result');
    expect(await callHandler({ path: unrelatedCache })).toMatchObject({ ok: false });
  });

  it('rejects an absolute path outside the active uid tool-results dir', async () => {
    const outside = path.join(tmpDir, 'evil.txt');
    fs.writeFileSync(outside, 'leaked');
    const r = await callHandler({ path: outside });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('rejects a `..` traversal that escapes via path concat', async () => {
    const dir = sessionDir();
    // Construct a path that, before realpath, includes `..` segments
    // pointing OUT of tool-results/. realpath collapses them; the
    // handler then sees the canonical out-of-scope path and rejects.
    // tmpDir on macOS may itself be a symlink (/var → /private/var),
    // so we put the file at a known sibling-of-sessionDir absolute
    // location and reach it through `..` from sessionDir.
    const outsideDir = path.join(tmpDir, 'evil-sibling');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'evil.txt');
    fs.writeFileSync(outsideFile, 'leaked');
    // sessionDir is <tmpDir>/u1/local/tool-results/<session>;
    // 4 `..` go back to tmpDir, then into the sibling.
    const escapingPath = path.join(dir, '..', '..', '..', '..', 'evil-sibling', 'evil.txt');
    const r = await callHandler({ path: escapingPath });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('rejects ENOENT cleanly without throwing', async () => {
    const dir = sessionDir();
    const r = await callHandler({ path: path.join(dir, 'never-existed.txt') });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no longer exists/);
  });

  it('rejects when the resolved target is a directory, not a file', async () => {
    const dir = sessionDir();
    const r = await callHandler({ path: dir });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not a regular file/);
  });

  it('truncates files larger than the 256 KB cap and reports truncated:true', async () => {
    const dir = sessionDir();
    const filePath = path.join(dir, 'huge.txt');
    // Write 300 KB of A's.
    const huge = 'A'.repeat(300 * 1024);
    fs.writeFileSync(filePath, huge);
    const r = await callHandler({ path: filePath });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(256 * 1024);
    expect(r.content.startsWith('A')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer on the main-process read path', () => {
    const file = path.join(sessionDir(), 'not-a-file.txt');
    const fifo = spawnSync('mkfifo', [file], { encoding: 'utf8' });
    expect(fifo.status).toBe(0);
    const root = path.resolve(__dirname, '../../..');
    const script = `
      require(${JSON.stringify(path.join(root, 'src/main/features/users.ts'))}).activateUser('u1');
      const {invokeHandlers} = require(${JSON.stringify(path.join(root, 'src/main/ipc/local_agents.ts'))});
      process.stdout.write('FIFO_OPEN_READY\\n');
      invokeHandlers['localAgents.readToolResult']({path:${JSON.stringify(file)}})
        .then(value => { process.stdout.write('\\nFIFO_RESULT:' + JSON.stringify(value)); process.exit(0); })
        .catch(error => { console.error(error); process.exit(1); });`;
    // Native Electron ABI, real IPC handler, bounded child: a blocking FIFO
    // cannot hang the test runner or be mistaken for a successful rejection.
    const run = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), '-e', script], {
      cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      timeout: 6000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    expect(run.stdout, run.stderr).toContain('FIFO_OPEN_READY');
    expect((run.error as NodeJS.ErrnoException | undefined)?.code ?? null, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.split('FIFO_RESULT:').at(-1)!)).toMatchObject({ ok: false, error: 'not a regular file' });
  });

  it('continues at UTF-8 byte boundaries without losing Unicode, escaping text or rereading previous output', async () => {
    const filePath = path.join(sessionDir(), 'unicode.txt');
    const original = 'a'.repeat(256 * 1024 - 1) + '🌟界\n<script>private fixture</script>' + '🌟'.repeat(90_000) + '\nEOF';
    fs.writeFileSync(filePath, original);
    let cursor: number | null = 0;
    const pieces: string[] = [];
    for (let n = 0; cursor !== null && n < 8; n++) {
      const r = await callHandler({ path: filePath, cursor });
      expect(r.ok).toBe(true);
      expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(256 * 1024);
      expect(r.content).not.toContain('\uFFFD');
      expect(r.next_cursor === null || Number.isSafeInteger(r.next_cursor) && r.next_cursor > cursor!).toBe(true);
      pieces.push(r.content); cursor = r.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(pieces.join('')).toBe(original);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER, '0']) {
      expect(await callHandler({ path: filePath, cursor: invalid })).toMatchObject({ ok: false });
    }
  });

  it('rejects when a symlink points OUT of tool-results/', async () => {
    const dir = sessionDir();
    const outside = path.join(tmpDir, 'evil-target.txt');
    fs.writeFileSync(outside, 'should not leak');
    const linkPath = path.join(dir, 'innocent-looking.txt');
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      // Some sandboxed CI envs forbid symlinks; skip this case
      // rather than fail the test on platform constraints.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const r = await callHandler({ path: linkPath });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('allows a symlink that resolves WITHIN tool-results/', async () => {
    const dir = sessionDir();
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'inside content');
    const linkPath = path.join(dir, 'alias.txt');
    try {
      fs.symlinkSync(real, linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const r = await callHandler({ path: linkPath });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('inside content');
  });
});
