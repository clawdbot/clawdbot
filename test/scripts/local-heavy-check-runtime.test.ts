import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  applyLocalTsgoPolicy,
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
  return {
    ...process.env,
    OPENCLAW_LOCAL_CHECK: "1",
    ...overrides,
  };
}

describe("local-heavy-check-runtime", () => {
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
    const longFlag = applyLocalTsgoPolicy(["--declaration"], makeEnv(), ROOMY_HOST);
    const shortFlag = applyLocalTsgoPolicy(["-d"], makeEnv(), ROOMY_HOST);

    expect(longFlag.args).toEqual(["--declaration"]);
    expect(shortFlag.args).toEqual(["-d"]);
  });

  it("keeps local tsgo at full speed on roomy hosts in auto mode", () => {
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
    const { args } = applyLocalTsgoPolicy(["--extendedDiagnostics"], makeEnv(), ROOMY_HOST);

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

  it("serializes local oxlint runs onto one thread on constrained hosts", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv(), CONSTRAINED_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "tsconfig.oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
      "--threads=1",
    ]);
  });

  it("keeps local oxlint parallel on roomy hosts in auto mode", () => {
    const { args } = applyLocalOxlintPolicy([], makeEnv(), ROOMY_HOST);

    expect(args).toEqual([
      "--type-aware",
      "--tsconfig",
      "tsconfig.oxlint.json",
      "--report-unused-disable-directives-severity",
      "error",
    ]);
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
