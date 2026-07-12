// iOS IPA validation tests cover the App Store upload gate without real signing assets.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-validate-app-store-ipa.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMESTAMP = "2026-07-10T12:34:56.000Z";

const tempDirs: string[] = [];

function bashArgs(scriptPath: string): string[] {
  return process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

function plistString(key: string, value: string): string {
  return `<key>${key}</key><string>${value}</string>`;
}

function plistArray(key: string, values: readonly string[]): string {
  return `<key>${key}</key><array>${values.map((value) => `<string>${value}</string>`).join("")}</array>`;
}

function plistBool(key: string, value: boolean): string {
  return `<key>${key}</key><${value ? "true" : "false"}/>`;
}

function plistDict(key: string, body: string): string {
  return `<key>${key}</key><dict>${body}</dict>`;
}

function plist(body: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>${body}</dict></plist>`,
  ].join("\n");
}

function writeFakePlistBuddy(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const commandIndex = process.argv.indexOf("-c");
if (commandIndex < 0) process.exit(2);
const command = process.argv[commandIndex + 1] || "";
const file = process.argv[commandIndex + 2];
const keyPath = command.replace(/^Print:/, "").split(":").filter(Boolean);
const xml = readFileSync(file, "utf8");
const tokens = [...xml.matchAll(/<key>([^<]*)<\\/key>|<string>([^<]*)<\\/string>|<true\\/>|<false\\/>|<array>|<\\/array>|<dict>|<\\/dict>/g)];
let i = 0;
function parseValue() {
  const token = tokens[i++];
  if (!token) return undefined;
  const text = token[0];
  if (token[2] !== undefined) return token[2];
  if (text === "<true/>") return true;
  if (text === "<false/>") return false;
  if (text === "<dict>") return parseDict();
  if (text === "<array>") {
    const values = [];
    while (i < tokens.length && tokens[i][0] !== "</array>") {
      const value = parseValue();
      if (value !== undefined) values.push(value);
    }
    i++;
    return values;
  }
  return undefined;
}
function parseDict() {
  const obj = {};
  while (i < tokens.length && tokens[i][0] !== "</dict>") {
    const key = tokens[i++][1];
    if (key === undefined) continue;
    obj[key] = parseValue();
  }
  i++;
  return obj;
}
while (i < tokens.length && tokens[i][0] !== "<dict>") i++;
const root = parseValue();
let current = root;
for (const key of keyPath) {
  if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
    process.exit(1);
  }
  current = current[key];
}
if (Array.isArray(current)) {
  console.log("Array {");
  for (const value of current) console.log("    " + value);
  console.log("}");
} else if (current && typeof current === "object") {
  console.log("Dict {");
  console.log("}");
} else if (typeof current === "string") {
  console.log(current);
} else if (typeof current === "boolean") {
  console.log(current ? "true" : "false");
} else {
  process.exit(1);
}
`,
  );
}

function writeFakeUnzip(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const requireFromRepo = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromRepo("jszip");

const args = process.argv.slice(2);
let ipaPath = "";
let outputDir = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-d") {
    outputDir = args[++i] || "";
  } else if (!arg.startsWith("-")) {
    ipaPath = arg;
  }
}
if (!ipaPath || !outputDir) process.exit(2);

(async () => {
  const zip = await JSZip.loadAsync(readFileSync(ipaPath));
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    const outputPath = path.join(outputDir, entryPath);
    if (entry.dir) {
      mkdirSync(outputPath, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, await entry.async("nodebuffer"));
  }
})().catch(() => process.exit(1));
`,
  );
}

async function writeIpaFixture(root: string): Promise<string> {
  const zip = new JSZip();

  function addTree(dirPath: string, zipPath: string): void {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const sourcePath = path.join(dirPath, entry.name);
      const entryZipPath = `${zipPath}/${entry.name}`;
      if (entry.isDirectory()) {
        addTree(sourcePath, entryZipPath);
      } else if (entry.isFile()) {
        zip.file(entryZipPath, readFileSync(sourcePath), { date: new Date(0) });
      }
    }
  }

  addTree(path.join(root, "Payload"), "Payload");
  const ipaPath = path.join(root, "OpenClaw.ipa");
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(ipaPath, buffer);
  return ipaPath;
}

async function writeValidFixture(
  root: string,
  options: {
    buildCommit?: string;
    buildTimestamp?: string;
    pushMode?: string;
    legacyKey?: boolean;
  } = {},
): Promise<{
  ipaPath: string;
  plistBuddy: string;
  codesign: string;
  security: string;
  unzip: string;
}> {
  const binDir = path.join(root, "bin");
  const payloadDir = path.join(root, "Payload");
  const appDir = path.join(payloadDir, "OpenClaw.app");
  const fixturesDir = path.join(root, "fixtures");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  const infoBody = [
    plistString("CFBundleIdentifier", "ai.openclawfoundation.app"),
    plistString("OpenClawGitCommit", options.buildCommit ?? BUILD_COMMIT),
    plistString("OpenClawBuildTimestamp", options.buildTimestamp ?? BUILD_TIMESTAMP),
    plistString("OpenClawPushMode", options.pushMode ?? "appStore"),
    plistString("OpenClawPushRelayBaseURL", ""),
    options.legacyKey ? plistString("OpenClawPushRelayProfile", "production") : "",
  ].join("");
  writeFileSync(path.join(appDir, "Info.plist"), plist(infoBody), "utf8");
  writeFileSync(path.join(appDir, "embedded.mobileprovision"), "fixture profile", "utf8");

  const entitlementsPath = path.join(fixturesDir, "entitlements.plist");
  writeFileSync(
    entitlementsPath,
    plist(
      [
        plistString("application-identifier", "FWJYW4S8P8.ai.openclawfoundation.app"),
        plistString("com.apple.developer.team-identifier", "FWJYW4S8P8"),
        plistString("aps-environment", "production"),
        plistString("com.apple.developer.devicecheck.appattest-environment", "production"),
        plistBool("com.apple.developer.healthkit", true),
        plistArray("com.apple.security.application-groups", [
          "group.ai.openclawfoundation.app.shared",
        ]),
      ].join(""),
    ),
    "utf8",
  );

  const profilePath = path.join(fixturesDir, "profile.plist");
  writeFileSync(
    profilePath,
    plist(
      [
        plistString("Name", "OpenClaw App Store ai.openclawfoundation.app"),
        plistArray("TeamIdentifier", ["FWJYW4S8P8"]),
        plistDict(
          "Entitlements",
          [
            plistString("application-identifier", "FWJYW4S8P8.ai.openclawfoundation.app"),
            plistString("aps-environment", "production"),
            plistArray("com.apple.developer.devicecheck.appattest-environment", ["production"]),
            plistBool("com.apple.developer.healthkit", true),
            plistArray("com.apple.security.application-groups", [
              "group.ai.openclawfoundation.app.shared",
            ]),
          ].join(""),
        ),
      ].join(""),
    ),
    "utf8",
  );

  const plistBuddy = path.join(binDir, "plistbuddy");
  writeFakePlistBuddy(plistBuddy);
  const unzip = path.join(binDir, "unzip");
  writeFakeUnzip(unzip);
  const codesign = path.join(binDir, "codesign");
  writeExecutable(
    codesign,
    `#!/usr/bin/env bash
set -euo pipefail
cat "${entitlementsPath}"
`,
  );
  const security = path.join(binDir, "security");
  writeExecutable(
    security,
    `#!/usr/bin/env bash
set -euo pipefail
cat "${profilePath}"
`,
  );

  const ipaPath = await writeIpaFixture(root);
  return { ipaPath, plistBuddy, codesign, security, unzip };
}

function runValidator(
  fixture: {
    ipaPath: string;
    plistBuddy: string;
    codesign: string;
    security: string;
    unzip: string;
  },
  expected: { commit?: string; timestamp?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      BASH_BIN,
      [
        ...bashArgs(SCRIPT),
        "--ipa",
        fixture.ipaPath,
        "--expected-commit",
        expected.commit ?? BUILD_COMMIT,
        "--expected-build-timestamp",
        expected.timestamp ?? BUILD_TIMESTAMP,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          IOS_VALIDATE_PLIST_BUDDY_BIN: fixture.plistBuddy,
          IOS_VALIDATE_CODESIGN_BIN: fixture.codesign,
          IOS_VALIDATE_SECURITY_BIN: fixture.security,
          IOS_VALIDATE_UNZIP_BIN: fixture.unzip,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : String(e.stdout ?? "");
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr ?? "");
    return { ok: false, stdout, stderr };
  }
}

describe("scripts/ios-validate-app-store-ipa.sh", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an App Store IPA with appStore mode and production entitlements", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = await writeValidFixture(root);

    const result = runValidator(fixture);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Validated iOS App Store IPA");
  });

  it("rejects an IPA that was exported with a non-App-Store push mode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = await writeValidFixture(root, { pushMode: "localProduction" });

    const result = runValidator(fixture);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("push mode mismatch");
  });

  it("rejects legacy independently selectable production push keys", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = await writeValidFixture(root, { legacyKey: true });

    const result = runValidator(fixture);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("legacy relay profile");
  });

  it("rejects malformed or mismatched embedded build provenance", async () => {
    const malformedRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    const mismatchRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(malformedRoot, mismatchRoot);
    const malformed = await writeValidFixture(malformedRoot, { buildCommit: "deadbeef" });
    const mismatch = await writeValidFixture(mismatchRoot);

    const malformedResult = runValidator(malformed);
    const mismatchResult = runValidator(mismatch, { commit: "a".repeat(40) });

    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.stderr).toContain("full lowercase commit SHA");
    expect(mismatchResult.ok).toBe(false);
    expect(mismatchResult.stderr).toContain("embedded Git commit mismatch");
  });
});
