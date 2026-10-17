import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual lifecycle entries with controlled provisioning. Real
// binaries and target checks are verified separately; no network or toolchain
// installation is needed to prove readiness cannot bypass helper failure.
function lifecycle(name: string, helperFails = false, platform = 'darwin') {
  const entry = path.join(process.cwd(), 'scripts', name);
  const calls: string[][] = [];
  const messages: string[] = [];
  const verifyRuntimeRoot = vi.fn(() => []);
  const exit = vi.fn(() => { throw new Error('preparation-exit'); });
  const module = { exports: {} as any };
  const gate = new Proxy({ PACKAGED_RUNTIME_KINDS: [], runtimeKey: (p: string, a: string) => `${p}-${a}`, verifyRuntimeRoot }, {
    get: (target: any, key) => key in target ? target[key] : () => [],
  });
  const require = (key: string) => {
    if (key === 'node:path') return path;
    if (key === 'node:fs') return { existsSync: () => false,
      readFileSync: () => fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8') };
    if (key === 'node:child_process') return { spawnSync: (_command: string, args: string[]) => {
      calls.push([path.basename(args[0]), ...args.slice(1)]);
      return { status: helperFails && path.basename(args[0]) === 'build-phone-passkey.cjs' ? 1 : 0 };
    } };
    if (key.endsWith('slim-runtime.cjs')) return { slimRuntimeRoot: () => [] };
    return gate;
  };
  const execute = () => vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require, module, __dirname: path.dirname(entry),
    process: { execPath: process.execPath, env: {}, platform, arch: 'arm64', exit },
    console: { log: (value: string) => messages.push(value), error: (value: string) => messages.push(value) },
  });
  return { calls, messages, verifyRuntimeRoot, module, execute, exit };
}

describe('phone passkey development and release provisioning', () => {
  it('provisions both actual Mac architectures before verifying a universal release', async () => {
    const h = lifecycle('ensure-runtime-before-pack.cjs'); h.execute();
    await h.module.exports({ electronPlatformName: 'darwin', arch: 'universal' });
    expect(h.calls.filter(call => call[0] === 'build-phone-passkey.cjs')).toEqual([
      ['build-phone-passkey.cjs', '--platform', 'darwin', '--arch', 'x64'],
      ['build-phone-passkey.cjs', '--platform', 'darwin', '--arch', 'arm64'],
    ]);
    expect(h.verifyRuntimeRoot.mock.calls.map((call: any[]) => call.slice(1, 3))).toEqual([['darwin', 'x64'], ['darwin', 'arm64']]);
  });
  it('blocks packaging before runtime readiness when helper provisioning fails', async () => {
    const h = lifecycle('ensure-runtime-before-pack.cjs', true); h.execute();
    await expect(h.module.exports({ electronPlatformName: 'darwin', arch: 'arm64' })).rejects.toThrow('Phone passkey runtime provisioning failed');
    expect(h.verifyRuntimeRoot).not.toHaveBeenCalled();
    expect(h.calls.some(call => call[0] === 'ensure-runtime.cjs')).toBe(false);
    expect(h.messages.join('\n')).not.toContain('pre-pack verified');
  });
});
