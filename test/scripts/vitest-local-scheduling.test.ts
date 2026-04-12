import { describe, expect, it } from "vitest";
import {
  resolveLocalFullSuiteProfile,
  resolveLocalVitestScheduling,
  shouldUseLargeLocalFullSuiteProfile,
} from "../../scripts/lib/vitest-local-scheduling.mjs";

describe("vitest local full-suite profile", () => {
  it("selects the large local profile on roomy hosts that are not throttled", () => {
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
    expect(shouldUseLargeLocalFullSuiteProfile(env, hostInfo)).toBe(true);
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: 10,
      vitestMaxWorkers: 2,
    });
  });

  it("keeps the smaller local profile when the host is already throttled", () => {
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 14,
      totalMemoryBytes: 48 * 1024 ** 3,
    };

    expect(shouldUseLargeLocalFullSuiteProfile({}, hostInfo)).toBe(false);
    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 4,
      vitestMaxWorkers: 1,
    });
  });

  it("never selects the large local profile in CI", () => {
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 0,
      totalMemoryBytes: 48 * 1024 ** 3,
    };

    expect(shouldUseLargeLocalFullSuiteProfile({ CI: "true" }, hostInfo)).toBe(false);
    expect(resolveLocalFullSuiteProfile({ CI: "true" }, hostInfo)).toEqual({
      shardParallelism: 4,
      vitestMaxWorkers: 1,
    });
  });
});
