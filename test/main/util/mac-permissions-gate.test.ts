import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const { verifyMacPermissions } = require('../../../product/signing/verify-mac-permissions.cjs');
const key = 'com.apple.security.device.audio-input';
let root: string;
let app: string;
let signatures: Map<string, Record<string, unknown>>;
let metadata: Record<string, unknown>;
let failure: string;

const helperNames = ['Orkas Helper', 'Orkas Helper (Renderer)', 'Orkas Helper (GPU)', 'Orkas Helper (Plugin)'];
const helper = (name: string) => path.join(app, 'Contents', 'Frameworks', `${name}.app`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mac-permissions-'));
  app = path.join(root, 'Orkas.app');
  signatures = new Map();
  metadata = { NSMicrophoneUsageDescription: 'Record voice input with your permission.' };
  failure = '';
  for (const bundle of [app, ...helperNames.map(helper)]) {
    fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'fixture');
    signatures.set(bundle, { [key]: true });
  }
  vi.spyOn(cp, 'spawnSync').mockImplementation((command: string, args: string[], options: any) => {
    if (command === 'codesign') {
      if (args.includes('--entitlements')) {
        if (failure === 'codesign') return { status: 1, stdout: '', stderr: 'probe failed' };
        if (failure === 'timeout') return { status: null, error: { code: 'ETIMEDOUT' }, stdout: '' };
        return { status: 0, stdout: JSON.stringify(signatures.get(args.at(-1)!)), stderr: 'Executable=fixture' };
      }
      return { status: 0, stdout: '', stderr: args.includes('--verify') ? '' : 'TeamIdentifier=TESTTEAM' };
    }
    if (command === 'plutil') {
      if (failure === 'plist') return { status: 1, stdout: '' };
      return { status: 0, stdout: options.input || JSON.stringify(metadata), stderr: '' };
    }
    throw new Error(`Unexpected tool: ${command}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mac app microphone permission gate', () => {
  it('accepts declared microphone access on the signed app and all helpers', () => {
    expect(verifyMacPermissions(app)).toBe(5);
  });

  it.each([undefined, false, 'true', 1])('rejects a valid signature with microphone entitlement %s', value => {
    signatures.set(app, value === undefined ? {} : { [key]: value });
    expect(() => verifyMacPermissions(app)).toThrow(/audio-input/);
  });

  it.each(helperNames)('rejects missing microphone access in %s even when the main app is correct', name => {
    signatures.set(helper(name), {});
    expect(() => verifyMacPermissions(app)).toThrow(/audio-input/);
  });

  it('discovers additional helper bundles instead of silently skipping them', () => {
    fs.mkdirSync(helper('Orkas Helper (Extra)'), { recursive: true });
    signatures.set(helper('Orkas Helper (Extra)'), {});
    expect(() => verifyMacPermissions(app)).toThrow(/audio-input/);
  });

  it('rejects a missing capture helper rather than passing an empty inventory', () => {
    fs.rmSync(helper('Orkas Helper'), { recursive: true });
    expect(() => verifyMacPermissions(app)).toThrow(/missing.*Helper/);
  });

  it.each([undefined, '', '  ', true])('rejects missing or invalid microphone purpose text: %s', value => {
    metadata.NSMicrophoneUsageDescription = value;
    expect(() => verifyMacPermissions(app)).toThrow(/NSMicrophoneUsageDescription/);
  });

  it.each(['codesign', 'timeout', 'plist'])('fails closed when %s cannot inspect the package', kind => {
    failure = kind;
    expect(() => verifyMacPermissions(app)).toThrow(/permission/);
  });

  it.runIf(process.platform === 'darwin')('inspects real embedded signatures and makes the CLI fail for a missing entitlement', () => {
    vi.restoreAllMocks();
    const gate = path.resolve(__dirname, '../../../product/signing/verify-mac-permissions.cjs');
    const allowed = path.join(root, 'allowed.plist');
    const missing = path.join(root, 'missing.plist');
    fs.writeFileSync(allowed, `<?xml version="1.0"?><plist version="1.0"><dict><key>${key}</key><true/></dict></plist>`);
    fs.writeFileSync(missing, '<?xml version="1.0"?><plist version="1.0"><dict/></plist>');

    function sign(bundle: string, entitlements: string) {
      const result = cp.spawnSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, bundle], {
        encoding: 'utf8', timeout: 30000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      // Re-signing the copied system executable emits this expected diagnostic.
      expect(result.stderr.trim()).toMatch(/replacing existing signature$/);
    }
    function runGate() {
      return cp.spawnSync(process.execPath, [gate, app], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    }

    for (const bundle of [...helperNames.map(helper), app]) {
      const executable = path.join(bundle, 'Contents', 'MacOS', 'fixture');
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.copyFileSync('/usr/bin/true', executable);
      fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>fixture</string>
        <key>CFBundleIdentifier</key><string>test.orkas.microphone</string>
        <key>CFBundlePackageType</key><string>APPL</string>
        <key>NSMicrophoneUsageDescription</key><string>Test microphone access.</string>
      </dict></plist>`);
      sign(bundle, allowed);
    }
    const passed = runGate();
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain('5 signed bundles: passed');
    expect(passed.stderr).toBe('');

    sign(helper('Orkas Helper'), missing);
    sign(app, allowed);
    const rejectedHelper = runGate();
    expect(rejectedHelper.status).toBe(1);
    expect(rejectedHelper.stderr).toContain(`Orkas Helper.app: missing enabled ${key}`);
    expect(rejectedHelper.stdout).toBe('');

    sign(helper('Orkas Helper'), allowed);
    sign(app, missing);
    const rejectedApp = runGate();
    expect(rejectedApp.status).toBe(1);
    expect(rejectedApp.stderr).toContain(`Orkas.app: missing enabled ${key}`);
    expect(rejectedApp.stdout).toBe('');
  });
});
