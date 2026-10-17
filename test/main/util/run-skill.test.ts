import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

let tmpDir: string;
const tmpDirs: string[] = [];
const itOnNonWindows = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-run-skill-'));
  tmpDirs.push(tmpDir);
});

afterAll(async () => {
  for (const dir of tmpDirs) {
    // Yield between retries so Windows can release executables that were just
    // launched from a generated virtualenv. A synchronous retry loop can keep
    // racing the same antivirus/process teardown handle until it exhausts.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

function writeMarketplaceSkill(dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async ({ args }) => ({ ok: true, argv: args.join(" ") });\n',
  );
}

function writeCustomSkill(dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: custom test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async () => ({ ok: true, source: "custom" });\n',
  );
}

function writeAgentMarketplaceSkill(agentId: string, dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', agentId, 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: agent private test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async ({ args }) => ({ ok: true, agent: process.env.ORKAS_AGENT_ID, argv: args.join(" ") });\n',
  );
}

function writeGlobalSkill(home: string, dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(home, '.claude', 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: global test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async () => ({ ok: true, source: "global" });\n',
  );
}

function runSkill(skillRef: string, scriptBase: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pcRoot = process.cwd();
  return spawnSync(TEST_NODE, [
    path.join(pcRoot, 'bin', 'run-skill.cjs'),
    skillRef,
    scriptBase,
    '--',
    ...args,
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ORKAS_PC_DIR: pcRoot,
    },
  });
}

function skillMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...skillMarkdownFiles(target));
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push(target);
  }
  return out;
}

describe('run-skill.cjs', () => {
  it('keeps protected skill script commands on the standard runner', () => {
    const pcRoot = process.cwd();
    const roots = [
      path.join(pcRoot, 'resources', 'builtin', 'marketplace'),
      path.join(pcRoot, 'resources', 'builtin', 'system', 'skills'),
      path.resolve(pcRoot, '..', 'Resource', 'skills'),
    ];
    const directScriptCommands: string[] = [];
    const commandPattern = /(?:\$ORKAS_NODE|\bnode\b|\bpython3?\b|\bbash\b|\bsh\b|\bruby\b|\bpwsh\b|\bpowershell\b|&\s+\$\w+)[^\n]*(?:scripts[\\/]|[\\/]scripts[\\/])/i;

    for (const file of roots.flatMap(skillMarkdownFiles)) {
      const relative = path.relative(path.resolve(pcRoot, '..'), file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        let command = lines[index].trim();
        while (/[\\`^]$/.test(command) && index + 1 < lines.length) {
          command = `${command.slice(0, -1)} ${lines[++index].trim()}`;
        }
        if (!commandPattern.test(command) || command.includes('run-skill.cjs')) continue;
        directScriptCommands.push(`${relative}:${index + 1}: ${command}`);
      }
    }

    expect(directScriptCommands).toEqual([]);
  });

  it('checks PATH when locating Git Bash for Windows shell scripts', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'), 'utf8');
    const body = source.match(/function findGitBash\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(body).toContain("findOnPath(['bash.exe', 'bash'])");
    expect(body.indexOf('findOnPath')).toBeLessThan(body.indexOf('const roots'));
  });

  it('hides spawned script windows on Windows', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'), 'utf8');
    const body = source.match(/function trySpawn\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(body).toContain('windowsHide: true');
  });

  it('resolves marketplace scripts by SKILL.md display name when dir id differs', () => {
    writeMarketplaceSkill('252af214f470', 'social-fetch', 'fetch');

    const r = runSkill('social-fetch', 'fetch', ['reddit']);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, argv: 'reddit' });
  });

  it('keeps direct internal-id lookup working', () => {
    writeMarketplaceSkill('252af214f470', 'social-fetch', 'fetch');

    const r = runSkill('252af214f470', 'fetch', ['youtube']);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, argv: 'youtube' });
  });

  it('executes the platform Skill when platform and custom roots share an id', () => {
    writeMarketplaceSkill('shared-id', 'shared-display-name', 'run');
    fs.writeFileSync(
      path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'shared-id', 'scripts', 'run.js'),
      'module.exports = async () => ({ ok: true, source: "platform" });\n',
    );
    writeCustomSkill('shared-id', 'shared-display-name', 'run');

    for (const ref of ['shared-id', 'shared-display-name']) {
      const r = runSkill(ref, 'run', [], { ORKAS_UID: 'u1' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, source: 'platform' });
    }
  });

  it('does not resolve global Skill scripts when the account preference is off', () => {
    const home = path.join(tmpDir, 'home');
    writeGlobalSkill(home, 'global-helper', 'global-helper', 'run');
    const homeEnv = process.platform === 'win32'
      ? { USERPROFILE: home, HOME: home }
      : { HOME: home };

    const enabled = runSkill('global-helper', 'run', [], {
      ...homeEnv,
      ORKAS_GLOBAL_SKILL_ROOTS_ENABLED: '1',
    });
    expect(enabled.status).toBe(0);
    expect(JSON.parse(enabled.stdout.trim())).toEqual({ ok: true, source: 'global' });

    const disabled = runSkill('global-helper', 'run', [], {
      ...homeEnv,
      ORKAS_GLOBAL_SKILL_ROOTS_ENABLED: '0',
    });
    expect(disabled.status).toBe(66);
    expect(JSON.parse(disabled.stderr.trim())).toMatchObject({
      ok: false,
      error: expect.stringContaining('skill script not found'),
    });
  });

  it.each([
    [
      'js',
      'module.exports = async ({ args, skillDir }) => ({ ext: "js", arg: args[0], resource: require("node:fs").readFileSync(require("node:path").join(skillDir, "assets", "fixture.txt"), "utf8").trim() });\n',
    ],
    [
      'mjs',
      'export default async ({ args, skillDir }) => ({ ext: "mjs", arg: args[0], resource: require("node:fs").readFileSync(require("node:path").join(skillDir, "assets", "fixture.txt"), "utf8").trim() });\n',
    ],
    [
      'ts',
      'export default async ({ args, skillDir }: { args: string[]; skillDir: string }) => ({ ext: "ts", arg: args[0], resource: require("node:fs").readFileSync(require("node:path").join(skillDir, "assets", "fixture.txt"), "utf8").trim() });\n',
    ],
  ])('loads and executes .%s module scripts with bundled resources', (ext, source) => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', `module-${ext}`);
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: module-${ext}\ndescription: ${ext} module fixture\n---\n\nbody\n`,
    );
    fs.writeFileSync(path.join(skillDir, 'assets', 'fixture.txt'), `resource-${ext}\n`);
    fs.writeFileSync(path.join(skillDir, 'scripts', `run.${ext}`), source);

    const r = runSkill(`module-${ext}`, 'run', [`arg-${ext}`]);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({
      ext,
      arg: `arg-${ext}`,
      resource: `resource-${ext}`,
    });
  });

  it('exits non-zero while preserving a module semantic-failure report', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'module-failure');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: module-failure\ndescription: semantic failure fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'validate.mjs'),
      'export default async () => ({ ok: false, errors: ["artifact is invalid"] });\n',
    );

    const r = runSkill('module-failure', 'validate');

    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({
      ok: false,
      errors: ['artifact is invalid'],
    });
  });

  it('initializes an awaiting .mjs entry once and preserves its default-function invocation', () => {
    writeCustomSkill('await-entry', 'await-entry', 'run');
    const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', 'await-entry');
    const marker = path.join(skillDir, 'calls.txt');
    const entry = path.join(skillDir, 'scripts', 'run.mjs');
    fs.rmSync(path.join(skillDir, 'scripts', 'run.js'));
    fs.writeFileSync(entry, `
      import fs from 'node:fs';
      await Promise.resolve();
      fs.appendFileSync(${JSON.stringify(marker)}, 'init\\n');
      async function dispatch({ args, skillId, skillDir }) {
        fs.appendFileSync(${JSON.stringify(marker)}, 'dispatch\\n');
        return { args, skillId, skillDir, url: import.meta.url };
      }
      if (require.main === module) await dispatch({ args: ['cli'] });
      export default dispatch;
    `);

    const args = ['--selftest', 'two words', '中文', ''];
    const r = runSkill('await-entry', 'run', args);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ args, skillId: 'await-entry', skillDir, url: pathToFileURL(fs.realpathSync(entry)).href });
    expect(fs.readFileSync(marker, 'utf8')).toBe('init\ndispatch\n');
  });

  it('awaits transitive ESM initialization without duplicating a shared dependency', () => {
    writeCustomSkill('await-dependency', 'await-dependency', 'run');
    const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', 'await-dependency');
    const scripts = path.join(skillDir, 'scripts');
    const marker = path.join(skillDir, 'calls.txt');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.mkdirSync(path.join(scripts, 'nested'));
    fs.writeFileSync(path.join(scripts, 'nested', 'value.cjs'), 'module.exports = "relative-resource";');
    fs.writeFileSync(path.join(scripts, 'nested', 'ready.mjs'), `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(marker)}, 'init\\n');
      export const value = await Promise.resolve(require('./value.cjs'));
      export const directory = __dirname;
    `);
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      import { value, directory } from './nested/ready.mjs';
      export default async () => {
        const again = await import('./nested/ready.mjs');
        return { value, directory, same: value === again.value };
      };
    `);

    const r = runSkill('await-dependency', 'run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ value: 'relative-resource', directory: fs.realpathSync(path.join(scripts, 'nested')), same: true });
    expect(fs.readFileSync(marker, 'utf8')).toBe('init\n');
  });

  it('preserves legacy require and import identity for a synchronous .mjs dependency', () => {
    writeCustomSkill('legacy-dependency', 'legacy-dependency', 'run');
    const scripts = path.join(tmpDir, 'u1', 'cloud', 'skills', 'legacy-dependency', 'scripts');
    const marker = path.join(scripts, 'calls.txt');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'helper.mjs'), `
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'init\\n');
      export const value = {};
    `);
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      import { value } from './helper.mjs';
      export default async () => ({ same: value === require('./helper.mjs').value });
    `);

    const r = runSkill('legacy-dependency', 'run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ same: true });
    expect(fs.readFileSync(marker, 'utf8')).toBe('init\n');
  });

  it('does not replay initialization or call the default entry after an ESM load failure', () => {
    writeCustomSkill('failed-initialization', 'failed-initialization', 'run');
    const scripts = path.join(tmpDir, 'u1', 'cloud', 'skills', 'failed-initialization', 'scripts');
    const marker = path.join(scripts, 'calls.txt');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'ready.mjs'), `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(marker)}, 'init\\n');
      await Promise.resolve();
      throw new Error('fixture initialization failed');
    `);
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      import './ready.mjs';
      export default async () => {
        require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'dispatch\\n');
      };
    `);

    const r = runSkill('failed-initialization', 'run');
    expect(r.status).toBe(71);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toMatchObject({ ok: false, error: expect.stringContaining('fixture initialization failed') });
    expect(fs.readFileSync(marker, 'utf8')).toBe('init\n');
  });

  it('preserves authored require bindings and resolves ESM packages from the PC fallback', () => {
    writeCustomSkill('esm-packages', 'esm-packages', 'run');
    const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', 'esm-packages');
    const scripts = path.join(skillDir, 'scripts');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      import { z } from 'zod';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const __orkas_skill_cjs = 'authored';
      const value = await Promise.resolve(z.string().parse('esm-ready'));
      export default async () => ({ value, authored: __orkas_skill_cjs,
        exists: require('node:fs').existsSync(__filename) });
    `);
    const r = runSkill('esm-packages', 'run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ value: 'esm-ready', authored: 'authored', exists: true });
  });

  it('retains CommonJS-style .mjs entries and dependency return shapes', () => {
    writeCustomSkill('cjs-mjs', 'cjs-mjs', 'run');
    const scripts = path.join(tmpDir, 'u1', 'cloud', 'skills', 'cjs-mjs', 'scripts');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'helper.mjs'), `
      globalThis.__legacyHelperLoads = (globalThis.__legacyHelperLoads || 0) + 1;
      module.exports = () => "legacy-cjs";
    `);
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      globalThis.__legacyEntryLoads = (globalThis.__legacyEntryLoads || 0) + 1;
      module.exports = async ({ args }) => ({ value: require('./helper.mjs')(), args,
        entryLoads: globalThis.__legacyEntryLoads, helperLoads: globalThis.__legacyHelperLoads });
    `);
    const r = runSkill('cjs-mjs', 'run', ['--selftest']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ value: 'legacy-cjs', args: ['--selftest'], entryLoads: 1, helperLoads: 1 });

    fs.writeFileSync(path.join(scripts, 'inspect.mjs'), `
      import helper from './helper.mjs';
      export default async () => ({ same: helper === require('./helper.mjs'), value: helper(),
        helperLoads: globalThis.__legacyHelperLoads });
    `);
    const inspected = runSkill('cjs-mjs', 'inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(inspected.stderr).toBe('');
    expect(JSON.parse(inspected.stdout)).toEqual({ same: true, value: 'legacy-cjs', helperLoads: 1 });

    fs.writeFileSync(path.join(scripts, 'named-default.mjs'), 'exports.default = async ({ args }) => ({ args });');
    const namedDefault = runSkill('cjs-mjs', 'named-default', ['--selftest']);
    expect(namedDefault.status, namedDefault.stderr).toBe(0);
    expect(namedDefault.stderr).toBe('');
    expect(JSON.parse(namedDefault.stdout)).toEqual({ args: ['--selftest'] });
  });

  it('does not substitute the PC package for a broken package installed beside an ESM Skill', () => {
    writeCustomSkill('broken-esm-package', 'broken-esm-package', 'run');
    const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', 'broken-esm-package');
    const scripts = path.join(skillDir, 'scripts');
    fs.rmSync(path.join(scripts, 'run.js'));
    const dependency = path.join(skillDir, 'node_modules', 'zod');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'zod', exports: './missing.mjs' }));
    fs.writeFileSync(path.join(scripts, 'run.mjs'), "import { z } from 'zod'; export default async () => ({ value: z.string().parse('wrong-copy') });");
    const r = runSkill('broken-esm-package', 'run');
    expect(r.status).toBe(71);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toMatchObject({ ok: false, error: expect.stringContaining('missing.mjs') });
  });

  it('retains relative TypeScript dependency resolution and transformation for .mjs entries', () => {
    writeCustomSkill('esm-ts-dependency', 'esm-ts-dependency', 'run');
    const scripts = path.join(tmpDir, 'u1', 'cloud', 'skills', 'esm-ts-dependency', 'scripts');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'helper.ts'), `
      enum Mode { Ready = 'typed-ready' }
      export const value: string = Mode.Ready;
    `);
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      import { value } from './helper';
      export default async () => ({ value, same: value === require('./helper.ts').value });
    `);
    const r = runSkill('esm-ts-dependency', 'run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ value: 'typed-ready', same: true });
  });

  it('does not report success when ESM initialization remains unsettled without active handles', () => {
    writeCustomSkill('unsettled-esm', 'unsettled-esm', 'run');
    const scripts = path.join(tmpDir, 'u1', 'cloud', 'skills', 'unsettled-esm', 'scripts');
    fs.rmSync(path.join(scripts, 'run.js'));
    fs.writeFileSync(path.join(scripts, 'run.mjs'), `
      await new Promise(() => {});
      export default async () => ({ dispatched: true });
    `);
    const r = runSkill('unsettled-esm', 'run');
    expect(r.status).toBe(71);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('does not infer failure from module-specific fields without ok false', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'module-result');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: module-result\ndescription: module result fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'inspect.js'),
      'module.exports = async () => ({ valid: false, reason: "informational result" });\n',
    );

    const r = runSkill('module-result', 'inspect');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({
      valid: false,
      reason: 'informational result',
    });
  });

  it('flushes module stdout larger than the process pipe before exiting', () => {
    const skillDir = path.join(tmpDir, 'u1', 'cloud', 'skills', 'large-module-output');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: large-module-output\ndescription: large output fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'run.js'),
      "module.exports = async () => { process.stdout.write('x'.repeat(80000)); return { tail: 'done' }; };\n",
    );

    const r = runSkill('large-module-output', 'run');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(Buffer.byteLength(r.stdout)).toBe(80016);
    expect(r.stdout).toBe(`${'x'.repeat(80000)}{"tail":"done"}\n`);
  });

  it('uses an exact internal id to disambiguate same-name Skill scripts', () => {
    writeMarketplaceSkill('duplicate-first', 'duplicate-name', 'run');
    writeMarketplaceSkill('duplicate-second', 'duplicate-name', 'run');
    fs.writeFileSync(
      path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'duplicate-first', 'scripts', 'run.js'),
      'module.exports = async () => ({ selected: "first" });\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'duplicate-second', 'scripts', 'run.js'),
      'module.exports = async () => ({ selected: "second" });\n',
    );

    const r = runSkill('duplicate-second', 'run');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ selected: 'second' });
  });

  it('rejects path-like Skill refs before filesystem resolution', () => {
    const r = runSkill('../outside-skill', 'run');

    expect(r.status).toBe(64);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr.trim())).toMatchObject({
      ok: false,
      error: 'skill id/name must be one non-path segment',
    });
  });

  itOnNonWindows('rejects script symlinks that escape the admitted Skill scripts directory', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'symlink-skill');
    const scriptsDir = path.join(skillDir, 'scripts');
    const outsideScript = path.join(tmpDir, 'outside-script.js');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: symlink-skill\ndescription: symlink fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(outsideScript, 'module.exports = async () => ({ escaped: true });\n');
    fs.symlinkSync(outsideScript, path.join(scriptsDir, 'run.js'));

    const r = runSkill('symlink-skill', 'run');

    expect(r.status).toBe(66);
    expect(r.stdout).toBe('');
    const error = JSON.parse(r.stderr.trim());
    expect(error.error).toContain('skill script not found');
    expect(error.searched).toEqual(expect.arrayContaining(['symlink-skill/scripts/run.js']));
    expect(r.stderr).not.toContain(tmpDir);
  });

  it('resolves current-agent private marketplace scripts from the installed agent directory', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', ['--op', 'inspect'], {
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-a',
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, agent: 'agent-a', argv: '--op inspect' });
  });

  it('does not expose another agent private marketplace skill', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', [], {
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-b',
    });

    expect(r.status).toBe(66);
    expect(r.stdout).toBe('');
    const err = JSON.parse(r.stderr.trim());
    expect(err.ok).toBe(false);
    expect(err.error).toContain('skill script not found');
    expect(JSON.stringify(err.searched)).not.toContain('agent-a');
  });

  it('requires ORKAS_UID before resolving agent private marketplace skills', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', [], {
      ORKAS_AGENT_ID: 'agent-a',
    });

    expect(r.status).toBe(66);
    const err = JSON.parse(r.stderr.trim());
    expect(err.ok).toBe(false);
    expect(JSON.stringify(err.searched)).not.toContain('agent-a');
  });

  itOnNonWindows('prefers POSIX scripts over Windows-native scripts outside Windows', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'dual');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: dual\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(scriptsDir, 'run.sh'), 'printf \'{"runner":"sh"}\\n\'\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.ps1'), 'Write-Output \'{"runner":"ps1"}\'\n');

    const r = runSkill('dual', 'run');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ runner: 'sh' });
  });

  it.runIf(process.platform === 'win32')('prefers Windows-native scripts over shell scripts on Windows', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'dual-win');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: dual-win\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(scriptsDir, 'run.ps1'), 'Write-Output \'{"runner":"ps1"}\'\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.sh'), 'printf \'{"runner":"sh"}\\n\'\n');

    const r = runSkill('dual-win', 'run');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ runner: 'ps1' });
  });

  it('uses ORKAS_PYTHON for plain Python skill scripts', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'py-skill');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: py-skill\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(scriptsDir, 'run.py'),
      process.platform === 'win32'
        ? 'process.stdout.write(JSON.stringify({ python: "bundled", script: process.argv[1], argv: process.argv[2] }));\n'
        : 'print("system python should not run this")\n',
    );

    const fakePython = process.platform === 'win32' ? TEST_NODE : path.join(tmpDir, 'fake-python');
    if (process.platform === 'win32') {
      expect(fs.existsSync(fakePython)).toBe(true);
    } else {
      fs.writeFileSync(fakePython, [
        '#!/bin/sh',
        'printf \'{"python":"bundled","script":"%s","argv":"%s"}\\n\' "$1" "$2"',
        '',
      ].join('\n'));
      fs.chmodSync(fakePython, 0o755);
    }

    const r = runSkill('py-skill', 'run', ['arg1'], { ORKAS_PYTHON: fakePython });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout.trim());
    expect(out.python).toBe('bundled');
    expect(out.script).toMatch(/run\.py$/);
    expect(out.argv).toBe('arg1');
  });

  itOnNonWindows('installs declared Python requirements once before the first skill run', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'cold-python');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: cold-python\ndescription: dependency bootstrap fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'requirements.run.txt'), 'fixture-package==1.0.0\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.py'), 'print("the fake isolated python handles this")\n');
    fs.writeFileSync(path.join(scriptsDir, 'inspect.py'), 'print("this script has no dependency manifest")\n');

    const fakePython = path.join(tmpDir, 'fake-python');
    fs.writeFileSync(fakePython, [
      '#!/bin/sh',
      'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
      '  mkdir -p "$3/bin"',
      '  cp "$0" "$3/bin/python"',
      '  chmod +x "$3/bin/python"',
      '  exit 0',
      'fi',
      'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
      '  if [ "$FAIL_SKILL_PIP" = "1" ]; then exit 9; fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "--version" ]; then',
      '  printf \'Python 3.12.99\\n\'',
      '  exit 0',
      'fi',
      'printf \'{"python":"isolated","runner":"%s","script":"%s","argv":"%s"}\\n\' "$0" "$1" "$2"',
      '',
    ].join('\n'));
    fs.chmodSync(fakePython, 0o755);

    const env = {
      ORKAS_PYTHON: fakePython,
      ORKAS_UV: '',
      ORKAS_VENV_ROOT: path.join(tmpDir, 'venv'),
      PATH: '/usr/bin:/bin',
    };
    const unrelated = runSkill('cold-python', 'inspect', ['plain'], env);
    expect(unrelated.status).toBe(0);
    expect(unrelated.stderr).not.toContain('Installing Python dependencies');
    expect(JSON.parse(unrelated.stdout.trim())).toMatchObject({
      runner: fakePython,
      argv: 'plain',
    });

    const failed = runSkill('cold-python', 'run', ['failed'], {
      ...env,
      FAIL_SKILL_PIP: '1',
    });
    expect(failed.status).toBe(70);
    expect(failed.stderr).toContain('failed to install skill Python dependencies');

    const first = runSkill('cold-python', 'run', ['first'], env);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('Installing Python dependencies for skill cold-python');
    expect(JSON.parse(first.stdout.trim())).toMatchObject({
      python: 'isolated',
      argv: 'first',
    });
    expect(JSON.parse(first.stdout.trim()).runner).toContain(
      path.join('venv', 'python', 'skills', 'cold-python-'),
    );

    const second = runSkill('cold-python', 'run', ['second'], env);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('Installing Python dependencies');
    expect(JSON.parse(second.stdout.trim())).toMatchObject({
      python: 'isolated',
      argv: 'second',
    });
  });

  it.runIf(process.platform === 'win32')(
    'installs declared Python requirements once into a Windows Scripts venv',
    () => {
      const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'cold-python-win');
      const scriptsDir = path.join(skillDir, 'scripts');
      const installLog = path.join(tmpDir, 'windows-python-install.log');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: cold-python-win\ndescription: Windows dependency bootstrap fixture\n---\n\nbody\n',
      );
      fs.writeFileSync(path.join(skillDir, 'requirements.run.txt'), 'fixture-package==1.0.0\n');
      fs.writeFileSync(
        path.join(scriptsDir, 'run.py'),
        'process.stdout.write(JSON.stringify({ python: "isolated", runner: process.execPath, argv: process.argv[2] }));\n',
      );
      fs.writeFileSync(
        path.join(skillDir, 'venv'),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'const venv = process.argv.at(-1);',
          'const python = path.join(venv, "Scripts", "python.exe");',
          'fs.mkdirSync(path.dirname(python), { recursive: true });',
          'try { fs.linkSync(process.execPath, python); } catch { fs.copyFileSync(process.execPath, python); }',
          'fs.appendFileSync(process.env.FAKE_SKILL_PYTHON_LOG, `venv:${python}\\n`);',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(skillDir, 'pip'),
        [
          'const fs = require("node:fs");',
          'fs.appendFileSync(process.env.FAKE_SKILL_PYTHON_LOG, `pip:${JSON.stringify(process.argv.slice(2))}\\n`);',
          'if (process.env.FAIL_SKILL_PIP === "1") process.exit(9);',
          '',
        ].join('\n'),
      );

      const env = {
        ORKAS_PYTHON: TEST_NODE,
        ORKAS_UV: TEST_NODE,
        ORKAS_VENV_ROOT: path.join(tmpDir, 'venv'),
        FAKE_SKILL_PYTHON_LOG: installLog,
      };
      const failed = runSkill('cold-python-win', 'run', ['failed'], {
        ...env,
        FAIL_SKILL_PIP: '1',
      });
      expect(failed.status).toBe(70);
      expect(failed.stderr).toContain('failed to install skill Python dependencies');

      const first = runSkill('cold-python-win', 'run', ['first'], env);
      expect(first.status).toBe(0);
      expect(first.stderr).toContain('Installing Python dependencies for skill cold-python-win');
      const firstOut = JSON.parse(first.stdout.trim());
      expect(firstOut).toMatchObject({ python: 'isolated', argv: 'first' });
      expect(firstOut.runner).toContain(path.join('venv', 'python', 'skills', 'cold-python-win-'));
      expect(firstOut.runner).toMatch(/[\\/]Scripts[\\/]python\.exe$/);

      const installEvents = fs.readFileSync(installLog, 'utf8').trim().split(/\r?\n/);
      expect(installEvents.filter((line) => line.startsWith('venv:'))).toHaveLength(2);
      expect(installEvents.filter((line) => line.startsWith('pip:'))).toHaveLength(2);
      expect(installEvents.at(-1)).toContain('Scripts\\\\python.exe');

      const second = runSkill('cold-python-win', 'run', ['second'], env);
      expect(second.status).toBe(0);
      expect(second.stderr).not.toContain('Installing Python dependencies');
      expect(JSON.parse(second.stdout.trim())).toMatchObject({
        python: 'isolated',
        runner: firstOut.runner,
        argv: 'second',
      });
      expect(fs.readFileSync(installLog, 'utf8').trim().split(/\r?\n/)).toEqual(installEvents);
    },
  );
});
