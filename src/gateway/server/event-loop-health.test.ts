// Event-loop health tests cover sampling ownership and delay/load classification.
import type { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInternalDiagnosticEventSequence,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { registerSkillUsageTracking } from "../../skills/workshop/curator.js";
import { createGatewayEventLoopHealthMonitor } from "./event-loop-health.js";

type CpuUsage = ReturnType<typeof process.cpuUsage>;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
const monitors: ReturnType<typeof createGatewayEventLoopHealthMonitor>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.stop();
  }
  vi.useRealTimers();
});

function createMonitorHarness(params?: { cpuMsPerWallMs?: number; utilization?: number }) {
  let nowMs = 10_000;
  const cpuMsPerWallMs = params?.cpuMsPerWallMs ?? 0.1;
  const utilization = params?.utilization ?? 0.2;
  const cpuUsage = vi.fn((previous?: CpuUsage) => {
    const current = { user: Math.round(nowMs * cpuMsPerWallMs * 1_000), system: 0 };
    return previous
      ? { user: current.user - previous.user, system: current.system - previous.system }
      : current;
  });
  const eventLoopUtilization = vi.fn(
    (current?: EventLoopUtilization, previous?: EventLoopUtilization) => ({
      idle: 0,
      active: current && previous ? current.active - previous.active : nowMs,
      utilization,
    }),
  );
  const monitor = createGatewayEventLoopHealthMonitor({
    now: () => nowMs,
    cpuUsage,
    eventLoopUtilization,
  });
  monitors.push(monitor);
  const sample = (elapsedMs = 20) => {
    nowMs += elapsedMs;
    vi.advanceTimersByTime(20);
  };
  return {
    monitor,
    cpuUsage,
    eventLoopUtilization,
    sample,
    samples: (count: number, elapsedMs = 20) => {
      for (let index = 0; index < count; index++) {
        sample(elapsedMs);
      }
    },
    elapseWithoutSampling: (elapsedMs: number) => {
      nowMs += elapsedMs;
    },
  };
}

describe("createGatewayEventLoopHealthMonitor", () => {
  it("does not turn reads without samples into healthy observations", () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 1, utilization: 1 });
    harness.elapseWithoutSampling(1_200);
    for (let index = 0; index < 100; index++) {
      expect(harness.monitor.snapshot()).toBeUndefined();
      expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
    }
    expect(harness.cpuUsage).toHaveBeenCalledTimes(1);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(1);
    harness.sample();
    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: true,
      intervalMs: 1_220,
      delayMaxMs: 1_220.5,
      reasons: ["event_loop_delay", "event_loop_utilization", "cpu"],
    });
  });

  it("waits for delay co-evidence before reporting load saturation", () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 1, utilization: 1 });
    harness.samples(49);
    expect(harness.monitor.snapshot()).toBeUndefined();
    harness.sample();
    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      delayMaxMs: 20,
      utilization: 1,
      cpuCoreRatio: 1,
    });
  });

  it.each([
    { cpuMsPerWallMs: 1, utilization: 0.2, reasons: ["cpu"] },
    { cpuMsPerWallMs: 0.1, utilization: 1, reasons: ["event_loop_utilization"] },
    { cpuMsPerWallMs: 1, utilization: 1, reasons: ["event_loop_utilization", "cpu"] },
  ])("preserves load classification with delay co-evidence: $reasons", (params) => {
    const harness = createMonitorHarness(params);
    harness.samples(34, 30);
    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: true,
      degradedSinceMs: 0,
      intervalMs: 1_020,
      delayP99Ms: 30,
      delayMaxMs: 30,
      reasons: params.reasons,
    });
  });

  it.each([false, true])(
    "preserves overdue delay across reads with prior window=%s",
    (priorWindow) => {
      const harness = createMonitorHarness();
      harness.samples(priorWindow ? 50 : 4);
      const previous = harness.monitor.snapshot();
      harness.elapseWithoutSampling(1_200);
      for (let index = 0; index < 100; index++) {
        expect(harness.monitor.snapshot()).toBe(previous);
      }
      harness.sample();
      const current = harness.monitor.snapshot();
      expect(current?.delayMaxMs).toBeGreaterThanOrEqual(1_200);
      expect(current).toMatchObject({ degraded: true, reasons: ["event_loop_delay"] });
      expect(harness.monitor.snapshot()).toBe(current);
    },
  );

  it("retains completed observations until the next sampling window", () => {
    const harness = createMonitorHarness();
    harness.samples(50);
    const first = harness.monitor.snapshot();
    expect(first).toMatchObject({ degraded: false, intervalMs: 1_000 });
    expect(harness.cpuUsage).toHaveBeenCalledTimes(3);
    harness.samples(12);
    expect(harness.monitor.snapshot()).toBe(first);
    expect(harness.cpuUsage).toHaveBeenCalledTimes(3);
    harness.samples(38);
    expect(harness.monitor.snapshot()).not.toBe(first);
    expect(harness.monitor.snapshot()).toMatchObject({ intervalMs: 1_000 });
  });

  it("tracks persistent degradation at completed samples and clears on recovery", () => {
    const harness = createMonitorHarness();
    harness.sample(1_500);
    expect(harness.monitor.snapshot()).toMatchObject({ degraded: true, degradedSinceMs: 0 });
    harness.sample(59_999);
    expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
    harness.sample(1_000);
    expect(harness.monitor.persistentDegradationSnapshot()).toMatchObject({
      degraded: true,
      degradedSinceMs: 60_999,
    });
    const degraded = harness.monitor.snapshot();
    harness.samples(49);
    expect(harness.monitor.snapshot()).toBe(degraded);
    expect(harness.monitor.persistentDegradationSnapshot()).toBe(degraded);
    harness.sample();
    expect(harness.monitor.snapshot()).toMatchObject({ degraded: false, degradedSinceMs: null });
    expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
  });

  it("discards the pending interval and rate baselines only for an explicit host-thaw reset", () => {
    const harness = createMonitorHarness();
    harness.sample(1_500);
    harness.elapseWithoutSampling(90_000);
    harness.monitor.reset();
    expect(harness.monitor.snapshot()).toBeUndefined();
    harness.samples(50);
    expect(harness.monitor.snapshot()).toMatchObject({
      degraded: false,
      intervalMs: 1_000,
      delayMaxMs: 20,
      cpuCoreRatio: 0.1,
    });
  });

  it("releases its only timer and cached observation when stopped", () => {
    const harness = createMonitorHarness();
    expect(vi.getTimerCount()).toBe(1);
    harness.samples(50);
    harness.monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    harness.samples(100);
    harness.monitor.reset();
    expect(harness.monitor.snapshot()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("event-loop measurement telemetry", () => {
  beforeEach(resetDiagnosticEventsForTest);
  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticEventsForTest();
  });

  it("records each sampling window once without needing a reader or inheriting reader context", async () => {
    const harness = createMonitorHarness();
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => events.push(event), {
      include: ["gateway.event_loop.sample"],
    });
    const readerTrace = createDiagnosticTraceContext();
    runWithDiagnosticTraceContext(readerTrace, () => {
      harness.sample(1_500);
      const first = harness.monitor.snapshot();
      for (let index = 0; index < 10; index++) {
        expect(harness.monitor.snapshot()).toBe(first);
      }
      expect(getActiveDiagnosticTraceContext()?.traceId).toBe(readerTrace.traceId);
    });
    harness.samples(50);
    await waitForDiagnosticEventsDrained();
    expect(events).toMatchObject([
      { type: "gateway.event_loop.sample", intervalMs: 1_500, delayMaxMs: 1_500.5 },
      { type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 20 },
    ]);
    expect(events.map((event) => event.trace)).toEqual([undefined, undefined]);
  });

  it("keeps diagnostics-disabled sampling active without emitting telemetry", async () => {
    const listener = vi.fn();
    onInternalDiagnosticEvent(listener, { include: ["gateway.event_loop.sample"] });
    setDiagnosticsEnabledForProcess(false);
    const harness = createMonitorHarness();
    harness.sample(1_500);
    expect(harness.monitor.snapshot()?.reasons).toEqual(["event_loop_delay"]);
    await waitForDiagnosticEventsDrained();
    expect(listener).not.toHaveBeenCalled();
    expect(getInternalDiagnosticEventSequence()).toBe(0);
  });

  it.each([
    { name: "no listener", subscribe: () => () => {} },
    { name: "public listener", subscribe: () => onDiagnosticEvent(() => {}) },
    {
      name: "unrelated listener",
      subscribe: () => onInternalDiagnosticEvent(() => {}, { include: ["diagnostic.heartbeat"] }),
    },
    {
      name: "stability recorder",
      subscribe: () => {
        startDiagnosticStabilityRecorder();
        return stopDiagnosticStabilityRecorder;
      },
    },
    { name: "skill tracking", subscribe: () => registerSkillUsageTracking() },
  ])("does not emit exporter windows with only $name", async ({ subscribe }) => {
    const unsubscribe = subscribe();
    try {
      const harness = createMonitorHarness();
      harness.sample(1_500);
      expect(harness.monitor.snapshot()?.reasons).toEqual(["event_loop_delay"]);
      await waitForDiagnosticEventsDrained();
      expect(getInternalDiagnosticEventSequence()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("does not turn reset, stop, or repeated reads into completed windows", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => events.push(event), {
      include: ["gateway.event_loop.sample"],
    });
    const harness = createMonitorHarness();
    harness.samples(4);
    harness.elapseWithoutSampling(1_500);
    harness.monitor.reset();
    harness.samples(50);
    harness.monitor.stop();
    expect(harness.monitor.snapshot()).toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events).toMatchObject([
      { type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 20 },
    ]);
  });
});
