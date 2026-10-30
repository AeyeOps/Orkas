import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const UID = 'localaccesspolicy001';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-access-policy-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('local_access_policy', () => {
  it('recognizes actual public keys and empty templates, retaining secret and write boundaries', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = path.join(tmpDir, 'key.pem');
    const template = path.join(tmpDir, '.env.example');
    fs.writeFileSync(key, publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(template, 'API_TOKEN=\nENDPOINT=""\nREGION=${REGION}\n');
    expect(policy.sensitivePathReasons(key)).toEqual([]);
    expect(policy.sensitivePathReasons(template)).toEqual([]);
    expect(policy.sensitivePathReasons(key, 'write')).toEqual(['sensitive_path']);
    fs.writeFileSync(template, 'API_TOKEN=real-credential\n');
    expect(policy.sensitivePathReasons(template)).toEqual(['sensitive_path']);
    fs.appendFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(policy.sensitivePathReasons(key)).toEqual(['sensitive_path']);
  });
  it('validates the complete OpenSSH public record and never trusts the .pub suffix alone', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const { publicKey } = generateKeyPairSync('ed25519');
    const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
    const bytes = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))]);
    const file = path.join(tmpDir, '.ssh', 'id_ed25519.pub');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, `ssh-ed25519 ${bytes.toString('base64')}\n`);
    expect(policy.sensitivePathReasons(file)).toEqual([]);
    expect(policy.sensitivePathReasons(file, 'write')).toEqual(['sensitive_path']);
    for (const text of ['not a public key', `ssh-ed25519 ${bytes.toString('base64')}\nprivate data`, 'A'.repeat(65537)]) {
      fs.writeFileSync(file, text);
      expect(policy.sensitivePathReasons(file)).toEqual(['sensitive_path']);
    }
    const template = path.join(tmpDir, '.env.example');
    fs.writeFileSync(template, '');
    expect(policy.sensitivePathReasons(template)).toEqual([]);
  });
  it('does not treat an active workspace as sensitive solely because it is under a personal folder', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const workspace = path.join(os.homedir(), 'Desktop', 'orkas-project');
    const ordinaryFile = path.join(workspace, 'composition', 'manifest.json');
    const envFile = path.join(workspace, '.env');
    const appSupportWorkspace = path.join(os.homedir(), 'Library', 'Application Support', 'OrkasProject');
    const keychainWorkspace = path.join(os.homedir(), 'Library', 'Keychains');

    expect(policy.sensitivePathReasons(ordinaryFile, 'read')).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons(ordinaryFile, 'read', { trustedRoots: [workspace] })).toEqual([]);
    expect(policy.sensitivePathReasons(envFile, 'read', { trustedRoots: [workspace] })).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons(
      path.join(appSupportWorkspace, 'manifest.json'),
      'read',
      { trustedRoots: [appSupportWorkspace] },
    )).toEqual([]);
    expect(policy.sensitivePathReasons(
      path.join(keychainWorkspace, 'login.keychain-db'),
      'read',
      { trustedRoots: [keychainWorkspace] },
    )).toEqual(['sensitive_path']);
    expect(policy.classifyConfiguredBashCommand(
      'cat ~/Desktop/orkas-project/.env',
      [],
    )).toEqual(['sensitive_path']);
  });

  it('offers a folder grant only for reads sensitive solely for their personal location', async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = path.join(tmpDir, 'home');
    process.env.HOME = home;
    if (process.platform === 'win32') process.env.USERPROFILE = home;
    try {
      const policy = await import('../../../src/main/features/local_access_policy');
      const ads = path.join(home, 'Desktop', 'ads');
      fs.mkdirSync(ads, { recursive: true });
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
      const image = path.join(ads, 'a.png');
      fs.writeFileSync(image, 'png');
      fs.writeFileSync(path.join(ads, '.env'), 'TOKEN=1');
      fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x');
      fs.symlinkSync(path.join(home, '.ssh', 'config'), path.join(ads, 'notes.txt'));
      fs.writeFileSync(path.join(tmpDir, 'plain.txt'), 'plain');

      expect(policy.locationOnlyRead(image)).toEqual({
        folder: ads, realPath: fs.realpathSync(image), realFolder: fs.realpathSync(ads),
      });
      // A listed directory grants itself; a file not created yet, its parent.
      expect(policy.locationOnlyRead(ads)).toMatchObject({ folder: ads, realFolder: fs.realpathSync(ads) });
      expect(policy.locationOnlyRead(path.join(ads, 'later.png'))).toMatchObject({ folder: ads });
      // Intrinsic secrets, links to them, unprotected paths and trusted
      // workspaces never carry a folder grant.
      expect(policy.locationOnlyRead(path.join(ads, '.env'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(home, '.ssh', 'config'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(ads, 'notes.txt'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(tmpDir, 'plain.txt'))).toBeUndefined();
      expect(policy.locationOnlyRead(image, { trustedRoots: [ads] })).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });

  it('uses structural defaults', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const options = { structuredDefaults: true };
    expect(policy.classifyConfiguredBashCommand('echo sudo', [], options)).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('echo ~/.ssh/id_rsa', [], options)).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('sudo ls', ['priv_esc'], options)).toEqual(['priv_esc']);
  });
});
