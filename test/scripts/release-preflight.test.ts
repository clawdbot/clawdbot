// Release preflight tests keep generated-artifact checks fail-closed for operators.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/release-preflight.mjs");
const CHECK_COMMANDS = [
  "pnpm deps:root-ownership:check",
  "node scripts/generate-npm-shrinkwrap.mjs --all --check",
  "node --import tsx scripts/sync-plugin-versions.ts --check",
  "node scripts/generate-plugin-inventory-doc.mjs --check",
  "pnpm config:schema:check",
  "pnpm config:channels:check",
  "pnpm config:docs:check",
  "pnpm plugin-sdk:check-exports",
  "pnpm plugin-sdk:api:check",
  "pnpm plugin-sdk:surface:check",
  "pnpm ui:i18n:check",
];
const FIX_COMMANDS = [
  "node --import tsx scripts/sync-plugin-versions.ts",
  "node scripts/generate-npm-shrinkwrap.mjs --changed",
  "node scripts/generate-plugin-inventory-doc.mjs --write",
  "pnpm config:schema:gen",
  "pnpm config:channels:gen",
  "pnpm config:docs:gen",
  "pnpm plugin-sdk:sync-exports",
  "pnpm plugin-sdk:api:gen",
  "pnpm ui:i18n:sync",
];

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function makeFakePnpm(): { binDir: string; eventsPath: string; logPath: string } {
  const root = makeTempDir(tempDirs, "openclaw-release-preflight-");
  const binDir = join(root, "bin");
  const eventsPath = join(root, "pnpm-events.log");
  const logPath = join(root, "pnpm.log");
  mkdirSync(binDir);
  for (const bin of ["node", "pnpm"]) {
    const binPath = join(binDir, bin);
    writeFileSync(
      binPath,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";

const command = ${JSON.stringify(bin)} + " " + process.argv.slice(2).join(" ");
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG, command + "\\n");
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS, "start " + command + "\\n");
const delayMs = Number(process.env.OPENCLAW_RELEASE_PREFLIGHT_DELAY_MS ?? "0");
if (delayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS, "end " + command + "\\n");
const failures = new Set((process.env.OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS ?? "").split(";").filter(Boolean));
process.exit(failures.has(command) ? 7 : 0);
`,
      { mode: 0o755 },
    );
    chmodSync(binPath, 0o755);
  }
  return { binDir, eventsPath, logPath };
}

function runPreflight(
  args: string[],
  fakePnpm?: ReturnType<typeof makeFakePnpm>,
  extraEnv: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      ...(fakePnpm
        ? {
            OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG: fakePnpm.logPath,
            OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS: fakePnpm.eventsPath,
            PATH: `${fakePnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
          }
        : {}),
    },
  });
}

function makeReleaseFixture(
  params: {
    buildVersion?: string;
    packageVersion?: string;
    shortVersion?: string;
  } = {},
): string {
  const root = makeTempDir(tempDirs, "openclaw-release-preflight-fixture-");
  const plistDir = join(root, "apps", "macos", "Sources", "OpenClaw", "Resources");
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: params.packageVersion ?? "2026.7.1-beta.3" }, null, 2)}\n`,
  );
  writeFileSync(
    join(plistDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${params.shortVersion ?? "2026.7.1"}</string>
  <key>CFBundleVersion</key>
  <string>${params.buildVersion ?? "2026070100"}</string>
</dict>
</plist>
`,
  );
  return root;
}

function readPnpmLog(logPath: string): string[] {
  return readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean);
}

describe("scripts/release-preflight.mjs", () => {
  it("rejects unknown arguments before running release checks", () => {
    const result = runPreflight(["--fiix"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown release preflight argument: --fiix");
    expect(result.stderr).toContain(
      "Usage: node scripts/release-preflight.mjs [--check|--fix] [--scope name] [--jobs count]",
    );
    expect(result.stdout).toBe("");
  });

  it("runs every check command and reports all failed release artifact checks", () => {
    const fakePnpm = makeFakePnpm();
    const result = runPreflight(["--check"], fakePnpm, {
      OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS:
        "node --import tsx scripts/sync-plugin-versions.ts --check;pnpm config:docs:check",
    });

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(CHECK_COMMANDS.toSorted());
    expect(result.stderr).toContain(
      "- plugin versions: exit 7 (node --import tsx scripts/sync-plugin-versions.ts --check)",
    );
    expect(result.stderr).toContain("- config docs baseline: exit 7 (pnpm config:docs:check)");
  });

  it("runs independent generators while blocking only failed dependents", () => {
    const fakePnpm = makeFakePnpm();
    const result = spawnSync(process.execPath, [SCRIPT, "--fix"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS:
          "node scripts/generate-npm-shrinkwrap.mjs --changed",
        OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS: fakePnpm.eventsPath,
        OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG: fakePnpm.logPath,
        PATH: `${fakePnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(FIX_COMMANDS.toSorted());
    expect(result.stderr).toContain(
      "- npm shrinkwraps: exit 7 (node scripts/generate-npm-shrinkwrap.mjs --changed)",
    );
  });

  it("serializes the root package writer before generated-artifact readers", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(
      ["--fix", "--jobs", "8"],
      fakePnpm,
      {
        OPENCLAW_RELEASE_PREFLIGHT_DELAY_MS: "40",
      },
      root,
    );
    const events = readPnpmLog(fakePnpm.eventsPath);

    expect(result.status).toBe(0);
    expect(events.indexOf("end node --import tsx scripts/sync-plugin-versions.ts")).toBeLessThan(
      events.indexOf("start pnpm plugin-sdk:sync-exports"),
    );
    expect(events.indexOf("end pnpm plugin-sdk:sync-exports")).toBeLessThan(
      events.indexOf("start node scripts/generate-npm-shrinkwrap.mjs --changed"),
    );
    expect(events.indexOf("end pnpm plugin-sdk:sync-exports")).toBeLessThan(
      events.indexOf("start node scripts/generate-plugin-inventory-doc.mjs --write"),
    );
  });

  it("runs only version-owned generators and checks for version prep", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(["--fix", "--scope", "version"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [
        "node --import tsx scripts/sync-plugin-versions.ts",
        "node scripts/generate-npm-shrinkwrap.mjs --changed",
        "node scripts/generate-plugin-inventory-doc.mjs --write",
        "pnpm ui:i18n:sync",
        "node --import tsx scripts/sync-plugin-versions.ts --check",
        "node scripts/generate-npm-shrinkwrap.mjs --all --check",
        "node scripts/generate-plugin-inventory-doc.mjs --check",
        "pnpm ui:i18n:check",
      ].toSorted(),
    );
    expect(result.stdout).toContain("(version, jobs=4)");
  });

  it("keeps plugin shrinkwraps aligned during plugin-only prep", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(["--fix", "--scope", "plugins"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [
        "node --import tsx scripts/sync-plugin-versions.ts",
        "node scripts/generate-npm-shrinkwrap.mjs --changed",
        "node scripts/generate-plugin-inventory-doc.mjs --write",
        "node --import tsx scripts/sync-plugin-versions.ts --check",
        "node scripts/generate-npm-shrinkwrap.mjs --all --check",
        "node scripts/generate-plugin-inventory-doc.mjs --check",
      ].toSorted(),
    );
    expect(result.stdout).toContain("(plugins, jobs=4)");
  });

  it("checks non-version scopes without requiring macOS source metadata", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeTempDir(tempDirs, "openclaw-release-preflight-config-");
    const result = runPreflight(["--scope", "config"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [
        "pnpm config:schema:check",
        "pnpm config:channels:check",
        "pnpm config:docs:check",
      ].toSorted(),
    );
    expect(result.stdout).not.toContain("macOS app version metadata");
  });

  it("rejects invalid concurrency before running commands", () => {
    const result = runPreflight(["--jobs", "0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Invalid release preflight jobs value: 0; expected 1 through 16.",
    );
  });

  it("uses bounded parallelism for independent checks", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const env = { OPENCLAW_RELEASE_PREFLIGHT_DELAY_MS: "120" };

    const serialStartedAt = performance.now();
    const serial = runPreflight(["--scope", "config", "--jobs", "1"], fakePnpm, env, root);
    const serialMs = performance.now() - serialStartedAt;

    const parallelStartedAt = performance.now();
    const parallel = runPreflight(["--scope", "config", "--jobs", "3"], fakePnpm, env, root);
    const parallelMs = performance.now() - parallelStartedAt;

    expect(serial.status).toBe(0);
    expect(parallel.status).toBe(0);
    expect(parallelMs).toBeLessThan(serialMs * 0.75);
  });

  it("accepts base macOS metadata for a beta package version", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(["--check"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[release-preflight] macOS app version metadata OK");
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(CHECK_COMMANDS.toSorted());
  });

  it("reports stale macOS version and build metadata after running all checks", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture({
      buildVersion: "2026061000",
      shortVersion: "2026.6.10",
    });
    const result = runPreflight(["--check"], fakePnpm, {}, root);

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(CHECK_COMMANDS.toSorted());
    expect(result.stderr).toContain(
      'CFBundleShortVersionString is "2026.6.10"; expected "2026.7.1" from package.json base version',
    );
    expect(result.stderr).toContain(
      'CFBundleVersion is "2026061000"; expected "2026070100" for 2026.7.1',
    );
    expect(result.stderr).toContain("Correct manual version metadata first.");
  });

  it("fails closed when required macOS plist values are missing", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const plistPath = join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist");
    writeFileSync(
      plistPath,
      readFileSync(plistPath, "utf8").replace(
        /\s*<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/u,
        "",
      ),
    );
    const result = runPreflight(["--check"], fakePnpm, {}, root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Info.plist must contain exactly one string value for CFBundleVersion; found 0",
    );
  });

  it("keeps manual macOS metadata untouched in refresh mode", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture({
      buildVersion: "2026061000",
      shortVersion: "2026.6.10",
    });
    const plistPath = join(root, "apps", "macos", "Sources", "OpenClaw", "Resources", "Info.plist");
    const before = readFileSync(plistPath, "utf8");
    const result = runPreflight(["--fix"], fakePnpm, {}, root);

    expect(result.status).toBe(1);
    expect(readFileSync(plistPath, "utf8")).toBe(before);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [...FIX_COMMANDS, ...CHECK_COMMANDS].toSorted(),
    );
  });
});
