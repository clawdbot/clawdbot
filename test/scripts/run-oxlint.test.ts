import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOxlintShards,
  filterOxlintShards,
  parseShardRunnerArgs,
  createWindowsExtensionShards,
  resolveShardHeartbeatMs,
  resolveWindowsExtensionChunkSize,
  shouldRunOxlintShardsSerial,
} from "../../scripts/run-oxlint-shards.mjs";
import {
  filterSparseMissingOxlintTargets,
  shouldPrepareExtensionPackageBoundaryArtifacts,
} from "../../scripts/run-oxlint.mjs";

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
    expect(packageJson.scripts.lint).toBe("node scripts/run-oxlint-shards.mjs");
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

  it("lets dev update preflight run oxlint shards serially", () => {
    const shardedLintRunner = readFileSync("scripts/run-oxlint-shards.mjs", "utf8");

    expect(shardedLintRunner).toContain("OPENCLAW_OXLINT_SHARDS_SERIAL");
    expect(shardedLintRunner).toContain('platform === "win32"');
    expect(shardedLintRunner).toContain("runShardsSerial");
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

  it("uses a bounded oxlint shard heartbeat by default", () => {
    expect(resolveShardHeartbeatMs({})).toBe(30_000);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0" })).toBe(0);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "5000" })).toBe(5000);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "bad" })).toBe(30_000);
  });

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

  it("keeps the default Windows oxlint extension chunk size for invalid overrides", () => {
    expect(resolveWindowsExtensionChunkSize({})).toBe(8);
    expect(
      resolveWindowsExtensionChunkSize({ OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "0" }),
    ).toBe(8);
    expect(
      resolveWindowsExtensionChunkSize({ OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "abc" }),
    ).toBe(8);
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
