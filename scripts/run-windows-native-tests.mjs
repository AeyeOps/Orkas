#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withWindowsPowerShellModules } from './test-runtime-env.mjs';

if (process.platform !== 'win32') {
  console.log('[windows-native-tests] skipped: Windows-only native runtime gate');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, 'run-tests.mjs');
const pcRoot = resolve(here, '..');
const require = createRequire(import.meta.url);

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('powershell.exe', [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', resolve(pcRoot, 'test', 'windows', 'windows-node-bootstrap.integration.ps1'),
  '-NodeExe', process.execPath,
], {
  cwd: pcRoot,
  env: withWindowsPowerShellModules(process.env),
  stdio: 'inherit',
  timeout: 5 * 60_000,
  windowsHide: true,
});

// The canary tests the full bundled Node/npm/npx payload, not a standalone
// agent-provided Node executable that need not ship npm beside itself.
const runtimeRoot = resolve(pcRoot, 'resources', 'runtime');
const manifest = JSON.parse(readFileSync(resolve(runtimeRoot, 'manifest.json'), 'utf8'));
const runtimeGate = require('../bin/runtime-gate.cjs');
const runtimeKey = runtimeGate.runtimeKey(process.platform, process.arch);
const bundledNode = runtimeGate.verifyRuntimeDir('node', resolve(runtimeRoot, 'node', runtimeKey),
  runtimeKey, manifest.node, manifest.node.assets[runtimeKey], process.platform, process.arch);

run(bundledNode, [
  resolve(pcRoot, 'test', 'windows', 'windows-local-cli.integration.mjs'),
], {
  cwd: pcRoot,
  env: process.env,
  stdio: 'inherit',
  timeout: 25 * 60_000,
  windowsHide: true,
});

run(process.execPath, [
  runner,
  'run',
  '--maxWorkers=1',
  '-t',
  'Windows real bundled whisper transcribes within the performance budget',
  'test/main/features/video_studio_native_qa.test.ts',
], {
  cwd: pcRoot,
  env: { ...process.env, ORKAS_REAL_WHISPER_TEST: '1' },
  stdio: 'inherit',
  timeout: 2 * 60_000,
  windowsHide: true,
});
