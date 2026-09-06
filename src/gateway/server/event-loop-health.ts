// Event-loop health monitor samples delay, utilization, and CPU pressure for gateway readiness snapshots.
import { createHistogram, performance, type RecordableHistogram } from "node:perf_hooks";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";

const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_WARN_MS = 1_000;
const EVENT_LOOP_UTILIZATION_WARN = 0.95;
const CPU_CORE_RATIO_WARN = 0.9;
const PERSISTENT_DEGRADATION_WARN_AFTER_MS = 60_000;
// Load counters can spike during frequent short async wakeups; delay is the blocking signal.
const LOAD_DEGRADATION_DELAY_COEVIDENCE_MS = 25;
const SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1_000;

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;

type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type GatewayEventLoopHealth = {
  degraded: boolean;
  degradedSinceMs: number | null;
  reasons: GatewayEventLoopHealthReason[];
  intervalMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
  utilization: number;
  cpuCoreRatio: number;
};

type GatewayEventLoopHealthMonitor = {
  snapshot: () => GatewayEventLoopHealth | undefined;
  persistentDegradationSnapshot: () => GatewayEventLoopHealth | undefined;
  reset: () => void;
  stop: () => void;
};

type EventLoopUtilizationReader = typeof performance.eventLoopUtilization;

type GatewayEventLoopHealthMonitorDeps = {
  now?: () => number;
  cpuUsage?: typeof process.cpuUsage;
  eventLoopUtilization?: EventLoopUtilizationReader;
};

type GatewayEventLoopHealthMetrics = Pick<
  GatewayEventLoopHealth,
  "intervalMs" | "delayP99Ms" | "delayMaxMs" | "utilization" | "cpuCoreRatio"
>;

function roundMetric(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nanosecondsToMilliseconds(value: number): number {
  return roundMetric(value / 1_000_000, 1);
}

function classifyGatewayEventLoopHealthReasons(
  metrics: GatewayEventLoopHealthMetrics,
): GatewayEventLoopHealthReason[] {
  const reasons: GatewayEventLoopHealthReason[] = [];

  if (
    metrics.delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS ||
    metrics.delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS
  ) {
    reasons.push("event_loop_delay");
  }

  if (metrics.intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) {
    return reasons;
  }

  const hasDelayCoEvidence =
    metrics.delayP99Ms >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS ||
    metrics.delayMaxMs >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS;
  if (!hasDelayCoEvidence) {
    return reasons;
  }

  if (metrics.utilization >= EVENT_LOOP_UTILIZATION_WARN) {
    reasons.push("event_loop_utilization");
  }
  if (metrics.cpuCoreRatio >= CPU_CORE_RATIO_WARN) {
    reasons.push("cpu");
  }

  return reasons;
}

export function createGatewayEventLoopHealthMonitor(
  deps: GatewayEventLoopHealthMonitorDeps = {},
): GatewayEventLoopHealthMonitor {
  const nowMs = deps.now ?? performance.now.bind(performance);
  const readCpuUsage = deps.cpuUsage ?? process.cpuUsage.bind(process);
  const readEventLoopUtilization =
    deps.eventLoopUtilization ?? performance.eventLoopUtilization.bind(performance);
  let histogram: RecordableHistogram | null = null;
  let lastSampleAt = nowMs();
  let lastWallAt = lastSampleAt;
  let lastCpuUsage = readCpuUsage();
  let lastEventLoopUtilization: EventLoopUtilization = readEventLoopUtilization();
  let lastSnapshot: GatewayEventLoopHealth | undefined;
  let firstDegradedAtMs: number | null = null;

  try {
    // Match Node's interval delay histogram range and precision.
    histogram = createHistogram({ lowest: 1_000n, highest: 2n ** 63n - 1n, figures: 3 });
  } catch {
    histogram = null;
  }

  const sample = () => {
    if (!histogram) {
      return;
    }

    const now = nowMs();
    // A window reset must not erase the pending sample's monotonic anchor.
    // Native interval histograms reset that anchor before an overdue callback runs.
    histogram.record(BigInt(Math.max(1, Math.round((now - lastSampleAt) * 1_000_000))));
    lastSampleAt = now;
    const intervalMs = Math.max(1, now - lastWallAt);
    const delayMaxMs = nanosecondsToMilliseconds(histogram.max);
    if (
      delayMaxMs < EVENT_LOOP_DELAY_WARN_MS &&
      intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS
    ) {
      return;
    }
    const delayP99Ms = nanosecondsToMilliseconds(histogram.percentile(99));

    const cpuUsage = readCpuUsage(lastCpuUsage);
    const currentEventLoopUtilization = readEventLoopUtilization();
    const utilization = roundMetric(
      readEventLoopUtilization(currentEventLoopUtilization, lastEventLoopUtilization).utilization,
    );
    const cpuTotalMs = roundMetric((cpuUsage.user + cpuUsage.system) / 1_000, 1);
    const cpuCoreRatio = roundMetric(cpuTotalMs / intervalMs);
    const reasons = classifyGatewayEventLoopHealthReasons({
      intervalMs,
      delayP99Ms,
      delayMaxMs,
      utilization,
      cpuCoreRatio,
    });
    const degraded = reasons.length > 0;
    if (degraded) {
      firstDegradedAtMs ??= now;
    } else {
      firstDegradedAtMs = null;
    }

    const health: GatewayEventLoopHealth = {
      degraded,
      degradedSinceMs:
        firstDegradedAtMs === null ? null : Math.max(0, Math.round(now - firstDegradedAtMs)),
      reasons,
      intervalMs,
      delayP99Ms,
      delayMaxMs,
      utilization,
      cpuCoreRatio,
    };

    histogram.reset();
    lastWallAt = now;
    lastCpuUsage = readCpuUsage();
    lastEventLoopUtilization = currentEventLoopUtilization;
    lastSnapshot = health;

    // Publish once at the sampling owner; readers never reset or commit observations.
    if (
      areDiagnosticsEnabledForProcess() &&
      hasInternalDiagnosticEventInterest("gateway.event_loop.sample")
    ) {
      runWithDiagnosticTraceContext(undefined, () =>
        emitInternalDiagnosticEvent({ type: "gateway.event_loop.sample", intervalMs, delayMaxMs }),
      );
    }
  };

  const timer = histogram ? setInterval(sample, EVENT_LOOP_MONITOR_RESOLUTION_MS) : undefined;
  timer?.unref();

  const reset = () => {
    histogram?.reset();
    lastSampleAt = nowMs();
    lastWallAt = lastSampleAt;
    lastCpuUsage = readCpuUsage();
    lastEventLoopUtilization = readEventLoopUtilization();
    lastSnapshot = undefined;
    firstDegradedAtMs = null;
  };

  return {
    snapshot: () => lastSnapshot,
    // The heartbeat consumes the sampler's snapshot without advancing its window.
    persistentDegradationSnapshot: () => {
      const current = lastSnapshot;
      return current?.degradedSinceMs != null &&
        current.degradedSinceMs >= PERSISTENT_DEGRADATION_WARN_AFTER_MS
        ? current
        : undefined;
    },
    reset,
    stop: () => {
      clearInterval(timer);
      histogram = null;
      lastSnapshot = undefined;
      firstDegradedAtMs = null;
    },
  };
}
