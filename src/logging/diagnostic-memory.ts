import {
  emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { writeDiagnosticMemoryPressureBundleSync } from "./diagnostic-stability-bundle.js";
import { createSubsystemLogger } from "./subsystem.js";

const MB = 1024 * 1024;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;

const log = createSubsystemLogger("gateway").child("diagnostics/memory");

type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};

type DiagnosticMemorySample = {
  ts: number;
  memory: DiagnosticMemoryUsage;
};

type DiagnosticMemoryState = {
  lastSample: DiagnosticMemorySample | null;
  lastPressureAtByKey: Map<string, number>;
};

const state: DiagnosticMemoryState = {
  lastSample: null,
  lastPressureAtByKey: new Map(),
};

function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): DiagnosticMemoryUsage {
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function resolveThresholds(
  thresholds?: DiagnosticMemoryThresholds,
): Required<DiagnosticMemoryThresholds> {
  return {
    rssWarningBytes: thresholds?.rssWarningBytes ?? DEFAULT_RSS_WARNING_BYTES,
    rssCriticalBytes: thresholds?.rssCriticalBytes ?? DEFAULT_RSS_CRITICAL_BYTES,
    heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? DEFAULT_HEAP_WARNING_BYTES,
    heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? DEFAULT_HEAP_CRITICAL_BYTES,
    rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
    rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
    growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
    pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
  };
}

function pickThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, thresholds } = params;
  if (memory.rssBytes >= thresholds.rssCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssCriticalBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) {
    return {
      level: "critical",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedCriticalBytes,
    };
  }
  if (memory.rssBytes >= thresholds.rssWarningBytes) {
    return {
      level: "warning",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssWarningBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) {
    return {
      level: "warning",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedWarningBytes,
    };
  }
  return null;
}

function pickGrowthPressure(params: {
  previous: DiagnosticMemorySample | null;
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { previous, current, thresholds } = params;
  if (!previous) {
    return null;
  }
  const windowMs = current.ts - previous.ts;
  if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
    return null;
  }
  const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
  if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthCriticalBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) {
    return {
      level: "warning",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthWarningBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  return null;
}

function shouldEmitPressure(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
  now: number,
  repeatMs: number,
): boolean {
  const key = `${pressure.level}:${pressure.reason}`;
  const lastAt = state.lastPressureAtByKey.get(key);
  if (lastAt !== undefined && now - lastAt < repeatMs) {
    return false;
  }
  state.lastPressureAtByKey.set(key, now);
  return true;
}

function formatOptionalPressureMetric(label: string, value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? ` ${label}=${value}` : "";
}

function logMemoryPressure(params: {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">;
  writeCriticalBundle: boolean;
}): void {
  const { pressure } = params;
  const message =
    `memory pressure: level=${pressure.level} reason=${pressure.reason}` +
    ` rssBytes=${pressure.memory.rssBytes}` +
    ` heapUsedBytes=${pressure.memory.heapUsedBytes}` +
    formatOptionalPressureMetric("thresholdBytes", pressure.thresholdBytes) +
    formatOptionalPressureMetric("rssGrowthBytes", pressure.rssGrowthBytes) +
    formatOptionalPressureMetric("windowMs", pressure.windowMs) +
    (pressure.level === "critical"
      ? ` memoryPressureSnapshot=${params.writeCriticalBundle ? "enabled" : "disabled"}`
      : "");
  if (pressure.level === "critical") {
    log.warn(message);
  } else {
    log.info(message);
  }
}

export function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
  writeCriticalBundle?: boolean;
  stateDir?: string;
  sessionStorePaths?: string[];
  resolveSessionStorePaths?: () => string[] | undefined;
}): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
  const current = { ts: now, memory };
  const thresholds = resolveThresholds(options?.thresholds);
  const shouldEmitSample = options?.emitSample !== false;

  if (shouldEmitSample) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory,
      uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
    });
  }

  const pressure =
    pickThresholdPressure({ memory, thresholds }) ??
    pickGrowthPressure({ previous: state.lastSample, current, thresholds });
  state.lastSample = current;
  if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    const writeCriticalBundle = options?.writeCriticalBundle === true;
    logMemoryPressure({ pressure, writeCriticalBundle });
    if (pressure.level === "critical" && writeCriticalBundle) {
      const sessionStorePaths = options?.sessionStorePaths ?? options?.resolveSessionStorePaths?.();
      const result = writeDiagnosticMemoryPressureBundleSync({
        pressure,
        stateDir: options?.stateDir,
        sessionStorePaths,
        now: new Date(now),
      });
      if (result.status === "written") {
        log.warn(
          `critical memory pressure bundle written: path=${result.path} reason=${pressure.reason} level=${pressure.level}`,
        );
      } else if (result.status === "failed") {
        log.warn(`critical memory pressure bundle failed: ${String(result.error)}`);
      }
    } else if (pressure.level === "critical") {
      log.warn(
        "critical memory pressure snapshot disabled: diagnostics.memoryPressureSnapshot=false",
      );
    }
  }
  return memory;
}

export function resetDiagnosticMemoryForTest(): void {
  state.lastSample = null;
  state.lastPressureAtByKey.clear();
}
