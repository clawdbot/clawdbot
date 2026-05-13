import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "../../scripts/lib/local-heavy-check-runtime.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const GIB = 1024 ** 3;
const CONSTRAINED_HOST = {
  totalMemoryBytes: 16 * GIB,
  logicalCpuCount: 8,
};
const ROOMY_HOST = {
  totalMemoryBytes: 128 * GIB,
  logicalCpuCount: 16,
};

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  const env = {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "OPENCLAW_LOCAL_CHECK_MODE")) {
    delete env.OPENCLAW_LOCAL_CHECK_MODE;
  }
  return env;
}

describe("local-heavy-check-runtime", () => {
  it("reenables local heavy-check policy for local wrapper entrypoints", () => {
    expect(resolveLocalHeavyCheckEnv({ OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
    expect(resolveLocalHeavyCheckEnv({ OPENCLAW_LOCAL_CHECK: "false", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves local-check disablement in CI", () => {
    expect(
      resolveLocalHeavyCheckEnv({
        CI: "true",
        OPENCLAW_LOCAL_CHECK: "0",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      CI: "true",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("tightens local tsgo runs on constrained hosts", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv(), CONSTRAINED_HOST);

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
      "--singleThreaded",
      "--checkers",
      "1",
    ]);
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("skips declaration transforms for no-emit tsgo checks", () => {
    const { args } = applyLocalTsgoPolicy([], makeEnv({ OPENCLAW_LOCAL_CHECK: "0" }), ROOMY_HOST);

    expect(args).toEqual(["--declaration", "false"]);
  });

  it("keeps explicit tsgo flags and Go env overrides intact when throttled", () => {
    const { args, env } = applyLocalTsgoPolicy(
      ["--checkers", "4", "--singleThreaded", "--pprofDir", "/tmp/existing"],
      makeEnv({
        GOGC: "80",
        GOMEMLIMIT: "5GiB",
        OPENCLAW_TSGO_PPROF_DIR: "/tmp/profile",
      }),
      CONSTRAINED_HOST,
    );

    expect(args).toEqual([
      "--checkers",
      "4",
      "--singleThreaded",
      "--pprofDir",
      "/tmp/existing",
      "--declaration",
      "false",
    ]);
    expect(env.GOGC).toBe("80");
    expect(env.GOMEMLIMIT).toBe("5GiB");
  });

  it("keeps explicit tsgo declaration flags intact", () => {
    const env = makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" });
    const longFlag = applyLocalTsgoPolicy(["--declaration"], env, ROOMY_HOST);
    const shortFlag = applyLocalTsgoPolicy(["-d"], env, ROOMY_HOST);

    expect(longFlag.args).toEqual(["--declaration"]);
    expect(shortFlag.args).toEqual(["-d"]);
  });

  it("defaults local tsgo to full-speed mode on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy([], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
    ]);
    expect(env.GOGC).toBeUndefined();
    expect(env.GOMEMLIMIT).toBeUndefined();
  });

  it("uses the configured local tsgo build info file", () => {
    const { args } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
        OPENCLAW_TSGO_BUILD_INFO_FILE: ".artifacts/custom/tsgo.tsbuildinfo",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/custom/tsgo.tsbuildinfo",
    ]);
  });

  it("avoids incremental cache reuse for ad hoc tsgo runs", () => {
    const { args } = applyLocalTsgoPolicy(
      ["--extendedDiagnostics"],
      makeEnv({ OPENCLAW_LOCAL_CHECK_MODE: "full" }),
      ROOMY_HOST,
    );

    expect(args).toEqual(["--extendedDiagnostics", "--declaration", "false"]);
  });

  it("allows forcing the throttled tsgo policy on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "throttled",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
      "--singleThreaded",
      "--checkers",
      "1",
    ]);
    expect(env.GOGC).toBe("30");
    expect(env.GOMEMLIMIT).toBe("3GiB");
  });

  it("allows forcing full-speed tsgo runs on roomy hosts", () => {
    const { args, env } = applyLocalTsgoPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--declaration",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/root.tsbuildinfo",
    ]);
    expect(env.GOGC).toBeUndefined();
    expect(env.GOMEMLIMIT).toBeUndefined();
  });

  it("skips the heavy-check lock for tsgo metadata commands", () => {
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["--help"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["-h"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["--version"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["-v"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["--init"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["--showConfig"])).toBe(false);
  });

  it("keeps the heavy-check lock for real tsgo runs", () => {
    expect(shouldAcquireLocalHeavyCheckLockForTsgo([])).toBe(true);
    expect(shouldAcquireLocalHeavyCheckLockForTsgo(["--extendedDiagnostics"])).toBe(true);
  });

  it("allows forcing the tsgo lock back on", () => {
    expect(
      shouldAcquireLocalHeavyCheckLockForTsgo(
        ["--help"],
        makeEnv({ OPENCLAW_TSGO_FORCE_LOCK: "1" }),
      ),
    ).toBe(true);
  });

  it("serializes local oxlint runs onto one thread on constrained hosts", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv(), CONSTRAINED_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--allow",
      "eslint/no-underscore-dangle",
      "--report-unused-disable-directives-severity",
      "error",
      "--threads=1",
    ]);
  });

  it("defaults local oxlint to one thread on roomy hosts", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--allow",
      "eslint/no-underscore-dangle",
      "--report-unused-disable-directives-severity",
      "error",
      "--threads=1",
    ]);
  });

  it("honors an explicit oxlint thread count", () => {
    const { args } = applyLocalOxlintPolicy(["--threads=8"], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--threads=8",
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--allow",
      "eslint/no-underscore-dangle",
      "--report-unused-disable-directives-severity",
      "error",
    ]);
  });

  it("allows forcing full-speed oxlint runs on roomy hosts", () => {
    const { args } = applyLocalOxlintPolicy(
      [],
      makeEnv({
        OPENCLAW_LOCAL_CHECK_MODE: "full",
      }),
      ROOMY_HOST,
    );

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "config/tsconfig/oxlint.json",
      "--allow",
      "eslint/no-underscore-dangle",
      "--report-unused-disable-directives-severity",
      "error",
    ]);
  });

  it("skips the heavy-check lock for explicit oxlint file targets", () => {
    const cwd = createTempDir("openclaw-oxlint-lock-skip-");
    const target = path.join(cwd, "sample.ts");
    fs.writeFileSync(target, "export const ok = true;\n", "utf8");

    expect(
      shouldAcquireLocalHeavyCheckLockForOxlint(["--type-aware", "--", "sample.ts"], { cwd }),
    ).toBe(false);
  });

  it("skips the heavy-check lock for oxlint metadata commands", () => {
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--help"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["-h"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--version"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["-V"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--rules"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--print-config"])).toBe(false);
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--init"])).toBe(false);
  });

  it("keeps the heavy-check lock for directory targets and broad oxlint runs", () => {
    const cwd = createTempDir("openclaw-oxlint-lock-keep-");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "sample.ts"), "export const ok = true;\n", "utf8");

    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--type-aware", "--", "src"], { cwd })).toBe(
      true,
    );
    expect(shouldAcquireLocalHeavyCheckLockForOxlint(["--type-aware"], { cwd })).toBe(true);
  });

  it("allows forcing the oxlint lock back on", () => {
    const cwd = createTempDir("openclaw-oxlint-lock-force-");
    fs.writeFileSync(path.join(cwd, "sample.ts"), "export const ok = true;\n", "utf8");

    expect(
      shouldAcquireLocalHeavyCheckLockForOxlint(["--type-aware", "--", "sample.ts"], {
        cwd,
        env: makeEnv({ OPENCLAW_OXLINT_FORCE_LOCK: "1" }),
      }),
    ).toBe(true);
  });

  it("reclaims stale local heavy-check locks from dead pids", () => {
    const cwd = createTempDir("openclaw-local-heavy-check-");
    const commonDir = path.join(cwd, ".git");
    const lockDir = path.join(commonDir, "openclaw-local-checks", "heavy-check.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        tool: "tsgo",
        cwd,
      })}\n`,
      "utf8",
    );

    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv(),
      toolName: "oxlint",
    });

    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.tool).toBe("oxlint");

    release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("uses a worktree-local heavy-check lock when explicitly requested", () => {
    const repoRoot = createTempDir("openclaw-local-heavy-check-worktree-");
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    const cwd = path.join(repoRoot, "nested", "tooling");
    fs.mkdirSync(cwd, { recursive: true });
    const commonLockDir = path.join(repoRoot, ".git", "openclaw-local-checks", "heavy-check.lock");
    const worktreeLockDir = path.join(
      repoRoot,
      ".artifacts",
      "openclaw-local-checks",
      "heavy-check.lock",
    );
    const nestedLockDir = path.join(cwd, ".artifacts", "openclaw-local-checks", "heavy-check.lock");

    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv({ OPENCLAW_HEAVY_CHECK_LOCK_SCOPE: "worktree" }),
      toolName: "check:changed",
    });

    const owner = JSON.parse(fs.readFileSync(path.join(worktreeLockDir, "owner.json"), "utf8"));
    expect(owner.tool).toBe("check:changed");
    expect(fs.existsSync(worktreeLockDir)).toBe(true);
    expect(fs.existsSync(commonLockDir)).toBe(false);
    expect(fs.existsSync(nestedLockDir)).toBe(false);

    release();
    expect(fs.existsSync(worktreeLockDir)).toBe(false);
  });

  it("cleans up stale legacy test locks when acquiring the shared heavy-check lock", () => {
    const cwd = createTempDir("openclaw-local-heavy-check-legacy-");
    const commonDir = path.join(cwd, ".git");
    const locksDir = path.join(commonDir, "openclaw-local-checks");
    const legacyLockDir = path.join(locksDir, "test.lock");
    const heavyCheckLockDir = path.join(locksDir, "heavy-check.lock");
    fs.mkdirSync(legacyLockDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyLockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        tool: "test",
        cwd,
      })}\n`,
      "utf8",
    );

    const release = acquireLocalHeavyCheckLockSync({
      cwd,
      env: makeEnv(),
      toolName: "oxlint",
    });

    expect(fs.existsSync(legacyLockDir)).toBe(false);
    expect(fs.existsSync(heavyCheckLockDir)).toBe(true);

    release();
    expect(fs.existsSync(heavyCheckLockDir)).toBe(false);
  });
});
