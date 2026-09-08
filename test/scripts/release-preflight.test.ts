// Release preflight tests keep generated-artifact checks fail-closed for operators.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/release-preflight.mjs");
const CHECK_COMMANDS = [
  "pnpm deps:root-ownership:check",
  "node scripts/generate-npm-package-lock.mjs --all",
  "node --import tsx scripts/sync-plugin-versions.ts --check",
  "pnpm channels:catalog:check",
  "node --import tsx scripts/generate-plugin-inventory-doc.mts --check",
  "pnpm config:schema:check",
  "pnpm config:channels:check",
  "pnpm config:docs:check",
  "pnpm plugin-sdk:check-exports",
  "pnpm plugin-sdk:surface:check",
  "pnpm ui:i18n:check",
  "pnpm native:i18n:check",
];
const FIX_COMMANDS = [
  "node --import tsx scripts/sync-plugin-versions.ts",
  "pnpm channels:catalog:gen",
  "node --import tsx scripts/generate-plugin-inventory-doc.mts --write",
  "pnpm config:schema:gen",
  "pnpm config:channels:gen",
  "pnpm config:docs:gen",
  "pnpm plugin-sdk:sync-exports",
  "pnpm ui:i18n:sync",
];

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function makeFakePnpm(waitFor?: { command: string; event: string }): {
  binDir: string;
  eventsPath: string;
  logPath: string;
} {
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
import { appendFileSync, readFileSync } from "node:fs";

const command = ${JSON.stringify(bin)} + " " + process.argv.slice(2).join(" ");
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG, command + "\\n");
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS, "start " + command + "\\n");
const waitFor = ${JSON.stringify(waitFor ?? null)};
if (waitFor?.command === command) {
  const deadline = Date.now() + 3000;
  while (!readFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS, "utf8").split("\\n").includes(waitFor.event)) {
    if (Date.now() >= deadline) {
      console.error("Ready work did not start while another command held a worker");
      process.exit(9);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
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

function makeIsolatedPreflightFixture(params: Parameters<typeof makeReleaseFixture>[0] = {}): {
  root: string;
  script: string;
} {
  const root = makeReleaseFixture(params);
  const files = [
    "scripts/release-preflight.mjs",
    "scripts/release-preflight.mts",
    "scripts/tsx.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/error-format.mts",
    "scripts/lib/failed-trailer.mts",
    "scripts/lib/local-check-runtime.mts",
    "scripts/lib/managed-child-process.mts",
    "scripts/lib/vitest-resource-ownership.mts",
    "scripts/lib/release-version.mjs",
    "scripts/lib/tsx-cli-shim.mjs",
    "scripts/lib/windows-taskkill.mjs",
  ];
  for (const file of files) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
  }
  return { root, script: join(root, "scripts", "release-preflight.mjs") };
}

function runIsolatedPreflight(
  args: string[],
  params: Parameters<typeof makeReleaseFixture>[0] = {},
) {
  const fixture = makeIsolatedPreflightFixture(params);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.PNPM_CONFIG_MODULES_DIR;
  delete env.npm_config_modules_dir;
  return spawnSync(process.execPath, [fixture.script, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env,
  });
}

function readPnpmLog(logPath: string): string[] {
  return readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean);
}

describe("scripts/release-preflight.mjs", () => {
  it("checks valid macOS metadata without node_modules", () => {
    const result = runIsolatedPreflight(["--macos-versions-only"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[release-preflight] macOS app version metadata OK");
  });

  it("reports stale macOS metadata without node_modules", () => {
    const result = runIsolatedPreflight(["--macos-versions-only"], {
      shortVersion: "2026.6.10",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'CFBundleShortVersionString is "2026.6.10"; expected "2026.7.1" from package.json base version',
    );
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe("[release-preflight] FAILED (exit 1)");
  });

  it("keeps multi-argument invocations on the tsx shim", () => {
    const result = runIsolatedPreflight(["--macos-versions-only", "--check"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Run pnpm install --frozen-lockfile in an independently owned checkout.",
    );
    expect(result.stderr).toContain("[release-preflight] FAILED (exit 1)");
  });

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
          "node --import tsx scripts/generate-plugin-inventory-doc.mts --write",
        OPENCLAW_RELEASE_PREFLIGHT_PNPM_EVENTS: fakePnpm.eventsPath,
        OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG: fakePnpm.logPath,
        PATH: `${fakePnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(FIX_COMMANDS.toSorted());
    expect(result.stderr).toContain(
      "- plugin inventory: exit 7 (node --import tsx scripts/generate-plugin-inventory-doc.mts --write)",
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
    expect(events.indexOf("end node --import tsx scripts/sync-plugin-versions.ts")).toBeLessThan(
      events.indexOf("start pnpm channels:catalog:gen"),
    );
    expect(events.indexOf("end pnpm plugin-sdk:sync-exports")).toBeLessThan(
      events.indexOf("start node --import tsx scripts/generate-plugin-inventory-doc.mts --write"),
    );
  });

  it.each([
    {
      args: ["--check", "--scope", "config", "--jobs", "2"],
      command: "pnpm config:schema:check",
      event: "start pnpm config:docs:check",
    },
    {
      args: ["--fix", "--jobs", "4"],
      command: "pnpm ui:i18n:sync",
      event: "start pnpm plugin-sdk:sync-exports",
    },
  ])(
    "starts ready work without waiting for an unrelated command: $command",
    ({ args, command, event }) => {
      const fakePnpm = makeFakePnpm({ command, event });
      const result = runPreflight(args, fakePnpm, {}, makeReleaseFixture());
      expect(result.status, result.stderr).toBe(0);
      const events = readPnpmLog(fakePnpm.eventsPath);
      expect(events.indexOf(event)).toBeLessThan(events.indexOf(`end ${command}`));
    },
  );

  it("skips failed generator descendants while completing unrelated generators", () => {
    const fakePnpm = makeFakePnpm();
    const result = runPreflight(
      ["--fix", "--jobs", "4"],
      fakePnpm,
      {
        OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS:
          "node --import tsx scripts/sync-plugin-versions.ts",
      },
      makeReleaseFixture(),
    );
    expect(result.status).toBe(1);
    const commands = readPnpmLog(fakePnpm.logPath);
    expect(commands).toContain("pnpm config:docs:gen");
    expect(commands).not.toContain("pnpm channels:catalog:gen");
    expect(commands).not.toContain("pnpm plugin-sdk:sync-exports");
    expect(commands).not.toContain(
      "node --import tsx scripts/generate-plugin-inventory-doc.mts --write",
    );
    expect(result.stderr).toContain("skipped because plugin-versions failed");
  });

  it("runs only version-owned generators and checks for version prep", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(["--fix", "--scope", "version"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [
        "node --import tsx scripts/sync-plugin-versions.ts",
        "pnpm channels:catalog:gen",
        "node --import tsx scripts/generate-plugin-inventory-doc.mts --write",
        "pnpm ui:i18n:sync",
        "node --import tsx scripts/sync-plugin-versions.ts --check",
        "pnpm channels:catalog:check",
        "node scripts/generate-npm-package-lock.mjs --all",
        "node --import tsx scripts/generate-plugin-inventory-doc.mts --check",
        "pnpm ui:i18n:check",
        "pnpm native:i18n:check",
      ].toSorted(),
    );
    expect(result.stdout).toContain("(version, jobs=4)");
  });

  it("validates plugin npm locks during plugin-only prep", () => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const result = runPreflight(["--fix", "--scope", "plugins"], fakePnpm, {}, root);

    expect(result.status).toBe(0);
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(
      [
        "node --import tsx scripts/sync-plugin-versions.ts",
        "pnpm channels:catalog:gen",
        "node --import tsx scripts/generate-plugin-inventory-doc.mts --write",
        "node --import tsx scripts/sync-plugin-versions.ts --check",
        "pnpm channels:catalog:check",
        "node scripts/generate-npm-package-lock.mjs --all",
        "node --import tsx scripts/generate-plugin-inventory-doc.mts --check",
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

  it.each([1, 2, 3])("uses bounded parallelism for independent checks with jobs=%i", (jobs) => {
    const fakePnpm = makeFakePnpm();
    const root = makeReleaseFixture();
    const commands = [
      "pnpm config:schema:check",
      "pnpm config:channels:check",
      "pnpm config:docs:check",
    ];
    const observerPath = join(root, "observe-concurrency.cjs");
    const resultPath = join(root, "concurrency.json");
    writeFileSync(
      observerPath,
      `const childProcess = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const commands = ${JSON.stringify(commands)};
const originalSpawn = childProcess.spawn;
let active = 0;
let maxActive = 0;
let total = 0;
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  if (commands.includes([args[0], ...(args[1] ?? [])].join(" "))) {
    active += 1;
    total += 1;
    maxActive = Math.max(maxActive, active);
    child.once("close", () => { active -= 1; });
  }
  return child;
};
syncBuiltinESMExports();
process.once("exit", () => {
  if (total > 0) {
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ maxActive, total, active }));
  }
});
`,
    );

    // Count real managed commands from synchronous admission through close, excluding
    // loader startup time. Inherited observers with no matching commands write nothing.
    const result = runPreflight(
      ["--scope", "config", "--jobs", String(jobs)],
      fakePnpm,
      {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(observerPath)}`,
      },
      root,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      maxActive: Math.min(jobs, commands.length),
      total: commands.length,
      active: 0,
    });
    expect(readPnpmLog(fakePnpm.logPath).toSorted()).toEqual(commands.toSorted());
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
