import type { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  classifyGatewayEventLoopHealthReasons,
  createGatewayEventLoopHealthMonitor,
} from "./event-loop-health.js";

type CpuUsage = ReturnType<typeof process.cpuUsage>;
type DelayMonitor = ReturnType<typeof monitorEventLoopDelay>;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type GatewayEventLoopHealthMonitorDeps = NonNullable<
  Parameters<typeof createGatewayEventLoopHealthMonitor>[0]
>;

function createMonitorHarness(params?: { cpuMsPerWallMs?: number; utilization?: number }) {
  const startedAt = 10_000;
  let nowMs = startedAt;
  let delayP99Ms = 0;
  let delayMaxMs = 0;
  const cpuMsPerWallMs = params?.cpuMsPerWallMs ?? 1;
  const utilization = params?.utilization ?? 1;
  const delayMonitor = {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(() => {
      delayP99Ms = 0;
      delayMaxMs = 0;
    }),
    percentile: vi.fn(() => delayP99Ms * 1_000_000),
    get max() {
      return delayMaxMs * 1_000_000;
    },
  } as unknown as DelayMonitor;
  const cpuUsage = vi.fn((previous?: CpuUsage) => {
    const current = {
      user: Math.round(nowMs * cpuMsPerWallMs * 1_000),
      system: 0,
    };
    if (!previous) {
      return current;
    }
    return {
      user: current.user - previous.user,
      system: current.system - previous.system,
    };
  }) as NonNullable<GatewayEventLoopHealthMonitorDeps["cpuUsage"]>;
  const eventLoopUtilization = vi.fn(
    (current?: EventLoopUtilization, previous?: EventLoopUtilization) => {
      if (!current || !previous) {
        return { idle: 0, active: nowMs, utilization };
      }
      return {
        idle: 0,
        active: current.active - previous.active,
        utilization,
      };
    },
  ) as NonNullable<GatewayEventLoopHealthMonitorDeps["eventLoopUtilization"]>;
  const monitor = createGatewayEventLoopHealthMonitor({
    now: () => nowMs,
    cpuUsage,
    eventLoopUtilization,
    createDelayMonitor: () => delayMonitor,
  });

  return {
    monitor,
    delayMonitor,
    cpuUsage,
    eventLoopUtilization,
    setNow: (value: number) => {
      nowMs = startedAt + value;
    },
    setDelay: (value: { p99Ms?: number; maxMs?: number }) => {
      delayP99Ms = value.p99Ms ?? delayP99Ms;
      delayMaxMs = value.maxMs ?? delayMaxMs;
    },
  };
}

function expectSnapshotFields(snapshot: unknown, expected: Record<string, unknown>) {
  expect(typeof snapshot).toBe("object");
  expect(snapshot).not.toBeNull();
  const actual = snapshot as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

describe("classifyGatewayEventLoopHealthReasons", () => {
  it("does not degrade on utilization or CPU from a sub-second sample", () => {
    expect(
      classifyGatewayEventLoopHealthReasons({
        intervalMs: 250,
        delayP99Ms: 20,
        delayMaxMs: 25,
        utilization: 1,
        cpuCoreRatio: 1,
      }),
    ).toEqual([]);
  });

  it("does not degrade on utilization or CPU without delay co-evidence", () => {
    expect(
      classifyGatewayEventLoopHealthReasons({
        intervalMs: 1_000,
        delayP99Ms: 0,
        delayMaxMs: 0,
        utilization: 1,
        cpuCoreRatio: 1,
      }),
    ).toEqual([]);
  });

  it("degrades on utilization and CPU after a sustained sample window with delay co-evidence", () => {
    expect(
      classifyGatewayEventLoopHealthReasons({
        intervalMs: 1_000,
        delayP99Ms: 20,
        delayMaxMs: 25,
        utilization: 0.99,
        cpuCoreRatio: 0.95,
      }),
    ).toEqual(["event_loop_utilization", "cpu"]);
  });

  it.each([
    {
      cpuCoreRatio: 0.1,
      expected: ["event_loop_utilization"],
      name: "utilization only",
      utilization: 0.99,
    },
    {
      cpuCoreRatio: 0.95,
      expected: ["cpu"],
      name: "CPU only",
      utilization: 0.1,
    },
    {
      cpuCoreRatio: 0.1,
      expected: [],
      name: "neither load counter",
      utilization: 0.1,
    },
  ] as const)(
    "classifies delay-backed sustained load when $name is saturated",
    ({ cpuCoreRatio, expected, utilization }) => {
      expect(
        classifyGatewayEventLoopHealthReasons({
          intervalMs: 1_000,
          delayP99Ms: 30,
          delayMaxMs: 0,
          utilization,
          cpuCoreRatio,
        }),
      ).toEqual(expected);
    },
  );

  it("still degrades on event-loop delay from a short sample", () => {
    expect(
      classifyGatewayEventLoopHealthReasons({
        intervalMs: 250,
        delayP99Ms: 20,
        delayMaxMs: 1_500,
        utilization: 0.1,
        cpuCoreRatio: 0.1,
      }),
    ).toEqual(["event_loop_delay"]);
  });
});

describe("createGatewayEventLoopHealthMonitor", () => {
  it("waits for delay co-evidence before reporting load-only saturation", () => {
    const harness = createMonitorHarness();

    harness.setNow(42);
    expect(harness.monitor.snapshot()).toBeUndefined();
    expect(harness.cpuUsage).toHaveBeenCalledTimes(1);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(1);

    harness.setNow(1_000);
    expectSnapshotFields(harness.monitor.snapshot(), {
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      delayP99Ms: 0,
      delayMaxMs: 0,
      utilization: 1,
      cpuCoreRatio: 1,
    });
  });

  it("reports CPU and utilization saturation when delay co-evidence is present", () => {
    const harness = createMonitorHarness();
    harness.setDelay({ p99Ms: 30 });
    harness.setNow(1_000);

    expectSnapshotFields(harness.monitor.snapshot(), {
      degraded: true,
      reasons: ["event_loop_utilization", "cpu"],
      intervalMs: 1_000,
      delayP99Ms: 30,
      delayMaxMs: 0,
      utilization: 1,
      cpuCoreRatio: 1,
    });
  });

  it("does not wait for the sustained sample window before reporting event-loop delay", () => {
    const harness = createMonitorHarness();
    harness.setDelay({ maxMs: 1_500 });
    harness.setNow(42);

    expectSnapshotFields(harness.monitor.snapshot(), {
      degraded: true,
      reasons: ["event_loop_delay"],
      intervalMs: 42,
      delayP99Ms: 0,
      delayMaxMs: 1_500,
    });
  });

  it("returns a non-degraded snapshot when the sustained load sample is healthy", () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 0.1, utilization: 0.2 });
    harness.setNow(1_000);

    expectSnapshotFields(harness.monitor.snapshot(), {
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      utilization: 0.2,
      cpuCoreRatio: 0.1,
    });
  });

  it("keeps rate baselines and the last snapshot until a full sample window is available", () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 0.1, utilization: 0.2 });
    harness.setNow(1_000);
    const first = harness.monitor.snapshot();

    expectSnapshotFields(first, { intervalMs: 1_000 });
    expect(harness.cpuUsage).toHaveBeenCalledTimes(3);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(3);

    harness.setNow(1_250);
    expect(harness.monitor.snapshot()).toBe(first);
    expect(harness.cpuUsage).toHaveBeenCalledTimes(3);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(3);

    harness.setNow(2_000);
    const second = harness.monitor.snapshot();

    expectSnapshotFields(second, { intervalMs: 1_000 });
    expect(second).not.toBe(first);
  });

  it("preserves moderate delay co-evidence across rapid probes until the load window completes", () => {
    const harness = createMonitorHarness();
    harness.setNow(1_000);
    const first = harness.monitor.snapshot();

    harness.setDelay({ p99Ms: 30 });
    harness.setNow(1_250);
    expect(harness.monitor.snapshot()).toBe(first);

    harness.setNow(2_000);
    expectSnapshotFields(harness.monitor.snapshot(), {
      degraded: true,
      reasons: ["event_loop_utilization", "cpu"],
      intervalMs: 1_000,
      delayP99Ms: 30,
      delayMaxMs: 0,
      utilization: 1,
      cpuCoreRatio: 1,
    });
  });

  it("clears the cached snapshot when stopped", () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 0.1, utilization: 0.2 });
    harness.setNow(1_000);

    expectSnapshotFields(harness.monitor.snapshot(), { degraded: false, intervalMs: 1_000 });

    harness.setNow(1_250);
    harness.monitor.stop();

    expect(harness.delayMonitor.disable).toHaveBeenCalledTimes(1);
    expect(harness.monitor.snapshot()).toBeUndefined();
  });
});
