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

function fixture(defaultExitCode = 0, waitForSignal = false, namedExitCode = 0) {
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
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const resources = ['HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'];
const present = Object.fromEntries(resources.map(key => [key, !!env[key] && fs.existsSync(env[key])]));
const cachePath = path.join(env.HOME, 'Library/Caches/org.swift.swiftpm/fixture-cache');
const cache = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8') : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool, args, env, present, cache}) + '\\n');
if (tool === 'uname') console.log('Darwin');
if (tool === 'rg') console.log('apps/macos/Sources/Fixture.swift');
if (tool === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') console.log(${JSON.stringify(root)});
if (tool === 'git' && args[0] === 'diff' && args.includes('--name-only')) console.log('apps/macos/Sources/Fixture.swift');
if (tool === 'swift' && args[0] === 'test') {
  if (env.OPENCLAW_STATE_DIR !== ${JSON.stringify(path.join(root, "ambient-state"))}) {
    fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, 'child-owned'), 'fixture');
  }
  if (${waitForSignal}) {
    process.on('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: 'shutdown', resourcesPresent: fs.existsSync(env.HOME) && fs.existsSync(env.OPENCLAW_STATE_DIR)}) + '\\n');
      process.exit(0);
    });
    console.log('fake-swift-ready');
    setInterval(() => {}, 1000);
  } else process.exit(env.OPENCLAW_PROFILE === 'default' ? ${defaultExitCode} : ${namedExitCode});
}
`;
  for (const tool of ["swift", "pnpm", "node", "git", "uname", "rg"]) {
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
    GITHUB_OUTPUT: path.join(root, "outputs"),
    HISTORICAL_TARGET: "false",
    SWIFT_TEST_EXECUTION: "parallel",
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
    ["parallel", "--parallel", 0, 0],
    ["serial", "--no-parallel", 23, 0],
    ["parallel", "--parallel", 0, 17],
  ] as const)(
    "owns CI resources through %s (%s, exits %i/%i)",
    (mode, flag, defaultCode, namedCode) => {
      const f = fixture(defaultCode, false, namedCode);
      const result = f.run(swiftStep, repo, { SWIFT_TEST_EXECUTION: mode });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(defaultCode || namedCode);
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
          flag,
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
        for (const key of ["DEVELOPER_DIR", "DYLD_FRAMEWORK_PATH", "DYLD_LIBRARY_PATH"] as const) {
          expect(test.env[key]).toBe(f.env[key]);
        }
        expect(test.env.CFFIXED_USER_HOME).toBe(test.env.HOME);
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

  it("uses fresh named preferences for successive launches", () => {
    const f = fixture();
    for (let index = 0; index < 2; index++) {
      const result = f.run("node scripts/test-macos-native.mts named --skip-build");
      expect(result.status, result.stderr).toBe(0);
    }
    const calls = f.calls();
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

  it("keeps resources alive until an interrupted child has stopped", async () => {
    const f = fixture(0, true);
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
          if (output.includes("fake-swift-ready")) resolve();
        });
      });
      await Promise.race([
        ready,
        completion.then(() => {
          throw new Error("launcher exited before fake Swift was ready");
        }),
      ]);
      const ownedRoot = path.dirname(f.calls()[0].env.HOME);
      expect(fs.existsSync(ownedRoot)).toBe(true);
      expect(fs.statSync(ownedRoot).mode & 0o777).toBe(0o700);
      child.kill("SIGTERM");
      const [code] = await completion;
      expect(code).toBe(143);
      expect(f.calls().at(-1)).toEqual({ tool: "shutdown", resourcesPresent: true });
      expect(fs.existsSync(ownedRoot)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await completion;
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
      if (!historical)
        expect(result.stderr).toContain("must provide scripts/test-macos-native.mts");
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
