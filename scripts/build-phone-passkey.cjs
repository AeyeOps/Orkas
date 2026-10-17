#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src/main/native/phone_passkey');
const cache = path.join(root, '.cache/phone-passkey');
const CRATE_SHA = '779e9c80ff248c7e12ea967f909249101f6e86f70fccd742d4b66c490c1710b4';
const RUST_VERSION = '1.90.0';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10 * 60_000, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error('Phone passkey build command failed');
  return result.stdout.trim();
}
function download(url, file) {
  run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--max-time', '600', '--output', file, url]);
}
function inputDigest() {
  const inputs = ['Cargo.toml', 'Cargo.lock', 'tunnel.patch', 'orkas_stdio.rs', 'src/main.rs', 'src/qr_svg.rs'];
  return hash(Buffer.concat([...inputs.map(name => fs.readFileSync(path.join(source, name))), fs.readFileSync(__filename)]));
}
function toolchain(target) {
  const cargoHome = process.env.CARGO_HOME || path.join(cache, 'cargo');
  const rustupHome = process.env.RUSTUP_HOME || path.join(cache, 'rustup');
  fs.mkdirSync(cargoHome, { recursive: true });
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    RUSTUP_TOOLCHAIN: RUST_VERSION, MACOSX_DEPLOYMENT_TARGET: '13.0' };
  // Vendored OpenSSL must not accidentally pick up a developer's Homebrew DLLs.
  for (const key of Object.keys(env)) if (/OPENSSL/.test(key)) delete env[key];
  const cargo = path.join(cargoHome, 'bin/cargo');
  const rustup = path.join(cargoHome, 'bin/rustup');
  if (!fs.existsSync(rustup)) {
    const host = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    const installer = path.join(cache, 'rustup-init');
    const url = `https://static.rust-lang.org/rustup/archive/1.29.1/${host}/rustup-init`;
    download(`${url}.sha256`, `${installer}.sha256`);
    download(url, installer);
    const expected = fs.readFileSync(`${installer}.sha256`, 'utf8').split(/\s/)[0];
    if (!/^[a-f0-9]{64}$/.test(expected) || fileHash(installer) !== expected) throw new Error('Rust installer checksum mismatch');
    fs.chmodSync(installer, 0o755);
    run(installer, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', RUST_VERSION], { env });
  }
  run(rustup, ['toolchain', 'install', RUST_VERSION, '--profile', 'minimal'], { env });
  run(rustup, ['target', 'add', target, '--toolchain', RUST_VERSION], { env });
  return { cargo, env };
}
function build(platform, arch) {
  const outputRoot = path.join(root, 'resources/runtime/phone-passkey');
  if (platform !== 'darwin') {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    console.log('[phone-passkey] native OS path; helper not required');
    return;
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Phone passkey helper requires a Mac build host');
  const key = `darwin-${arch}`;
  const out = path.join(outputRoot, key);
  const digest = inputDigest();
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(out, '.orkas-phone-passkey.json'), 'utf8'));
    if (marker.source === digest) {
      require('../bin/runtime-gate.cjs').verifyPhonePasskeyRuntimeDir(path.join(root, 'resources/runtime'), platform, arch,
        { allowedKeys: ['darwin-arm64', 'darwin-x64'] });
      console.log(`[phone-passkey] ready: ${key}`);
      return;
    }
  } catch { /* A stale or corrupt runtime must be rebuilt, never accepted. */ }
  fs.mkdirSync(cache, { recursive: true });
  const target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const { cargo, env } = toolchain(target);
  const work = path.join(cache, `source-${key}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'src']) fs.cpSync(path.join(source, name), path.join(work, name), { recursive: true });
  const archive = path.join(cache, 'webauthn-authenticator-rs-0.5.5.crate');
  if (!fs.existsSync(archive) || fileHash(archive) !== CRATE_SHA) {
    download('https://static.crates.io/crates/webauthn-authenticator-rs/webauthn-authenticator-rs-0.5.5.crate', archive);
  }
  if (fileHash(archive) !== CRATE_SHA) throw new Error('Phone passkey upstream checksum mismatch');
  const vendor = path.join(work, 'vendor/webauthn-authenticator-rs');
  fs.mkdirSync(vendor, { recursive: true });
  run('/usr/bin/tar', ['-xf', archive, '--strip-components=1', '-C', vendor]);
  run('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(source, 'tunnel.patch')], { cwd: vendor });
  fs.mkdirSync(path.join(vendor, 'src/cable/tunnel'), { recursive: true });
  fs.copyFileSync(path.join(source, 'orkas_stdio.rs'), path.join(vendor, 'src/cable/tunnel/orkas_stdio.rs'));
  const buildEnv = { ...env, CARGO_TARGET_DIR: path.join(cache, 'target'), CARGO_BUILD_JOBS: '2' };
  run(cargo, ['build', '--release', '--locked', '--target', target], { cwd: work, env: buildEnv });
  const temporary = `${out}.${process.pid}.tmp`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  const binary = path.join(temporary, 'orkas-phone-passkey');
  fs.copyFileSync(path.join(cache, 'target', target, 'release/orkas-phone-passkey'), binary);
  fs.chmodSync(binary, 0o755);
  run('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
  const dependencies = run('/usr/bin/otool', ['-L', binary]);
  if (dependencies.split('\n').slice(1).some(line => line.trim() && !/^\s+\/(?:usr\/lib|System\/Library)\//.test(line))) {
    throw new Error('Phone passkey binary has a non-system dynamic dependency');
  }
  // MPL source, including the modified transport, travels with the binary.
  run('/usr/bin/tar', ['-czf', path.join(temporary, 'webauthn-source.tar.gz'), '-C', path.join(work, 'vendor'), 'webauthn-authenticator-rs']);
  fs.writeFileSync(path.join(temporary, 'NOTICE.txt'),
    'Orkas phone passkey helper, protocol 1. Uses webauthn-authenticator-rs 0.5.5 (MPL-2.0).\n'
    + 'Modified library source and its license are included in webauthn-source.tar.gz.\n'
    + 'OpenSSL is statically linked (Apache-2.0); dependency license texts are included.\n');
  const licenses = path.join(temporary, 'licenses'); fs.mkdirSync(licenses);
  // Collect the locked dependency licenses from Cargo's verified source cache.
  const registry = path.join(env.CARGO_HOME, 'registry/src');
  const locked = new Set(fs.readFileSync(path.join(work, 'Cargo.lock'), 'utf8').split('[[package]]')
    .map(block => { const name = /\nname = "([^"]+)"/.exec(block)?.[1]; const version = /\nversion = "([^"]+)"/.exec(block)?.[1]; return `${name}-${version}`; }));
  if (fs.existsSync(registry)) for (const index of fs.readdirSync(registry)) {
    for (const dependency of fs.readdirSync(path.join(registry, index))) {
      if (!locked.has(dependency)) continue;
      const dir = path.join(registry, index, dependency);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) if (/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$|-)/i.test(name) && fs.statSync(path.join(dir, name)).isFile()) {
        fs.copyFileSync(path.join(dir, name), path.join(licenses, `${dependency}-${name}`));
      }
      const opensslLicense = path.join(dir, 'openssl/LICENSE.txt');
      if (dependency.startsWith('openssl-src-') && fs.existsSync(opensslLicense)) {
        fs.copyFileSync(opensslLicense, path.join(licenses, 'OpenSSL-LICENSE.txt'));
      }
    }
  }
  const files = {};
  function inventory(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = `${relative}${entry.name}`; const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inventory(file, `${name}/`);
      else files[name] = { bytes: fs.statSync(file).size, sha256: fileHash(file) };
    }
  }
  inventory(temporary);
  fs.writeFileSync(path.join(temporary, '.orkas-phone-passkey.json'), JSON.stringify({ schema: 1, protocol: 1, platformKey: key, source: digest, files }));
  fs.rmSync(out, { recursive: true, force: true }); fs.renameSync(temporary, out);
  require('../bin/runtime-gate.cjs').verifyPhonePasskeyRuntimeDir(path.join(root, 'resources/runtime'), platform, arch,
    { allowedKeys: ['darwin-arm64', 'darwin-x64'] });
  console.log(`[phone-passkey] built: ${key}`);
}
module.exports = { build, inputDigest };
if (require.main === module) {
  const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
  try { build(arg('--platform', process.platform), arg('--arch', process.arch)); }
  catch { console.error('[phone-passkey] build failed; helper remains unavailable'); process.exit(1); }
}
