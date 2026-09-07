import { describe, expect, it } from "vitest";
import { validateNodeHostStatsPayload, validateNodeInvokeProgressParams } from "../index.js";

describe("node protocol schemas", () => {
  const minimalStats = { cpuCount: 1, memoryTotalBytes: 0, memoryFreeBytes: 0 };

  it.each([
    ["minimal", minimalStats],
    [
      "full",
      {
        cpuCount: 16,
        loadAverage: [1.5, 2, 0.75],
        memoryTotalBytes: 16_000_000_000,
        memoryFreeBytes: 4_000_000_000,
        diskTotalBytes: 1_000_000_000_000,
        diskAvailableBytes: 250_000_000_000,
      },
    ],
    [
      "upper bounds and equal capacities",
      {
        cpuCount: 4_096,
        loadAverage: [100_000, 0, 100_000],
        memoryTotalBytes: 100,
        memoryFreeBytes: 100,
        diskTotalBytes: 0,
        diskAvailableBytes: 0,
      },
    ],
  ])("accepts %s host stats", (_name, payload) => {
    expect(validateNodeHostStatsPayload(payload)).toBe(true);
  });

  it.each([
    ["extra fields", { extra: true }],
    ["node-provided timestamps", { updatedAtMs: 1_000 }],
    ["zero CPUs", { cpuCount: 0 }],
    ["too many CPUs", { cpuCount: 4_097 }],
    ["fractional CPUs", { cpuCount: 1.5 }],
    ["negative memory total", { memoryTotalBytes: -1 }],
    ["negative free memory", { memoryFreeBytes: -1 }],
    ["fractional memory bytes", { memoryTotalBytes: 1.5 }],
    ["free memory above total", { memoryFreeBytes: 1 }],
    ["disk total alone", { diskTotalBytes: 10 }],
    ["disk available alone", { diskAvailableBytes: 10 }],
    ["negative disk total", { diskTotalBytes: -1, diskAvailableBytes: 0 }],
    ["negative disk available", { diskTotalBytes: 10, diskAvailableBytes: -1 }],
    ["fractional disk bytes", { diskTotalBytes: 10, diskAvailableBytes: 1.5 }],
    ["available disk above total", { diskTotalBytes: 10, diskAvailableBytes: 11 }],
    ["two load averages", { loadAverage: [1, 2] }],
    ["four load averages", { loadAverage: [1, 2, 3, 4] }],
    ["negative load average", { loadAverage: [0, -1, 0] }],
    ["excessive load average", { loadAverage: [0, 0, 100_001] }],
    ["infinite load average", { loadAverage: [Infinity, 0, 0] }],
    ["NaN load average", { loadAverage: [0, Number.NaN, 0] }],
  ])("rejects host stats with %s", (_name, overrides) => {
    expect(validateNodeHostStatsPayload({ ...minimalStats, ...overrides })).toBe(false);
  });

  it("accepts bounded progress chunks and rejects extra fields", () => {
    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
      }),
    ).toBe(true);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "x".repeat(16 * 1024 + 1),
      }),
    ).toBe(false);

    expect(
      validateNodeInvokeProgressParams({
        invokeId: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        chunk: "stdout line",
        extra: "not allowed",
      }),
    ).toBe(false);
  });
});
