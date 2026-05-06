import type { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createGatewayEventLoopHealthMonitor } from "./event-loop-health.js";

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
    reset: vi.fn(),
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

describe("createGatewayEventLoopHealthMonitor", () => {
  it("waits for a sustained sample window before reporting CPU-only saturation", () => {
    const harness = createMonitorHarness();

    harness.setNow(42);
    expect(harness.monitor.snapshot()).toBeUndefined();
    expect(harness.cpuUsage).toHaveBeenCalledTimes(1);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(1);

    harness.setNow(1_000);
    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: true,
      reasons: ["event_loop_utilization", "cpu"],
      intervalMs: 1_000,
      delayP99Ms: 0,
      delayMaxMs: 0,
      utilization: 1,
      cpuCoreRatio: 1,
    });
  });

  it("does not wait for the sustained sample window before reporting event-loop delay", () => {
    const harness = createMonitorHarness();
    harness.setDelay({ maxMs: 1_500 });
    harness.setNow(42);

    expect(harness.monitor.snapshot()).toMatchObject({
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

    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      utilization: 0.2,
      cpuCoreRatio: 0.1,
    });
  });
});
