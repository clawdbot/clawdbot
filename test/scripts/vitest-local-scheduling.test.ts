// Vitest Local Scheduling tests cover vitest local scheduling script behavior.
import { describe, expect, it } from "vitest";
import {
  resolveLocalVitestEnv,
  resolveLocalFullSuiteProfile,
  resolveLocalVitestScheduling,
} from "../../scripts/lib/vitest-local-scheduling.mjs";

describe("vitest local full-suite profile", () => {
  it("forces local Vitest runs back onto local-check policy", () => {
    expect(resolveLocalVitestEnv({ OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
    expect(resolveLocalVitestEnv({ OPENCLAW_LOCAL_CHECK: "false", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it.each([
    ["CI", "1"],
    ["CI", "true"],
    ["GITHUB_ACTIONS", "yes"],
    ["GITHUB_ACTIONS", "on"],
  ] as const)("keeps local-check disablement for %s=%s Vitest runs", (name, value) => {
    expect(
      resolveLocalVitestEnv({
        [name]: value,
        OPENCLAW_LOCAL_CHECK: "0",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      [name]: value,
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("spends the host worker budget once across full-suite shards", () => {
    const env = {};
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 0,
      totalMemoryBytes: 48 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling(env, hostInfo, "threads")).toEqual({
      maxWorkers: 6,
      fileParallelism: true,
      throttledBySystem: false,
    });
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: 6,
      vitestMaxWorkers: 1,
    });
  });

  it("reduces full-suite shard concurrency when the host is already throttled", () => {
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 14,
      totalMemoryBytes: 48 * 1024 ** 3,
      freeMemoryBytes: 32 * 1024 ** 3,
    };

    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 1,
      vitestMaxWorkers: 1,
    });
  });

  it("caps full-suite process fanout on the largest hosts", () => {
    const hostInfo = {
      cpuCount: 64,
      loadAverage1m: 0,
      totalMemoryBytes: 512 * 1024 ** 3,
    };

    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 10,
      vitestMaxWorkers: 1,
    });
  });

  it("serializes local full-suite shards under critical memory pressure", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 3 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling({}, hostInfo, "threads")).toEqual({
      maxWorkers: 1,
      fileParallelism: false,
      throttledBySystem: true,
    });
    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 1,
      vitestMaxWorkers: 1,
    });
  });

  it("limits local full-suite shards when memory is tight", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 6 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling({}, hostInfo, "threads")).toEqual({
      maxWorkers: 2,
      fileParallelism: true,
      throttledBySystem: true,
    });
    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 2,
      vitestMaxWorkers: 1,
    });
  });

  it("lets explicit system throttle opt-out ignore memory pressure", () => {
    const env = { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" };
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 3 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling(env, hostInfo, "threads")).toEqual({
      maxWorkers: 4,
      fileParallelism: true,
      throttledBySystem: false,
    });
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: 4,
      vitestMaxWorkers: 1,
    });
  });

  it("rejects malformed explicit worker limits", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 12 * 1024 ** 3,
    };

    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_VITEST_MAX_WORKERS: "8x" }, hostInfo, "threads"),
    ).toThrow("OPENCLAW_VITEST_MAX_WORKERS must be a positive integer; got: 8x");
    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_TEST_WORKERS: "1e0" }, hostInfo, "threads"),
    ).toThrow("OPENCLAW_TEST_WORKERS must be a positive integer; got: 1e0");
  });
});
