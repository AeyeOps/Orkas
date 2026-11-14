import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/orkas';

const root = mkdtempSync(path.join(os.tmpdir(), 'orkas-browser-profile-e2e-'));
const bin = path.join(root, 'browser binaries');
const config = path.join(root, 'config');
const detected = path.join(config, 'chromium');
const custom = path.join(root, 'custom browser data');
const launcherData = path.join(root, 'launcher browser data');
const applications = path.join(root, 'data', 'applications');
const output = path.join(root, 'browser-args.json');
const executable = path.join(bin, 'chromium');
const pidFile = path.join(root, 'browser-pid');
mkdirSync(bin, { recursive: true });
mkdirSync(detected, { recursive: true });
mkdirSync(custom, { recursive: true });
mkdirSync(launcherData, { recursive: true });
mkdirSync(applications, { recursive: true });
writeFileSync(path.join(launcherData, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Launcher Test' } } } }));
writeFileSync(path.join(applications, 'a-app.desktop'), `[Desktop Entry]\nName=Fake App\nExec="${executable}" "--user-data-dir=${launcherData}" --profile-directory=Default --app-id=fake\n`);
writeFileSync(path.join(applications, 'b-browser.desktop'), `[Desktop Entry]\nName=Test Browser\nExec="${executable}" "--user-data-dir=${launcherData}" --profile-directory=Default %U\n`);
writeFileSync(path.join(detected, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Detected Test' } } } }));
writeFileSync(path.join(custom, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 7': { name: 'Custom Test' } } } }));
writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('fs'); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); if (process.argv.some(arg => arg.startsWith('https://auth.x.ai/'))) { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }\n`);
chmodSync(executable, 0o700);
const originalEnvironment = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, PATH: process.env.PATH };
process.env.XDG_CONFIG_HOME = config;
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

test.afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function openSettings(page: Page) {
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-settings-tab="general"]').click();
  await expect(page.locator('#settings-browser-select .ai-select-trigger')).toBeVisible();
}

async function choose(page: Page, label: string) {
  await page.locator('#settings-browser-select .ai-select-trigger').click();
  await page.locator('body > .ai-select-popover:not([hidden]) .ai-select-item').getByText(label, { exact: true }).click();
}

test('browser profile selection persists, validates custom profiles and routes links', async ({ orkas }) => {
  test.skip(process.platform !== 'linux');
  const page = orkas.page!;
  await openSettings(page);
  await page.locator('#settings-browser-select .ai-select-trigger').click();
  await expect(page.locator('.ai-select-popover:visible')).toContainText('Test Browser · Launcher Test');
  await expect(page.locator('.ai-select-popover:visible')).not.toContainText('Fake App · Launcher Test');
  await page.locator('body > .ai-select-popover:not([hidden]) .ai-select-item').getByText('Chromium · Detected Test', { exact: true }).click();
  await expect(page.locator('#settings-browser-status')).toContainText('saved');
  await choose(page, 'Custom profile…');
  await page.locator('#settings-browser-executable').fill(executable);
  await page.locator('#settings-browser-data-dir').fill(custom);
  await page.locator('#settings-browser-profile-name').fill('Custom Test');
  await page.locator('#settings-browser-save').click();
  await expect(page.locator('#settings-browser-select')).toContainText('chromium · Custom Test');
  await expect(page.locator('#settings-browser-status')).toContainText('saved');
  await choose(page, 'Custom profile…');
  await page.locator('#settings-browser-profile-name').fill('Missing Profile');
  await page.locator('#settings-browser-save').click();
  await expect(page.locator('#settings-browser-status')).toContainText('Profile name was not found');
  await page.locator('#settings-browser-cancel').click();
  await expect(page.locator('#settings-browser-select')).toContainText('chromium · Custom Test');
  await orkas.acknowledgeInvokeFailures('prefs.setCustomBrowser', 1);
  await page.reload();
  await openSettings(page);
  await expect(page.locator('#settings-browser-select')).toContainText('chromium · Custom Test');
  const url = 'https://example.com/auth?test=profile';
  await orkas.invoke('auth.openExternal', { url });
  await expect.poll(() => { try { return JSON.parse(readFileSync(output, 'utf8')); } catch { return null; } }).toEqual([
    `--user-data-dir=${custom}`, '--profile-directory=Profile 7', '--new-window', url,
  ]);
  rmSync(custom, { recursive: true });
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'browser-profile-test-link';
    link.href = 'https://example.com/auth';
    link.textContent = 'Open test link';
    document.body.appendChild(link);
  });
  await page.locator('#browser-profile-test-link').click();
  await expect(page.getByText('Could not open the selected browser. Check Browser profile in General settings or copy the link.')).toBeVisible();
  await orkas.acknowledgeInvokeFailures('auth.openExternal', 1);
  mkdirSync(custom, { recursive: true });
  writeFileSync(path.join(custom, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 7': { name: 'Custom Test' } } } }));
  await choose(page, 'System default browser');
  await expect(page.locator('#settings-browser-select')).toContainText('System default browser');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('#settings-browser-select')).toContainText('System default browser');
});


test('Grok sign-in opens the selected profile and cancellation leaves the browser running', async ({ cliOrkas }) => {
  test.skip(process.platform !== 'linux');
  await cliOrkas.invoke('prefs.setCustomBrowser', { executable, user_data_dir: custom, profile_name: 'Custom Test' });
  await cliOrkas.invoke('agents.create', { name: 'GrokBrowserE2E', description: 'Browser routing check', category: 'general', runtime: { kind: 'cli', cli: 'grok' } });
  writeFileSync(cliOrkas.cliStatePath, JSON.stringify({ ...cliOrkas.readCliState(), grokSignedOut: true, grokLaunchBrowser: true }));
  const page = cliOrkas.page!;
  await page.locator('#new-chat-btn').click();
  await page.locator('#new-chat-input').fill('@GrokBrowserE2E Reply hello');
  await page.locator('#new-chat-send-btn').click();
  const control = page.locator('.grok-sign-in-control');
  await control.locator('.grok-sign-in-btn').click();
  await expect(control).toHaveAttribute('data-state', 'waiting');
  await expect.poll(() => { try { return JSON.parse(readFileSync(output, 'utf8')); } catch { return null; } }).toEqual([
    `--user-data-dir=${custom}`, '--profile-directory=Profile 7', '--new-window', 'https://auth.x.ai/oauth2/authorize?client_id=e2e',
  ]);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    rmSync(custom, { recursive: true });
    await control.locator('.grok-sign-in-reopen').click();
    await expect(page.getByText('Could not open the sign-in page. Try signing in again.')).toBeVisible();
    await control.locator('.grok-sign-in-cancel').click();
    await expect(control).toHaveAttribute('data-state', 'cancelled');
    expect(() => process.kill(pid, 0)).not.toThrow();
    await cliOrkas.acknowledgeInvokeFailures('auth.openExternal', 1);
  } finally { process.kill(pid, 'SIGTERM'); }
});
