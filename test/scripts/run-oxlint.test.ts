// Run Oxlint tests cover run oxlint script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runWithFailedTrailer } from "../../scripts/lib/failed-trailer.mts";
import {
  createOxlintShards,
  filterOxlintShards,
  parseShardRunnerArgs,
  createWindowsExtensionShards,
  resolveShardKillGraceMs,
  resolveShardHeartbeatMs,
  resolveShardTimeoutMs,
  resolveOxlintShardConcurrency,
  resolveWindowsExtensionChunkSize,
  runShard,
  selectCoreOxlintStripe,
  shouldPrepareExtensionPackageBoundaryArtifactsForShards,
  shouldRunOxlintShardsSerial,
} from "../../scripts/run-oxlint-shards.mts";
import {
  filterSparseMissingOxlintTargets,
  shouldPrepareExtensionPackageBoundaryArtifacts,
} from "../../scripts/run-oxlint.mts";
import { waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const CONSTRAINED_HOST = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };
const ROOMY_HOST = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };
const RUN_OXLINT_SHARDS_URL = pathToFileURL(
  join(process.cwd(), "scripts/run-oxlint-shards.mts"),
).href;
type SignalScenario = "forward" | "group" | "ignore";

async function captureFailedTrailer(
  run: () => Promise<void> | void,
): Promise<{ exitCode: number | undefined; lines: unknown[] }> {
  const priorExitCode = process.exitCode;
  const lines: unknown[] = [];
  try {
    process.exitCode = 0;
    await runWithFailedTrailer("oxlint", run, (line: unknown) => lines.push(line));
    return { exitCode: process.exitCode, lines };
  } finally {
    process.exitCode = priorExitCode;
  }
}

function shouldSerializeShards(env: NodeJS.ProcessEnv, hostResources = CONSTRAINED_HOST): boolean {
  return shouldRunOxlintShardsSerial({ env, platform: "linux", hostResources });
}

function resolveSplitCoreConcurrency(env: NodeJS.ProcessEnv, hostResources = ROOMY_HOST): number {
  return resolveOxlintShardConcurrency({ env, platform: "linux", hostResources, splitCore: true });
}

function writeModule(target: string, lines: string[]): void {
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

function createSignalRunner(mode: SignalScenario, target: string): void {
  if (mode === "group") {
    const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    writeModule(target, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "writeFileSync(process.env.CHILD_PID_PATH, String(child.pid)); writeFileSync(process.env.READY_FILE, String(process.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ]);
    return;
  }

  const markerEnv = mode === "forward" ? "SIGNALED_FILE" : "IGNORED_FILE";
  writeModule(target, [
    "import { writeFileSync } from 'node:fs';",
    "process.on('SIGTERM', () => {",
    `  writeFileSync(process.env.${markerEnv}, 'SIGTERM');`,
    ...(mode === "forward" ? ["  process.exit(0);"] : []),
    "});",
    "writeFileSync(process.env.READY_FILE, String(process.pid));",
    "setInterval(() => {}, 1000);",
  ]);
}

function runParentTerminationScenario(mode: SignalScenario) {
  const groupScenario = mode === "group";
  const tempDir = createTempDir(
    groupScenario ? "openclaw-oxlint-parent-group-" : "openclaw-oxlint-signal-",
  );
  const runner = join(tempDir, "signal-runner.mjs");
  const harness = join(tempDir, "signal-harness.mjs");
  const readyFile = join(tempDir, "ready");
  const markerFile = groupScenario
    ? undefined
    : join(tempDir, mode === "forward" ? "signaled" : "ignored");
  const childPidPath = groupScenario ? join(tempDir, "child.pid") : undefined;
  createSignalRunner(mode, runner);

  // Execute cancellation in a subprocess because runShard installs process-level signal handlers.
  writeModule(harness, [
    "import { existsSync, readFileSync } from 'node:fs';",
    `import { runShard } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)};`,
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const groupScenario = process.env.SCENARIO === 'group';",
    "const waitFor = async (predicate) => { const attempts = groupScenario ? 500 : 100; const delay = groupScenario ? 5 : 10; for (let attempt = 0; attempt < attempts; attempt += 1) { if (predicate()) return true; await sleep(delay); } return false; };",
    "const shardEnv = { ...process.env, OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0', OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0' };",
    "if (process.env.SCENARIO === 'ignore') shardEnv.OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS = '250';",
    "if (groupScenario) shardEnv.OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS = '25';",
    "const promise = runShard({ env: shardEnv, extraArgs: [], runner: process.env.RUNNER_FILE, shard: { name: groupScenario ? 'signal-group-test' : 'signal-test', args: [] } });",
    "const waitPath = groupScenario ? process.env.CHILD_PID_PATH : process.env.READY_FILE;",
    "if (!(await waitFor(() => existsSync(waitPath)))) process.exit(2);",
    "const childPid = groupScenario ? Number(readFileSync(process.env.CHILD_PID_PATH, 'utf8')) : 0;",
    "process.kill(process.pid, 'SIGTERM'); const status = await promise;",
    "if (process.env.MARKER_FILE && !existsSync(process.env.MARKER_FILE)) process.exit(3);",
    "if (groupScenario && !(await waitFor(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }))) { process.kill(childPid, 'SIGKILL'); process.exit(5); }",
    "process.exit(status === 143 ? 0 : 4);",
  ]);

  const markerEnv = mode === "forward" ? "SIGNALED_FILE" : "IGNORED_FILE";
  const scenarioEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CHILD_PID_PATH: childPidPath,
    MARKER_FILE: markerFile,
    READY_FILE: readyFile,
    RUNNER_FILE: runner,
    SCENARIO: mode,
    ...(markerFile ? { [markerEnv]: markerFile } : {}),
  };
  return spawnSync(process.execPath, [harness], {
    encoding: "utf8",
    env: scenarioEnv,
    timeout: 5_000,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolvePoll) => {
      setTimeout(resolvePoll, 5);
    });
  }
  throw new Error("condition was not met before timeout");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function oxlintShard(name: string, config: string, ...targets: string[]) {
  return { name, args: ["--tsconfig", `config/tsconfig/oxlint.${config}.json`, ...targets] };
}

describe("run-oxlint", () => {
  it("ends a failing run with a stable final status line", async () => {
    const { lines } = await captureFailedTrailer(() => {
      process.exitCode = 2;
    });

    expect(lines).toEqual(["[oxlint] FAILED (exit 2)"]);
  });

  it("converts a wrapper crash into a nonzero exit with the status line last", async () => {
    // The original incident: a crashed wrapper printed only a stack trace, and
    // truncated output read as success. The marker must be the final line.
    const { exitCode, lines } = await captureFailedTrailer(() => {
      throw new Error("artifact prep failed");
    });

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBeInstanceOf(Error);
    expect(lines[1]).toBe("[oxlint] FAILED (exit 1)");
  });

  it("stays silent on a clean run", async () => {
    const { lines } = await captureFailedTrailer(async () => {});

    expect(lines).toEqual([]);
  });

  it("prepares extension package boundary artifacts for normal lint runs", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts([])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["src/index.ts"])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--type-aware"])).toBe(true);
    expect(
      shouldPrepareExtensionPackageBoundaryArtifacts([
        "--tsconfig",
        "config/tsconfig/oxlint.extensions.json",
        "extensions/telegram/src/index.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareExtensionPackageBoundaryArtifacts([
        "--tsconfig=config/tsconfig/oxlint.core.json",
        "--tsconfig=config/tsconfig/oxlint.extensions.json",
      ]),
    ).toBe(true);
  });

  it.each([
    ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/index.ts"],
    ["--tsconfig=config/tsconfig/oxlint.core.json", "src/index.ts"],
    ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts/check-changed.mts"],
  ])("skips extension artifacts for an exact source-backed config: %s", (...args) => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(args)).toBe(false);
  });

  it("skips artifact preparation for metadata-only oxlint commands", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--help"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--version"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--print-config"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--rules"])).toBe(false);
  });

  it("prepares shard artifacts only when a selected config consumes them", () => {
    const core = oxlintShard("core", "core", "src");
    const scripts = oxlintShard("scripts", "scripts", "scripts");
    const extensions = oxlintShard("extensions", "extensions", "extensions");

    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards([core, scripts])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards([core, extensions])).toBe(true);
  });

  it("does not run package-boundary artifact prep twice in pnpm check", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const shardedLintRunner = readFileSync("scripts/run-oxlint-shards.mts", "utf8");

    expect(packageJson.scripts.check).toBe("node --import ./scripts/tsx.mjs scripts/check.mts");
    expect(packageJson.scripts.lint).toBe("node --import ./scripts/tsx.mjs scripts/run-lint.mts");
    expect(packageJson.scripts["lint:core"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/run-oxlint-shards.mts --only=core",
    );
    expect(packageJson.scripts.check).not.toContain(
      "node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts",
    );
    expect(shardedLintRunner).toContain("prepare-extension-package-boundary-artifacts.mts");
    expect(shardedLintRunner).toContain('OPENCLAW_OXLINT_SKIP_PREPARE: "1"');
  });

  it("prepares the worktree toolchain before the complete lint pre-step", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const lintRunner = readFileSync("scripts/run-lint.mts", "utf8");

    expect(packageJson.scripts.lint).toBe("node --import ./scripts/tsx.mjs scripts/run-lint.mts");
    expect(lintRunner.indexOf("ensureRepoToolNodeModulesLink(")).toBeGreaterThan(-1);
    expect(
      lintRunner.indexOf('path.resolve("scripts", "control-ui-i18n-verify.ts")'),
    ).toBeGreaterThan(lintRunner.indexOf("ensureRepoToolNodeModulesLink("));
    expect(lintRunner.indexOf('path.resolve("scripts", "run-oxlint-shards.mts")')).toBeGreaterThan(
      lintRunner.indexOf('path.resolve("scripts", "control-ui-i18n-verify.ts")'),
    );
  });

  it("serializes broad oxlint shards on constrained local hosts", () => {
    expect(shouldSerializeShards({})).toBe(true);
  });

  it("serializes broad oxlint shards on constrained CI hosts", () => {
    expect(shouldSerializeShards({ CI: "true" })).toBe(true);
    expect(shouldSerializeShards({ CI: "true", OPENCLAW_LOCAL_CHECK_MODE: "throttled" })).toBe(
      true,
    );
  });

  it("keeps oxlint shards parallel on dedicated CI runner classes", () => {
    // Blacksmith's 16 vCPU class carries 32GB; the local-Mac 48GB threshold
    // must not force CI serial (measured: serial shards cost 89s vs ~47s).
    expect(
      shouldSerializeShards(
        { CI: "true" },
        { totalMemoryBytes: 32 * 1024 ** 3, logicalCpuCount: 16 },
      ),
    ).toBe(false);
    expect(
      shouldSerializeShards(
        { CI: "true" },
        { totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 },
      ),
    ).toBe(true);
  });

  it("keeps oxlint shards parallel for roomy CI and explicit full-speed runs", () => {
    expect(shouldSerializeShards({ CI: "true" }, ROOMY_HOST)).toBe(false);
    expect(shouldSerializeShards({ OPENCLAW_LOCAL_CHECK_MODE: "full" })).toBe(false);
  });

  it("honors explicit oxlint shard serial overrides", () => {
    expect(
      shouldSerializeShards({ OPENCLAW_OXLINT_SHARDS_SERIAL: "1", CI: "true" }, ROOMY_HOST),
    ).toBe(true);
    expect(shouldSerializeShards({ OPENCLAW_OXLINT_SHARDS_SERIAL: "0" }, ROOMY_HOST)).toBe(false);
  });

  it("bounds split-core shard parallelism on roomy CI hosts", () => {
    expect(resolveSplitCoreConcurrency({ CI: "true" })).toBe(4);
  });

  it("keeps split-core shard runs serial on constrained hosts", () => {
    expect(resolveSplitCoreConcurrency({ CI: "true" }, CONSTRAINED_HOST)).toBe(1);
  });

  it("does not let local throttled mode serialize remote changed gates", () => {
    expect(
      resolveSplitCoreConcurrency({
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
        OPENCLAW_LOCAL_CHECK_MODE: "throttled",
      }),
    ).toBe(4);
  });

  it("honors explicit oxlint shard concurrency overrides", () => {
    expect(
      resolveSplitCoreConcurrency({ CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2" }),
    ).toBe(2);

    expect(() =>
      resolveSplitCoreConcurrency({
        CI: "true",
        OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2x",
      }),
    ).toThrow("OPENCLAW_OXLINT_SHARD_CONCURRENCY must be a positive integer; got: 2x");
  });

  it("uses a bounded oxlint shard heartbeat by default", () => {
    expect(resolveShardHeartbeatMs({})).toBe(30_000);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0" })).toBe(0);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "5000" })).toBe(5000);
    expect(() => resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "5000ms" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS must be a non-negative integer; got: 5000ms",
    );
  });

  it("uses a bounded oxlint shard timeout by default", () => {
    expect(resolveShardTimeoutMs({})).toBe(900_000);
    expect(resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "0" })).toBe(0);
    expect(resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(() => resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "1e3" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_TIMEOUT_MS must be a non-negative integer; got: 1e3",
    );
    expect(resolveShardKillGraceMs({})).toBe(5_000);
    expect(resolveShardKillGraceMs({ OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "0" })).toBe(0);
    expect(() => resolveShardKillGraceMs({ OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "-1" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS must be a non-negative integer; got: -1",
    );
  });

  it("fails a stuck oxlint shard instead of waiting forever", async () => {
    const tempDir = createTempDir("openclaw-oxlint-shard-");
    const runner = join(tempDir, "hang-runner.mjs");
    writeFileSync(runner, "setInterval(() => {}, 1000);\n", "utf8");

    const status = await runShard({
      env: {
        ...process.env,
        OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
        OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "25",
        OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
      },
      extraArgs: [],
      runner,
      shard: { name: "timeout-test", args: [] },
    });

    expect(status).toBe(124);
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out shard process groups when the leader exits first",
    async () => {
      const tempDir = createTempDir("openclaw-oxlint-timeout-group-");
      const runner = join(tempDir, "timeout-runner.mjs");
      const childPidPath = join(tempDir, "child.pid");
      let childPid = 0;
      let releaseTimeout = () => {};
      let command: Promise<number> | undefined;
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        "fs.writeFileSync(process.env.CHILD_PID_PATH + '.tmp', String(process.pid));",
        "fs.renameSync(process.env.CHILD_PID_PATH + '.tmp', process.env.CHILD_PID_PATH);",
      ].join("\n");
      try {
        writeModule(runner, [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ]);

        // The watchdog must test teardown, not win a race against child startup.
        const run = startProcessWatchdogFixture(() =>
          runShard({
            env: {
              ...process.env,
              CHILD_PID_PATH: childPidPath,
              OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
              OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
              OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "250",
            },
            extraArgs: [],
            runner,
            shard: { name: "timeout-group-test", args: [] },
          }),
        );
        command = run.runPromise;
        releaseTimeout = run.releaseTimeout;

        childPid = await waitForPidFile(childPidPath, 15_000);
        expect(isProcessAlive(childPid)).toBe(true);
        releaseTimeout();

        await expect(command).resolves.toBe(124);
        await waitFor(() => !isProcessAlive(childPid), 15_000);
      } finally {
        releaseTimeout();
        await command;
        if (!childPid && existsSync(childPidPath))
          childPid = Number(readFileSync(childPidPath, "utf8"));
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
          await waitForDead(childPid, 2_000);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "forwards parent termination to detached oxlint shard processes",
    () => {
      const result = runParentTerminationScenario("forward");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "force kills detached shard processes that ignore parent termination",
    () => {
      const result = runParentTerminationScenario("ignore");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills parent-terminated shard process groups when the leader exits first",
    () => {
      const result = runParentTerminationScenario("group");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it("chunks extension oxlint shards on Windows", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      env: {
        OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "2",
      },
      platform: "win32",
      readDir: () =>
        [
          { name: "zeta", isDirectory: () => true, isFile: () => false },
          { name: "ignored.txt", isDirectory: () => false, isFile: () => true },
          { name: "root.live.test.ts", isDirectory: () => false, isFile: () => true },
          { name: "notes.md", isDirectory: () => false, isFile: () => true },
          { name: "alpha", isDirectory: () => true, isFile: () => false },
          { name: "beta", isDirectory: () => true, isFile: () => false },
        ] as never,
    });

    expect(shards).toEqual([
      oxlintShard("core", "core", "src", "ui", "packages"),
      oxlintShard("extensions:root", "extensions", "extensions/root.live.test.ts"),
      oxlintShard("extensions:01", "extensions", "extensions/alpha", "extensions/beta"),
      oxlintShard("extensions:02", "extensions", "extensions/zeta"),
      oxlintShard("scripts", "scripts", "scripts"),
    ]);
  });

  it("splits core oxlint shards when requested", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: (target: string) => {
        if (target.endsWith("/src")) {
          return [
            { name: "zeta.ts", isDirectory: () => false, isFile: () => true },
            { name: "omega.ts", isDirectory: () => false, isFile: () => true },
            { name: "notes.md", isDirectory: () => false, isFile: () => true },
            { name: "alpha", isDirectory: () => true, isFile: () => false },
          ] as never;
        }
        return [];
      },
    });

    expect(shards.slice(0, 4)).toEqual([
      oxlintShard("core:src:alpha", "core", "src/alpha"),
      oxlintShard("core:src:root", "core", "src/omega.ts", "src/zeta.ts"),
      oxlintShard("core:ui", "core", "ui"),
      oxlintShard("core:packages", "core", "packages"),
    ]);
  });

  it("parses shard runner flags without forwarding them to oxlint", () => {
    const parsed = parseShardRunnerArgs([
      "--only=core",
      "--split-core",
      "--core-stripe=2/3",
      "--max-warnings",
      "0",
    ]);

    expect([...parsed.only]).toEqual(["core"]);
    expect(parsed.coreStripe).toEqual({ index: 2, total: 3 });
    expect(parsed.splitCore).toBe(true);
    expect(parsed.oxlintArgs).toEqual(["--max-warnings", "0"]);
  });

  it("aggregates split core targets into deterministic disjoint Programs", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: () =>
        [
          { name: "alpha", isDirectory: () => true, isFile: () => false },
          { name: "beta", isDirectory: () => true, isFile: () => false },
          { name: "gamma", isDirectory: () => true, isFile: () => false },
        ] as never,
    }).filter((shard) => shard.name.startsWith("core:"));
    const stripes = [1, 2, 3].map((index) => selectCoreOxlintStripe(shards, { index, total: 3 }));

    expect(stripes.map((stripe) => stripe.map((shard) => shard.name))).toEqual([
      ["core:stripe:1"],
      ["core:stripe:2"],
      ["core:stripe:3"],
    ]);
    const stripeTargets = stripes.flatMap(([stripe]) => stripe?.args.slice(2) ?? []);
    const sourceTargets = shards.flatMap((shard) => shard.args.slice(2));
    expect(stripeTargets.toSorted()).toEqual(sourceTargets.toSorted());
    expect(new Set(stripeTargets)).toHaveProperty("size", sourceTargets.length);
    expect(selectCoreOxlintStripe(shards, { index: 6, total: 6 })).toEqual([]);
    expect(() =>
      selectCoreOxlintStripe(createOxlintShards({ cwd: "/repo" }), { index: 1, total: 2 }),
    ).toThrow("--core-stripe requires a non-empty core-only shard selection");
  });

  it.each([
    ["--core-stripe=0/3"],
    ["--core-stripe=4/3"],
    ["--core-stripe=1/0"],
    ["--core-stripe=wat"],
    ["--core-stripe", "1/3"],
  ])("rejects invalid core stripe arguments: %s", (...args) => {
    expect(() => parseShardRunnerArgs(args)).toThrow(/--core-stripe/u);
  });

  it.each([["--only"], ["--only", "--split-core"], ["--only="], ["--only=-h"]])(
    "rejects shard selectors without a name: %s",
    (...args) => {
      expect(() => parseShardRunnerArgs(args)).toThrow("--only requires a shard name");
    },
  );

  it("filters split core shards by shard family", () => {
    const shards = filterOxlintShards(
      createOxlintShards({
        cwd: "/repo",
        splitCore: true,
        readDir: () => [{ name: "alpha", isDirectory: () => true, isFile: () => false }] as never,
      }),
      new Set(["core"]),
    );

    expect(shards.map((shard) => shard.name)).toEqual([
      "core:src:alpha",
      "core:ui",
      "core:packages",
    ]);
  });

  it.each([
    { selectors: ["wat"], message: "Unknown oxlint shard selector: wat" },
    {
      selectors: ["core", "wat"],
      message: "Unknown oxlint shard selector: wat",
    },
  ])("rejects unmatched shard selectors: $selectors", ({ selectors, message }) => {
    expect(() =>
      filterOxlintShards(createOxlintShards({ cwd: "/repo" }), new Set(selectors)),
    ).toThrow(message);
  });

  it.each([
    ["--only"],
    ["--only", "--split-core"],
    ["--only="],
    ["--only=-h"],
    ["--only=wat"],
    ["--only=core", "--only=wat"],
  ])("rejects invalid shard CLI input before starting work: %s", (...args) => {
    const tempDir = createTempDir("openclaw-oxlint-selector-");
    const result = spawnSync(process.execPath, [RUN_OXLINT_SHARDS_URL, ...args], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_LOCAL_CHECK: "1",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("[oxlint:");
  });

  it("falls back to the full extension shard when Windows extension dirs are unavailable", () => {
    const shards = createWindowsExtensionShards({
      cwd: "/repo",
      readDir: () => {
        throw new Error("missing extensions");
      },
    });

    expect(shards).toEqual([oxlintShard("extensions", "extensions", "extensions")]);
  });

  it("rejects invalid Windows oxlint extension chunk size overrides", () => {
    expect(resolveWindowsExtensionChunkSize({})).toBe(8);
    expect(() =>
      resolveWindowsExtensionChunkSize({ OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "0" }),
    ).toThrow("OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE must be a positive integer; got: 0");
    expect(() =>
      resolveWindowsExtensionChunkSize({
        OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "8 chunks",
      }),
    ).toThrow(
      "OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE must be a positive integer; got: 8 chunks",
    );
  });

  it("filters tracked targets missing from sparse checkouts", () => {
    const result = filterSparseMissingOxlintTargets(
      ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages", "--threads=1"],
      {
        fileExists: (target: string) => target.endsWith("/src"),
        isSparseCheckoutEnabled: () => true,
        isTrackedPath: ({ target }: { target: string }) => target === "ui" || target === "packages",
      },
    );

    expect(result).toEqual({
      args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "--threads=1"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 1,
      skippedTargets: ["ui", "packages"],
      skippedConfigs: [],
    });
  });

  it("filters tracked tsconfig files missing from sparse checkouts", () => {
    const result = filterSparseMissingOxlintTargets(
      ["--tsconfig", "config/tsconfig/oxlint.core.json", "src"],
      {
        fileExists: (target: string) => target.endsWith("/src"),
        isSparseCheckoutEnabled: () => true,
        isTrackedPath: ({ target }: { target: string }) =>
          target === "config/tsconfig/oxlint.core.json",
      },
    );

    expect(result).toEqual({
      args: ["src"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 1,
      skippedTargets: [],
      skippedConfigs: ["config/tsconfig/oxlint.core.json"],
    });
  });

  it("keeps missing untracked oxlint targets so typos still fail", () => {
    const result = filterSparseMissingOxlintTargets(["src", "typo"], {
      fileExists: (target: string) => target.endsWith("/src"),
      isSparseCheckoutEnabled: () => true,
      isTrackedPath: () => false,
    });

    expect(result).toEqual({
      args: ["src", "typo"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 2,
      skippedTargets: [],
      skippedConfigs: [],
    });
  });
});
