"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const MICROPHONE_ENTITLEMENT = "com.apple.security.device.audio-input";

function toolOutput(label, command, args, input) {
  const result = cp.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(`${label}: permission inspection failed (${command})`);
  }
  // codesign writes diagnostics to stderr; only stdout contains the plist.
  return result.stdout;
}

function readPlist(label, file, input) {
  const json = toolOutput(label, "plutil", ["-convert", "json", "-o", "-", file], input);
  try {
    const value = JSON.parse(json);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Reject unreadable permission metadata below. */ }
  throw new Error(`${label}: invalid permission plist`);
}

function verifyMacPermissions(appDir) {
  const label = path.basename(appDir);
  const info = readPlist(label, path.join(appDir, "Contents", "Info.plist"));
  if (typeof info.NSMicrophoneUsageDescription !== "string" || !info.NSMicrophoneUsageDescription.trim()) {
    throw new Error(`${label}: missing NSMicrophoneUsageDescription`);
  }

  const frameworks = path.join(appDir, "Contents", "Frameworks");
  const helpers = fs.readdirSync(frameworks, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"))
    .map(entry => entry.name).sort();
  const appName = path.basename(appDir, ".app");
  for (const suffix of ["", " (Renderer)", " (GPU)", " (Plugin)"]) {
    const name = `${appName} Helper${suffix}.app`;
    if (!helpers.includes(name)) throw new Error(`${label}: missing permission target ${name}`);
  }

  // Verify embedded entitlements, not the source signing templates. All
  // Electron helpers use the inherited signing policy, including new helpers.
  const bundles = [appDir, ...helpers.map(name => path.join(frameworks, name))];
  for (const bundle of bundles) {
    const targetLabel = path.basename(bundle);
    const xml = toolOutput(targetLabel, "codesign", ["-d", "--entitlements", "-", "--xml", bundle]);
    const entitlements = readPlist(targetLabel, "-", xml);
    if (entitlements[MICROPHONE_ENTITLEMENT] !== true) {
      throw new Error(`${targetLabel}: missing enabled ${MICROPHONE_ENTITLEMENT} in code signature`);
    }
  }
  return bundles.length;
}

module.exports = { verifyMacPermissions };

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: verify-mac-permissions.cjs <app>");
    const count = verifyMacPermissions(path.resolve(process.argv[2]));
    console.log(`[mac-permissions] microphone metadata and ${count} signed bundles: passed`);
  } catch (error) {
    console.error(`[mac-permissions] ${error.message}`);
    process.exitCode = 1;
  }
}
