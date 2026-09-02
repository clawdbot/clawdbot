import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");
const temps = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(fs.readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8"));
const swiftStep = workflow.jobs["macos-swift"].steps.find(
  (step: { name?: string }) => step.name === "Swift test",
).run as string;

function fixture(
  defaultExitCode = 0,
  waitForSignal: false | "swift" | "security" = false,
  namedExitCode = 0,
  securityFailure = "",
  logicalCpu = "3",
) {
  const root = temps.make("native-launch-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "ambient-home");
  const runnerTemp = path.join(root, "runner-temp");
  const log = path.join(root, "calls.jsonl");
  for (const dir of [bin, home, runnerTemp]) {
    fs.mkdirSync(dir);
  }
  const cache = path.join(home, "Library/Caches/org.swift.swiftpm");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "fixture-cache"), "reusable build cache");
  // Every executable that could build, test, or mutate the checkout is fake.
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const resources = ['HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'];
const present = Object.fromEntries(resources.map(key => [key, !!env[key] && fs.existsSync(env[key])]));
const cachePath = path.join(env.HOME, 'Library/Caches/org.swift.swiftpm/fixture-cache');
const cache = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8') : null;
const preferences = path.join(env.HOME, 'Library/Preferences');
const keychains = path.join(env.HOME, 'Library/Keychains');
const settingsPath = path.join(preferences, 'fixture-keychain.json');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const keychain = settings.default && fs.existsSync(settings.default) ? JSON.parse(fs.readFileSync(settings.default, 'utf8')) : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool, args, env, present, cache, settings, keychain, pid: process.pid}) + '\\n');
function awaitSignal(ownedKeychain) {
  process.on('SIGTERM', () => {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: 'shutdown', resourcesPresent: fs.existsSync(env.HOME) && fs.existsSync(env.OPENCLAW_STATE_DIR), keychainPresent: !!ownedKeychain && fs.existsSync(ownedKeychain)}) + '\\n');
    process.exit(0);
  });
  console.log('fake-child-ready');
  setInterval(() => {}, 1000);
}
if (tool === 'security') {
  assert.notEqual(env.HOME, ${JSON.stringify(home)});
  for (const dir of [preferences, keychains]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const owned = args.at(-1);
  assert.equal(path.dirname(owned), keychains);
  const operation = args[0];
  if (operation === 'create-keychain' || operation === 'unlock-keychain') {
    assert.deepEqual(args.slice(1, -1), ['-p', '']);
  } else if (operation === 'list-keychains' || operation === 'default-keychain') {
    assert.deepEqual(args.slice(1, -1), ['-d', 'user', '-s']);
  } else {
    assert.ok(['set-keychain-settings', 'delete-keychain'].includes(operation));
    assert.equal(args.length, 2);
  }
  // A failed create may already have left its owned database behind.
  if (operation === 'create-keychain') fs.writeFileSync(owned, JSON.stringify({locked: true, autoLock: true}));
  if (${JSON.stringify(waitForSignal)} === 'security' && operation === 'create-keychain') awaitSignal(owned);
  if (operation === ${JSON.stringify(securityFailure)}) process.exit(29);
  const data = JSON.parse(fs.readFileSync(owned, 'utf8'));
  if (operation === 'unlock-keychain') data.locked = false;
  if (operation === 'set-keychain-settings') data.autoLock = false;
  if (operation === 'list-keychains') settings.search = [owned];
  if (operation === 'default-keychain') settings.default = owned;
  if (operation === 'delete-keychain') fs.unlinkSync(owned);
  else fs.writeFileSync(owned, JSON.stringify(data));
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}
if (tool === 'uname') console.log('Darwin');
if (tool === 'sysctl') {
  assert.deepEqual(args, ['-n', 'hw.logicalcpu']);
  console.log(${JSON.stringify(logicalCpu)});
}
if (tool === 'rg') console.log('apps/macos/Sources/Fixture.swift');
if (tool === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(${JSON.stringify(root)});
if (tool === 'git' && args[0] === 'diff' && args.includes('--name-only')) console.log('apps/macos/Sources/Fixture.swift');
if (tool === 'swift' && args[0] === 'test') {
  if (env.OPENCLAW_STATE_DIR !== ${JSON.stringify(path.join(root, "ambient-state"))}) {
    fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, 'child-owned'), 'fixture');
  }
  if (${JSON.stringify(waitForSignal)} === 'swift') awaitSignal(settings.default);
  else process.exit(env.OPENCLAW_PROFILE === 'default' ? ${defaultExitCode} : ${namedExitCode});
}
`;
  for (const tool of ["security", "swift", "pnpm", "node", "git", "uname", "sysctl", "rg"]) {
    if (tool === "node") {
      fs.symlinkSync(process.execPath, path.join(bin, tool));
    } else {
      fs.writeFileSync(path.join(bin, tool), fake, { mode: 0o755 });
    }
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: root,
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "macOS",
    RUNNER_TEMP: runnerTemp,
    RUNNER_TRACKING_ID: "synthetic-native-runner-tracking",
    GITHUB_OUTPUT: path.join(root, "outputs"),
    HISTORICAL_TARGET: "false",
    SWIFT_TEST_EXECUTION: "serial",
    OPENCLAW_PROFILE: "ambient-fixture",
    OPENCLAW_STATE_DIR: path.join(root, "ambient-state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "ambient-config.json"),
    OPENCLAW_GATEWAY_TOKEN: "synthetic-not-a-credential",
    DEVELOPER_DIR: "/synthetic/Xcode.app/Contents/Developer",
    DYLD_FRAMEWORK_PATH: "/synthetic/frameworks",
    DYLD_LIBRARY_PATH: "/synthetic/libraries",
  };
  return {
    root,
    env,
    log,
    calls: () =>
      fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    run: (script: string, cwd = repo, overrides = {}) =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          `export DYLD_FRAMEWORK_PATH=/synthetic/frameworks DYLD_LIBRARY_PATH=/synthetic/libraries\n${script}`,
        ],
        {
          cwd,
          env: { ...env, ...overrides },
          encoding: "utf8",
          timeout: 15_000,
        },
      ),
  };
}

describe.skipIf(process.platform === "win32")("native test launch ownership", () => {
  it.each(["scripts/test-macos-native.mts", "test/scripts/macos-native-test-launch.test.ts"])(
    "routes %s through macOS CI",
    (changedPath) => {
      expect(detectChangedScope([changedPath])).toMatchObject({ runNode: true, runMacos: true });
    },
  );

  it.each([
    { defaultCode: 0, namedCode: 0, logicalCpu: "3", expectedWidth: "3" },
    { defaultCode: 23, namedCode: 0, logicalCpu: "12", expectedWidth: "12" },
    { defaultCode: 0, namedCode: 17, logicalCpu: "32", expectedWidth: "12" },
  ] as const)(
    "bounds Swift Testing on $logicalCpu logical CPUs to width $expectedWidth",
    ({ defaultCode, namedCode, logicalCpu, expectedWidth }) => {
      const f = fixture(defaultCode, false, namedCode, "", logicalCpu);
      const result = f.run(swiftStep);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(defaultCode || namedCode);
      expect(result.stdout).toContain(
        `[macos-swift] Swift Testing parallelization width: ${expectedWidth}`,
      );
      const calls = f.calls().filter((call) => call.tool === "swift");
      expect(calls).toHaveLength(defaultCode === 0 ? 3 : 2);
      const [build, ...tests] = calls;
      expect(build.args).toEqual([
        "build",
        "--package-path",
        "apps/macos",
        "--build-system",
        "native",
        "--enable-code-coverage",
        "--build-tests",
      ]);
      expect(build.env.HOME).toBe(f.env.HOME);
      const roots = new Set<string>();
      for (const [index, test] of tests.entries()) {
        expect(test.args).toEqual([
          "test",
          "--package-path",
          "apps/macos",
          "--build-system",
          "native",
          "--enable-code-coverage",
          "--skip-build",
          "--experimental-maximum-parallelization-width",
          expectedWidth,
          index === 0 ? "--skip" : "--filter",
          "AppStateIsolationTests",
        ]);
        if (index === 0) {
          expect(test.env.OPENCLAW_PROFILE).toBe("default");
        } else {
          expect(test.env.OPENCLAW_PROFILE).toMatch(/^test-[a-z0-9-]+$/);
        }
        expect(test.env.OPENCLAW_PROFILE).not.toBe(f.env.OPENCLAW_PROFILE);
        expect(test.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        for (const key of [
          "DEVELOPER_DIR",
          "DYLD_FRAMEWORK_PATH",
          "DYLD_LIBRARY_PATH",
          "RUNNER_TRACKING_ID",
        ] as const) {
          expect(test.env[key]).toBe(f.env[key]);
        }
        expect(test.env.CFFIXED_USER_HOME).toBe(test.env.HOME);
        expect(test.keychain).toEqual({ locked: false, autoLock: false });
        const ownedKeychain = test.settings.default;
        expect(path.dirname(ownedKeychain)).toBe(path.join(test.env.HOME, "Library/Keychains"));
        expect(test.settings.search).toEqual([ownedKeychain]);
        const partition = f.calls().filter((call) => call.env?.HOME === test.env.HOME);
        expect(partition[0].args[0]).toBe("create-keychain");
        expect(partition.at(-2).tool).toBe("swift");
        expect(partition.at(-1).args).toEqual(["delete-keychain", ownedKeychain]);
        for (const call of partition.filter((entry) => entry.tool === "security")) {
          expect(call.env).toEqual(test.env);
          expect(call.args.at(-1)).toBe(ownedKeychain);
        }
        expect(test.cache).toBe("reusable build cache");
        const ownedRoot = path.dirname(test.env.HOME);
        roots.add(ownedRoot);
        expect(ownedRoot).not.toBe(f.root);
        for (const key of ["HOME", "TMPDIR", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
          expect(test.env[key].startsWith(`${ownedRoot}/`)).toBe(true);
          expect(test.present[key]).toBe(key !== "OPENCLAW_CONFIG_PATH");
        }
        expect(fs.existsSync(ownedRoot)).toBe(false);
      }
      expect(roots.size).toBe(tests.length);
      expect(fs.existsSync(f.env.HOME)).toBe(true);
      expect(
        fs.readFileSync(
          path.join(f.env.HOME, "Library/Caches/org.swift.swiftpm/fixture-cache"),
          "utf8",
        ),
      ).toBe("reusable build cache");
      expect(fs.readFileSync(f.env.GITHUB_OUTPUT, "utf8")).toContain("debug-tests-built=true");
    },
  );

  it("fails closed when logical CPU detection is invalid", () => {
    const f = fixture(0, false, 0, "", "not-a-count");
    const result = f.run(swiftStep);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid macOS logical CPU count: not-a-count");
    expect(f.calls().filter((call) => call.tool === "swift")).toHaveLength(1);
  });

  it("uses fresh named preferences for successive launches", () => {
    const f = fixture();
    for (let index = 0; index < 2; index++) {
      const result = f.run("node scripts/test-macos-native.mts named --skip-build");
      expect(result.status, result.stderr).toBe(0);
    }
    const calls = f.calls().filter((call) => call.tool === "swift");
    expect(calls).toHaveLength(2);
    expect(calls[0].env.OPENCLAW_PROFILE).not.toBe(calls[1].env.OPENCLAW_PROFILE);
    expect(calls[0].env.HOME).not.toBe(calls[1].env.HOME);
  });

  it.each([
    [{ GITHUB_ACTIONS: "" }, ["named", "--skip-build"], "macos-swift"],
    [{}, ["named"], "--skip-build"],
    [{}, ["other", "--skip-build"], "Select default or named"],
  ] as const)("rejects an invalid launch before starting Swift (%j)", (env, args, message) => {
    const f = fixture();
    const result = spawnSync(process.execPath, ["scripts/test-macos-native.mts", ...args], {
      cwd: repo,
      env: { ...f.env, ...env },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("[macos-native] FAILED (exit 1)");
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each(["security", "swift"] as const)(
    "keeps resources alive until interrupted %s has stopped",
    async (tool) => {
      const f = fixture(0, tool);
      const child = spawn(
        process.execPath,
        ["scripts/test-macos-native.mts", "named", "--skip-build"],
        {
          cwd: repo,
          env: f.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const completion = once(child, "close");
      try {
        const ready = new Promise<void>((resolve) => {
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("fake-child-ready")) {
              resolve();
            }
          });
        });
        await Promise.race([
          ready,
          completion.then(() => {
            throw new Error("launcher exited before fake child was ready");
          }),
        ]);
        const ownedRoot = path.dirname(f.calls()[0].env.HOME);
        expect(fs.existsSync(ownedRoot)).toBe(true);
        expect(fs.statSync(ownedRoot).mode & 0o777).toBe(0o700);
        child.kill("SIGTERM");
        const [code] = await completion;
        expect(code).toBe(143);
        expect(f.calls().at(-2)).toEqual({
          tool: "shutdown",
          resourcesPresent: true,
          keychainPresent: true,
        });
        expect(f.calls().at(-1).args[0]).toBe("delete-keychain");
        if (tool === "security") {
          expect(f.calls().some((call) => call.tool === "swift")).toBe(false);
        }
        expect(fs.existsSync(ownedRoot)).toBe(false);
      } finally {
        child.kill("SIGTERM");
        await completion;
      }
    },
  );

  it.each(["drained", "retained"])("holds the Keychain through %s child output", async (mode) => {
    const f = fixture();
    const release = path.join(f.root, "release-output");
    const leafPidPath = path.join(f.root, "leaf.pid");
    // The Swift stand-in exits, but its escaped child keeps both output pipes open.
    const leaf = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid));
process.on('disconnect', () => console.log('fake-output-held'));
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  const settings = JSON.parse(fs.readFileSync(process.env.HOME + '/Library/Preferences/fixture-keychain.json', 'utf8'));
  fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({tool: 'output-close', keychainPresent: fs.existsSync(settings.default)}) + '\\n');
}, 10);
process.send('ready');
`;
    fs.writeFileSync(
      path.join(f.root, "bin/swift"),
      `#!${process.execPath}
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
child.once('message', () => process.exit(0));
`,
    );
    const child = spawn(
      process.execPath,
      ["scripts/test-macos-native.mts", "named", "--skip-build"],
      {
        cwd: repo,
        env: f.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const completion = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const held = new Promise<void>((resolve) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("fake-output-held")) {
          resolve();
        }
      });
    });
    let ownedRoot: string | undefined;
    try {
      await Promise.race([
        held,
        completion.then(() => {
          throw new Error(stderr || "launcher exited before output fixture");
        }),
      ]);
      const calls = f.calls();
      ownedRoot = path.dirname(calls[0].env.HOME);
      const ownedKeychain = calls[0].args.at(-1);
      expect(fs.existsSync(ownedKeychain)).toBe(true);
      expect(calls.some((call) => call.args?.[0] === "delete-keychain")).toBe(false);
      if (mode === "drained") {
        fs.writeFileSync(release, "release");
      }
      const [code] = await completion;
      expect(code, stderr).toBe(mode === "drained" ? 0 : 1);
      if (mode === "drained") {
        expect(f.calls().at(-2)).toEqual({ tool: "output-close", keychainPresent: true });
        expect(f.calls().at(-1).args).toEqual(["delete-keychain", ownedKeychain]);
        expect(fs.existsSync(ownedRoot)).toBe(false);
      } else {
        expect(fs.existsSync(ownedKeychain)).toBe(true);
        expect(f.calls().some((call) => call.args?.[0] === "delete-keychain")).toBe(false);
        expect(stderr).toContain("EPROCESSGROUP_CLEANUP_FAILED");
        expect(stderr).toContain(ownedRoot);
      }
    } finally {
      fs.writeFileSync(release, "release");
      child.kill("SIGTERM");
      await completion;
      if (fs.existsSync(leafPidPath)) {
        const pid = Number(fs.readFileSync(leafPidPath, "utf8"));
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                return true;
              }
              throw error;
            }
          })
          .toBe(true);
      }
      if (ownedRoot) {
        fs.rmSync(ownedRoot, { recursive: true, force: true });
      }
    }
  });

  it.each([
    "create-keychain",
    "unlock-keychain",
    "set-keychain-settings",
    "list-keychains",
    "default-keychain",
  ])("cleans a completed %s failure without starting Swift", (command) => {
    const f = fixture(0, false, 0, command);
    const result = f.run("node scripts/test-macos-native.mts named --skip-build");
    expect(result.status, result.stderr).not.toBe(0);
    const calls = f.calls();
    expect(calls.every((call) => call.tool === "security")).toBe(true);
    expect(calls.at(-2).args[0]).toBe(command);
    expect(calls.at(-1).args[0]).toBe("delete-keychain");
    expect(fs.existsSync(path.dirname(calls[0].env.HOME))).toBe(false);
    expect(result.stderr).toContain("[macos-native] FAILED");
  });

  it("retains resources and reports Keychain cleanup failure", () => {
    const f = fixture(0, false, 0, "delete-keychain");
    const result = f.run("node scripts/test-macos-native.mts named --skip-build");
    expect(result.status, result.stderr).not.toBe(0);
    const calls = f.calls();
    const ownedRoot = path.dirname(calls[0].env.HOME);
    try {
      expect(calls.at(-2).tool).toBe("swift");
      expect(calls.at(-1).args[0]).toBe("delete-keychain");
      expect(fs.existsSync(calls.at(-1).args.at(-1))).toBe(true);
      expect(result.stderr).toContain(ownedRoot);
      expect(result.stderr).toContain("delete-keychain");
      expect(result.stderr).toContain("[macos-native] FAILED");
    } finally {
      fs.rmSync(ownedRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "requires the launcher except for frozen release targets (%s)",
    (historical) => {
      const f = fixture();
      const result = f.run(swiftStep, f.root, { HISTORICAL_TARGET: String(historical) });
      expect(result.status, result.stderr).toBe(historical ? 0 : 1);
      const calls = f.calls().filter((call) => call.tool === "swift");
      expect(calls.map((call) => call.args[0])).toEqual(historical ? ["build", "test"] : ["build"]);
      if (historical) {
        expect(calls[1].args).toEqual([
          "test",
          "--package-path",
          "apps/macos",
          "--build-system",
          "native",
          "--enable-code-coverage",
          "--skip-build",
          "--no-parallel",
        ]);
      }
      if (!historical) {
        expect(result.stderr).toContain("must provide scripts/test-macos-native.mts");
      }
    },
  );

  it("refuses native execution from prepush even with CI markers", () => {
    const f = fixture();
    // The real prepush has Node test commands; replace node only in this fixture.
    fs.unlinkSync(path.join(f.root, "bin/node"));
    fs.copyFileSync(path.join(f.root, "bin/pnpm"), path.join(f.root, "bin/node"));
    const result = f.run(`bash '${path.join(repo, "scripts/prepush-ci.sh")}'`, f.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("macos-swift");
    const calls = f.calls().filter((call) => call.tool === "swift");
    expect(calls.map((call) => call.args[0])).toEqual(["build"]);
  });
});
