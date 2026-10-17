import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planCliUpgrade, runUpgradeCommand, upgradeLocalCli } from '../../../../src/main/features/local_agents/upgrade';
import { invalidateCache } from '../../../../src/main/features/local_agents/registry';
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
let root = ''; let previous: string | undefined;
function executable(file: string, source: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${TEST_NODE}\n${source}\n`); fs.chmodSync(file, 0o755); return file;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-upgrade-')); previous = process.env.ORKAS_CODEX_PATH; invalidateCache(); });
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_CODEX_PATH; else process.env.ORKAS_CODEX_PATH = previous; invalidateCache(); fs.rmSync(root, { recursive: true, force: true }); });
describe('CLI installation ownership', () => {
  it('does not modify source or bundled application binaries', async () => {
    for (const file of ['source/codex', 'Codex.app/Contents/bin/codex']) {
      const bin = executable(path.join(root, file), `console.log('  update Upgrade Codex');`);
      expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'unavailable' });
    }
  });
  it.skipIf(process.platform === 'win32')('requires an advertised native updater', async () => {
    const bin = executable(path.join(root, '.codex/packages/standalone/current/bin/codex'), `console.log('Usage: codex');`);
    expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'unavailable' });
    executable(bin, `console.log('Commands:\\n  update  Upgrade Codex');`);
    expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'native', command: bin, args: ['update'] });
  });
  it.skipIf(process.platform === 'win32').each([
    ['update|upgrade', true], ['upgrade|update', true],
    ['update-all|upgrade', false], ['self-update|upgrade', false],
    ['doctor  Check update|upgrade availability', false], ['--update', false],
  ])('recognizes exact native Claude command aliases: %s', async (command, supported) => {
    const bin = executable(path.join(root, '.local/share/claude/versions/2.1.112'),
      `console.log(${JSON.stringify('Commands:\n  ' + command + '  Check for updates and install if available')});`);
    expect(await planCliUpgrade('claude', bin)).toEqual(supported
      ? { method: 'native', command: bin, args: ['update'] } : { method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32').each([
    ['Usage: claude update|upgrade [options]', 0, true],
    ['Usage: claude [options] [command] [prompt]', 0, false],
    ['Usage: claude update-all [options]', 0, false],
    ['Usage: claude update|upgrade [options]', 1, false],
  ])('uses exact short command help when root help is truncated: %s / %s', async (usage, code, supported) => {
    const bin = executable(path.join(root, '.local/share/claude/versions/2.1.112'), `
if (process.argv.slice(2).join(' ') === 'update --help') {
  console.log(${JSON.stringify(usage)}); process.exitCode = ${code};
} else if (process.argv.slice(2).join(' ') === '--help') console.log('Usage: claude [options] [command]');
else process.exit(9);`);
    expect(await planCliUpgrade('claude', bin)).toEqual(supported
      ? { method: 'native', command: bin, args: ['update'] } : { method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32')('targets the owning global npm prefix and exact known package', async () => {
    const packageRoot = path.join(root, 'lib/node_modules/@openai/codex');
    const entry = executable(path.join(packageRoot, 'bin/codex.js'), '');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    fs.mkdirSync(path.join(root, 'bin')); executable(path.join(root, 'bin/npm'), ''); const bin = path.join(root, 'bin/codex'); fs.symlinkSync(entry, bin);
    const plan = await planCliUpgrade('codex', bin);
    expect(plan.method).toBe('npm');
    expect(plan.args).toEqual(['install', '--global', '@openai/codex@latest', '--prefix', fs.realpathSync(root), '--no-audit', '--no-fund']);
    expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
    fs.mkdirSync(path.join(root, 'other')); const other = path.join(root, 'other/codex'); fs.symlinkSync(entry, other);
    expect(await planCliUpgrade('codex', other)).toEqual({ method: 'unavailable' });
  });
  it.skipIf(process.platform === 'win32')('uses only the owning Homebrew installation and registered formula or cask', async () => {
    const brew = executable(path.join(root, 'bin/brew'), '');
    for (const [store, args] of [['Cellar', ['upgrade', 'codex']], ['Caskroom', ['upgrade', '--cask', 'codex']]] as const) {
      const bin = executable(path.join(root, store, 'codex/0.156.1/bin/codex'), '');
      expect(await planCliUpgrade('codex', bin)).toEqual({ method: 'brew', command: fs.realpathSync(brew), args });
      expect(await planCliUpgrade('claude', bin)).toEqual({ method: 'unavailable' });
    }
    fs.unlinkSync(brew);
    expect(await planCliUpgrade('codex', path.join(root, 'Cellar/codex/0.156.1/bin/codex'))).toEqual({ method: 'unavailable' });
  });
});
describe.skipIf(process.platform === 'win32')('native CLI maintenance lifecycle', () => {
  function native(mode: string) {
    const state = path.join(root, 'version'); fs.writeFileSync(state, '0.144.0');
    const updates = path.join(root, 'updates');
    const bin = executable(path.join(root, '.codex/packages/standalone/current/bin/codex'), `
const fs = require('node:fs'); const state = ${JSON.stringify(state)};
if (process.argv.includes('--version')) console.log(fs.readFileSync(state, 'utf8'));
else if (process.argv.includes('--help')) console.log('Commands:\\n  update  Upgrade Codex');
else if (process.argv.includes('update')) {
  fs.appendFileSync(${JSON.stringify(updates)}, 'update\\n');
  setTimeout(() => { ${mode === 'failure' ? 'process.exit(7);' : `fs.writeFileSync(state, '${mode === 'unchanged' ? '0.144.0' : '0.159.3'}');`} }, 200);
} else process.exit(8);`);
    process.env.ORKAS_CODEX_PATH = bin; return { bin, updates };
  }
  it('coalesces surfaces and verifies the original executable after upgrade', async () => {
    const { bin, updates } = native('success');
    const one = upgradeLocalCli('codex'); const two = upgradeLocalCli('codex'); expect(two).toBe(one);
    const result = await one;
    expect(result).toMatchObject({ ok: true, method: 'native', version: '0.159.3', entry: { path: bin, available: true } });
    expect(fs.readFileSync(updates, 'utf8')).toBe('update\n');
  });
  it.each(['failure', 'unchanged'])('does not claim a successful upgrade for %s', async mode => {
    native(mode);
    expect(await upgradeLocalCli('codex')).toMatchObject({ ok: false, error_code: mode === 'failure' ? 'failed' : 'verification_failed' });
  });
  it('bounds subprocess deadlines and excessive output without exposing output', async () => {
    const hung = await runUpgradeCommand(TEST_NODE, ['-e', 'setInterval(()=>{},1000)'], 100);
    expect(hung).toMatchObject({ ok: false, error: 'timeout', text: '' });
    const large = await runUpgradeCommand(TEST_NODE, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));"], 3000);
    expect(large).toMatchObject({ ok: false, error: 'output_limit', text: '' });
  });
});
