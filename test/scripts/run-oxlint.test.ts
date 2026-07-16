// Run Oxlint tests cover run oxlint script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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
  shouldRunOxlintShardsSerial,
} from "../../scripts/run-oxlint-shards.mjs";
import {
  filterSparseMissingOxlintTargets,
  shouldPrepareExtensionPackageBoundaryArtifacts,
} from "../../scripts/run-oxlint.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (predicate()) {
      return;
    }
    await new Promise((resolvePoll) => {
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

describe("run-oxlint", () => {
  it("prepares extension package boundary artifacts for normal lint runs", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts([])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["src/index.ts"])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--type-aware"])).toBe(true);
  });

  it("skips artifact preparation for metadata-only oxlint commands", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--help"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--version"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--print-config"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--rules"])).toBe(false);
  });

  it("does not run package-boundary artifact prep twice in pnpm check", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const shardedLintRunner = readFileSync("scripts/run-oxlint-shards.mjs", "utf8");

    expect(packageJson.scripts.check).toBe("node scripts/check.mjs");
    expect(packageJson.scripts.lint).toBe(
      "pnpm lint:ui:i18n && node scripts/run-oxlint-shards.mjs",
    );
    expect(packageJson.scripts["lint:core"]).toBe(
      "node scripts/run-oxlint-shards.mjs --only=core --split-core",
    );
    expect(packageJson.scripts.check).not.toContain(
      "node scripts/prepare-extension-package-boundary-artifacts.mjs",
    );
    expect(shardedLintRunner).toContain("prepare-extension-package-boundary-artifacts.mjs");
    expect(shardedLintRunner).toContain('OPENCLAW_OXLINT_SKIP_PREPARE: "1"');
  });

  it("holds one parent heavy-check lock for sharded lint runs", () => {
    const shardedLintRunner = readFileSync("scripts/run-oxlint-shards.mjs", "utf8");
    const skipLockIndex = shardedLintRunner.indexOf('env.OPENCLAW_OXLINT_SKIP_LOCK === "1"');
    const lockIndex = shardedLintRunner.indexOf("acquireLocalHeavyCheckLockSync({");
    const childSkipIndex = shardedLintRunner.indexOf('OPENCLAW_OXLINT_SKIP_LOCK: "1"');

    expect(shardedLintRunner).toContain("resolveLocalHeavyCheckEnv");
    expect(shardedLintRunner).toContain("shouldAcquireLocalHeavyCheckLockForOxlint");
    expect(skipLockIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(skipLockIndex);
    expect(childSkipIndex).toBeGreaterThan(lockIndex);
  });

  it("serializes broad oxlint shards on constrained local hosts", () => {
    expect(
      shouldRunOxlintShardsSerial({
        env: {},
        platform: "linux",
        hostResources: { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 },
      }),
    ).toBe(true);
  });

  it("serializes broad oxlint shards on constrained CI hosts", () => {
    const constrainedHost = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };

    expect(
      shouldRunOxlintShardsSerial({
        env: { CI: "true" },
        platform: "linux",
        hostResources: constrainedHost,
      }),
    ).toBe(true);
    expect(
      shouldRunOxlintShardsSerial({
        env: { CI: "true", OPENCLAW_LOCAL_CHECK_MODE: "throttled" },
        platform: "linux",
        hostResources: constrainedHost,
      }),
    ).toBe(true);
  });

  it("keeps oxlint shards parallel for roomy CI and explicit full-speed runs", () => {
    const constrainedHost = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };
    const roomyHost = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };

    expect(
      shouldRunOxlintShardsSerial({
        env: { CI: "true" },
        platform: "linux",
        hostResources: roomyHost,
      }),
    ).toBe(false);
    expect(
      shouldRunOxlintShardsSerial({
        env: { OPENCLAW_LOCAL_CHECK_MODE: "full" },
        platform: "linux",
        hostResources: constrainedHost,
      }),
    ).toBe(false);
  });

  it("honors explicit oxlint shard serial overrides", () => {
    const roomyHost = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };

    expect(
      shouldRunOxlintShardsSerial({
        env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "1", CI: "true" },
        platform: "linux",
        hostResources: roomyHost,
      }),
    ).toBe(true);
    expect(
      shouldRunOxlintShardsSerial({
        env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "0" },
        platform: "linux",
        hostResources: roomyHost,
      }),
    ).toBe(false);
  });

  it("bounds split-core shard parallelism on roomy CI hosts", () => {
    const roomyHost = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };

    expect(
      resolveOxlintShardConcurrency({
        env: { CI: "true" },
        platform: "linux",
        hostResources: roomyHost,
        splitCore: true,
      }),
    ).toBe(4);
  });

  it("keeps split-core shard runs serial on constrained hosts", () => {
    const constrainedHost = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };

    expect(
      resolveOxlintShardConcurrency({
        env: { CI: "true" },
        platform: "linux",
        hostResources: constrainedHost,
        splitCore: true,
      }),
    ).toBe(1);
  });

  it("does not let local throttled mode serialize remote changed gates", () => {
    const roomyHost = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };

    expect(
      resolveOxlintShardConcurrency({
        env: {
          OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
          OPENCLAW_LOCAL_CHECK_MODE: "throttled",
        },
        platform: "linux",
        hostResources: roomyHost,
        splitCore: true,
      }),
    ).toBe(4);
  });

  it("honors explicit oxlint shard concurrency overrides", () => {
    const roomyHost = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };

    expect(
      resolveOxlintShardConcurrency({
        env: { CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2" },
        platform: "linux",
        hostResources: roomyHost,
        splitCore: true,
      }),
    ).toBe(2);

    expect(() =>
      resolveOxlintShardConcurrency({
        env: { CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2x" },
        platform: "linux",
        hostResources: roomyHost,
        splitCore: true,
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
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-oxlint-shard-"));
    const runner = join(tempDir, "hang-runner.mjs");
    try {
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
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out shard process groups when the leader exits first",
    async () => {
      const tempDir = createTempDir("openclaw-oxlint-timeout-group-");
      const runner = join(tempDir, "timeout-runner.mjs");
      const childPidPath = join(tempDir, "child.pid");
      let childPid = 0;
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      try {
        writeFileSync(
          runner,
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            "writeFileSync(process.env.CHILD_PID_PATH, String(child.pid));",
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
          "utf8",
        );

        const command = runShard({
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
        });

        await waitFor(() => existsSync(childPidPath), 2_000);
        childPid = Number(readFileSync(childPidPath, "utf8"));
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(command).resolves.toBe(124);
        await waitFor(() => !isProcessAlive(childPid), 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "forwards parent termination to detached oxlint shard processes",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-oxlint-signal-"));
      const runner = join(tempDir, "signal-runner.mjs");
      const harness = join(tempDir, "signal-harness.mjs");
      const readyFile = join(tempDir, "ready");
      const signaledFile = join(tempDir, "signaled");
      try {
        writeFileSync(
          runner,
          [
            "import { writeFileSync } from 'node:fs';",
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.SIGNALED_FILE, 'SIGTERM');",
            "  process.exit(0);",
            "});",
            "writeFileSync(process.env.READY_FILE, String(process.pid));",
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          harness,
          [
            "import { existsSync } from 'node:fs';",
            `import { runShard } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/run-oxlint-shards.mjs")).href)};`,
            "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
            "const promise = runShard({",
            "  env: {",
            "    ...process.env,",
            "    OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0',",
            "    OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0',",
            "  },",
            "  extraArgs: [],",
            "  runner: process.env.RUNNER_FILE,",
            "  shard: { name: 'signal-test', args: [] },",
            "});",
            "for (let attempt = 0; attempt < 100 && !existsSync(process.env.READY_FILE); attempt += 1) {",
            "  await sleep(10);",
            "}",
            "if (!existsSync(process.env.READY_FILE)) {",
            "  process.exit(2);",
            "}",
            "process.kill(process.pid, 'SIGTERM');",
            "const status = await promise;",
            "if (!existsSync(process.env.SIGNALED_FILE)) {",
            "  process.exit(3);",
            "}",
            "process.exit(status === 143 ? 0 : 4);",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = spawnSync(process.execPath, [harness], {
          encoding: "utf8",
          env: {
            ...process.env,
            READY_FILE: readyFile,
            RUNNER_FILE: runner,
            SIGNALED_FILE: signaledFile,
          },
          timeout: 5_000,
        });

        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "force kills detached shard processes that ignore parent termination",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-oxlint-signal-"));
      const runner = join(tempDir, "signal-runner.mjs");
      const harness = join(tempDir, "signal-harness.mjs");
      const readyFile = join(tempDir, "ready");
      const ignoredFile = join(tempDir, "ignored");
      try {
        writeFileSync(
          runner,
          [
            "import { writeFileSync } from 'node:fs';",
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.IGNORED_FILE, 'SIGTERM');",
            "});",
            "writeFileSync(process.env.READY_FILE, String(process.pid));",
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          harness,
          [
            "import { existsSync } from 'node:fs';",
            `import { runShard } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/run-oxlint-shards.mjs")).href)};`,
            "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
            "const promise = runShard({",
            "  env: {",
            "    ...process.env,",
            "    OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0',",
            "    OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0',",
            "    OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: '250',",
            "  },",
            "  extraArgs: [],",
            "  runner: process.env.RUNNER_FILE,",
            "  shard: { name: 'signal-test', args: [] },",
            "});",
            "for (let attempt = 0; attempt < 100 && !existsSync(process.env.READY_FILE); attempt += 1) {",
            "  await sleep(10);",
            "}",
            "if (!existsSync(process.env.READY_FILE)) {",
            "  process.exit(2);",
            "}",
            "process.kill(process.pid, 'SIGTERM');",
            "const status = await promise;",
            "if (!existsSync(process.env.IGNORED_FILE)) {",
            "  process.exit(3);",
            "}",
            "process.exit(status === 143 ? 0 : 4);",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = spawnSync(process.execPath, [harness], {
          encoding: "utf8",
          env: {
            ...process.env,
            IGNORED_FILE: ignoredFile,
            READY_FILE: readyFile,
            RUNNER_FILE: runner,
          },
          timeout: 5_000,
        });

        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills parent-terminated shard process groups when the leader exits first",
    () => {
      const tempDir = createTempDir("openclaw-oxlint-parent-group-");
      const runner = join(tempDir, "signal-runner.mjs");
      const harness = join(tempDir, "signal-harness.mjs");
      const childPidPath = join(tempDir, "child.pid");
      const readyFile = join(tempDir, "ready");
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      try {
        writeFileSync(
          runner,
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            "writeFileSync(process.env.CHILD_PID_PATH, String(child.pid));",
            "writeFileSync(process.env.READY_FILE, String(process.pid));",
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          harness,
          [
            "import { existsSync, readFileSync } from 'node:fs';",
            `import { runShard } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/run-oxlint-shards.mjs")).href)};`,
            "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
            "const isAlive = (pid) => {",
            "  try { process.kill(pid, 0); return true; } catch { return false; }",
            "};",
            "const waitFor = async (predicate) => {",
            "  for (let attempt = 0; attempt < 500; attempt += 1) {",
            "    if (predicate()) return true;",
            "    await sleep(5);",
            "  }",
            "  return false;",
            "};",
            "const promise = runShard({",
            "  env: {",
            "    ...process.env,",
            "    OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0',",
            "    OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: '25',",
            "    OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0',",
            "  },",
            "  extraArgs: [],",
            "  runner: process.env.RUNNER_FILE,",
            "  shard: { name: 'signal-group-test', args: [] },",
            "});",
            "if (!(await waitFor(() => existsSync(process.env.CHILD_PID_PATH)))) {",
            "  process.exit(2);",
            "}",
            "const childPid = Number(readFileSync(process.env.CHILD_PID_PATH, 'utf8'));",
            "process.kill(process.pid, 'SIGTERM');",
            "const status = await promise;",
            "if (await waitFor(() => !isAlive(childPid))) {",
            "  process.exit(status === 143 ? 0 : 4);",
            "}",
            "process.kill(childPid, 'SIGKILL');",
            "process.exit(5);",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = spawnSync(process.execPath, [harness], {
          encoding: "utf8",
          env: {
            ...process.env,
            CHILD_PID_PATH: childPidPath,
            READY_FILE: readyFile,
            RUNNER_FILE: runner,
          },
          timeout: 5_000,
        });

        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
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
      {
        name: "core",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
      },
      {
        name: "extensions:root",
        args: [
          "--tsconfig",
          "config/tsconfig/oxlint.extensions.json",
          "extensions/root.live.test.ts",
        ],
      },
      {
        name: "extensions:01",
        args: [
          "--tsconfig",
          "config/tsconfig/oxlint.extensions.json",
          "extensions/alpha",
          "extensions/beta",
        ],
      },
      {
        name: "extensions:02",
        args: ["--tsconfig", "config/tsconfig/oxlint.extensions.json", "extensions/zeta"],
      },
      {
        name: "scripts",
        args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
      },
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
      {
        name: "core:src:alpha",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/alpha"],
      },
      {
        name: "core:src:root",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/omega.ts", "src/zeta.ts"],
      },
      {
        name: "core:ui",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "ui"],
      },
      {
        name: "core:packages",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "packages"],
      },
    ]);
  });

  it("parses shard runner flags without forwarding them to oxlint", () => {
    const parsed = parseShardRunnerArgs(["--only=core", "--split-core", "--max-warnings", "0"]);

    expect([...parsed.only]).toEqual(["core"]);
    expect(parsed.splitCore).toBe(true);
    expect(parsed.oxlintArgs).toEqual(["--max-warnings", "0"]);
  });

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

  it("falls back to the full extension shard when Windows extension dirs are unavailable", () => {
    const shards = createWindowsExtensionShards({
      cwd: "/repo",
      readDir: () => {
        throw new Error("missing extensions");
      },
    });

    expect(shards).toEqual([
      {
        name: "extensions",
        args: ["--tsconfig", "config/tsconfig/oxlint.extensions.json", "extensions"],
      },
    ]);
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
