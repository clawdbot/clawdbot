import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_WARN_MS = 1_000;
const EVENT_LOOP_UTILIZATION_WARN = 0.95;
const CPU_CORE_RATIO_WARN = 0.9;
// Load counters can spike during frequent short async wakeups; delay is the blocking signal.
const LOAD_DEGRADATION_DELAY_COEVIDENCE_MS = 25;
const SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1_000;

type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type CpuUsage = ReturnType<typeof process.cpuUsage>;

export type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type GatewayEventLoopHealth = {
  degraded: boolean;
  reasons: GatewayEventLoopHealthReason[];
  intervalMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
  utilization: number;
  cpuCoreRatio: number;
};

export type GatewayEventLoopHealthMonitor = {
  snapshot: () => GatewayEventLoopHealth | undefined;
  stop: () => void;
};

type EventLoopUtilizationReader = typeof performance.eventLoopUtilization;

type EventLoopDelayMonitorFactory = (resolutionMs: number) => EventLoopDelayMonitor;

type GatewayEventLoopHealthMonitorDeps = {
  now?: () => number;
  cpuUsage?: typeof process.cpuUsage;
  eventLoopUtilization?: EventLoopUtilizationReader;
  createDelayMonitor?: EventLoopDelayMonitorFactory;
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

export function classifyGatewayEventLoopHealthReasons(
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
  const nowMs = deps.now ?? Date.now;
  const readCpuUsage = deps.cpuUsage ?? process.cpuUsage.bind(process);
  const readEventLoopUtilization =
    deps.eventLoopUtilization ?? performance.eventLoopUtilization.bind(performance);
  const createDelayMonitor =
    deps.createDelayMonitor ??
    ((resolutionMs: number) => monitorEventLoopDelay({ resolution: resolutionMs }));
  let monitor: EventLoopDelayMonitor | null = null;
  let lastWallAt = nowMs();
  let lastCpuUsage: CpuUsage | null = readCpuUsage();
  let lastEventLoopUtilization: EventLoopUtilization | null = readEventLoopUtilization();
  let lastSnapshot: GatewayEventLoopHealth | undefined;

  try {
    monitor = createDelayMonitor(EVENT_LOOP_MONITOR_RESOLUTION_MS);
    monitor.enable();
    monitor.reset();
  } catch {
    monitor = null;
  }

  return {
    snapshot: () => {
      if (!monitor || !lastCpuUsage || !lastEventLoopUtilization || lastWallAt <= 0) {
        return undefined;
      }

      const now = nowMs();
      const intervalMs = Math.max(1, now - lastWallAt);
      const delayP99Ms = nanosecondsToMilliseconds(monitor.percentile(99));
      const delayMaxMs = nanosecondsToMilliseconds(monitor.max);
      const hasDelayWarning =
        delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS || delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS;

      if (!hasDelayWarning && intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) {
        return lastSnapshot;
      }

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

      const snapshot: GatewayEventLoopHealth = {
        degraded: reasons.length > 0,
        reasons,
        intervalMs,
        delayP99Ms,
        delayMaxMs,
        utilization,
        cpuCoreRatio,
      };

      monitor.reset();
      lastWallAt = now;
      lastCpuUsage = readCpuUsage();
      lastEventLoopUtilization = currentEventLoopUtilization;
      lastSnapshot = snapshot;

      return snapshot;
    },
    stop: () => {
      monitor?.disable();
      monitor = null;
      lastWallAt = 0;
      lastCpuUsage = null;
      lastEventLoopUtilization = null;
      lastSnapshot = undefined;
    },
  };
}
