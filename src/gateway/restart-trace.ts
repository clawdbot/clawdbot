// Gateway restart timing trace helpers.
// Emits opt-in restart handoff diagnostics with bounded metric formatting.
import { performance } from "node:perf_hooks";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const restartTraceLog = createSubsystemLogger("gateway");
const RESTART_TRACE_HANDOFF_STARTED_AT_ENV = "OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS";
const RESTART_TRACE_HANDOFF_LAST_AT_ENV = "OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS";
const RESTART_TRACE_HANDOFF_MAX_AGE_MS = 10 * 60_000;

// Restart trace is an opt-in timing logger for gateway restart handoff paths.
// It preserves elapsed time across process replacement through bounded env
// handoff values and ignores stale/future handoffs.
type RestartTraceMetricValue = boolean | number | string | null | undefined;
type RestartTraceMetrics =
  | Readonly<Record<string, RestartTraceMetricValue>>
  | ReadonlyArray<readonly [string, RestartTraceMetricValue]>;
export type GatewayRestartTraceHandoff = {
  startedAt: number;
  lastAt: number;
};

let startedAt = 0;
let lastAt = 0;
let active = false;

function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

function isRestartTraceEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_RESTART_TRACE);
}

function normalizeMetricEntries(
  metrics?: RestartTraceMetrics,
): Array<readonly [string, RestartTraceMetricValue]> {
  if (!metrics) {
    return [];
  }
  return Array.isArray(metrics) ? [...metrics] : Object.entries(metrics);
}

function formatMetricKey(key: string): string {
  // Metric keys are log tokens, not structured JSON. Keep them compact and
  // shell-friendly so trace lines remain grepable.
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "");
  if (!normalized) {
    return "metric";
  }
  return /^[A-Za-z]/u.test(normalized) ? normalized : `metric${normalized}`;
}

function formatMetricValue(value: RestartTraceMetricValue): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(1) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .replace(/\s+/gu, "_")
      .replace(/[^A-Za-z0-9_.:/-]/gu, "_")
      .slice(0, 120);
    return normalized || null;
  }
  return null;
}

function formatMetrics(metrics?: RestartTraceMetrics): string {
  const parts: string[] = [];
  for (const [key, value] of normalizeMetricEntries(metrics)) {
    const formatted = formatMetricValue(value);
    if (formatted === null) {
      continue;
    }
    parts.push(`${formatMetricKey(key)}=${formatted}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function emitRestartTrace(
  name: string,
  durationMs: number,
  totalMs: number,
  metrics?: RestartTraceMetrics,
) {
  restartTraceLog.info(
    `restart trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms${formatMetrics(metrics)}`,
  );
}

function emitRestartTraceDetail(name: string, metrics: RestartTraceMetrics): void {
  const formatted = formatMetrics(metrics).trim();
  if (!formatted) {
    return;
  }
  restartTraceLog.info(`restart trace: ${name} ${formatted}`);
}

/** Starts a restart trace sequence when OPENCLAW_GATEWAY_RESTART_TRACE is enabled. */
export function startGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  if (!isRestartTraceEnabled()) {
    active = false;
    return;
  }
  const now = nowMs();
  startedAt = now;
  lastAt = now;
  active = true;
  emitRestartTrace(name, 0, 0, metrics);
}

function isGatewayRestartTraceActive(): boolean {
  return isRestartTraceEnabled() && active;
}

/** Emits a restart trace mark since the previous mark. */
export function markGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  const now = nowMs();
  emitRestartTrace(name, now - lastAt, now - startedAt, metrics);
  lastAt = now;
}

/** Emits the final restart trace mark and deactivates tracing. */
export function finishGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  markGatewayRestartTrace(name, metrics);
  active = false;
}

/** Measures a restart trace span around async or sync work. */
export async function measureGatewayRestartTrace<T>(
  name: string,
  run: () => Promise<T> | T,
  metrics?: RestartTraceMetrics | (() => RestartTraceMetrics | undefined),
): Promise<T> {
  if (!isGatewayRestartTraceActive()) {
    return await run();
  }
  const before = nowMs();
  try {
    return await run();
  } finally {
    const now = nowMs();
    emitRestartTrace(
      name,
      now - before,
      now - startedAt,
      typeof metrics === "function" ? metrics() : metrics,
    );
    lastAt = now;
  }
}

/** Records a measured restart trace duration against the active sequence. */
export function recordGatewayRestartTrace(
  name: string,
  durationMs: number,
  metrics?: RestartTraceMetrics,
): void {
  if (!isGatewayRestartTraceActive() || !Number.isFinite(durationMs)) {
    return;
  }
  const now = nowMs();
  emitRestartTrace(name, Math.max(0, durationMs), now - startedAt, metrics);
  lastAt = now;
}

/** Records an externally measured restart trace span with explicit total time. */
export function recordGatewayRestartTraceSpan(
  name: string,
  durationMs: number,
  totalMs: number,
  metrics?: RestartTraceMetrics,
): void {
  if (!isGatewayRestartTraceActive() || !Number.isFinite(durationMs) || !Number.isFinite(totalMs)) {
    return;
  }
  emitRestartTrace(name, Math.max(0, durationMs), Math.max(0, totalMs), metrics);
}

/** Records restart trace detail metrics without a duration. */
export function recordGatewayRestartTraceDetail(name: string, metrics: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  emitRestartTraceDetail(name, metrics);
}

/** Collects process memory/resource metrics for restart trace diagnostics. */
export function collectGatewayProcessMemoryUsageMb(): ReadonlyArray<readonly [string, number]> {
  const usage = process.memoryUsage();
  const toMb = (bytes: number) => bytes / 1024 / 1024;
  const metrics: Array<readonly [string, number]> = [
    ["rssMb", toMb(usage.rss)],
    ["heapTotalMb", toMb(usage.heapTotal)],
    ["heapUsedMb", toMb(usage.heapUsed)],
    ["externalMb", toMb(usage.external)],
    ["arrayBuffersMb", toMb(usage.arrayBuffers)],
  ];
  const resources = collectGatewayProcessResourceCounts();
  if (resources) {
    metrics.push(...resources);
  }
  return metrics;
}

function collectGatewayProcessResourceCounts(): ReadonlyArray<readonly [string, number]> | null {
  const processWithResourceAccess = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
    getActiveResourcesInfo?: () => string[];
  };
  const activeHandles = processWithResourceAccess["_getActiveHandles"]?.();
  const activeRequests = processWithResourceAccess["_getActiveRequests"]?.();
  const activeResources = processWithResourceAccess.getActiveResourcesInfo?.();
  const metrics: Array<readonly [string, number]> = [
    ["processSigintListenersCount", process.listenerCount("SIGINT")],
    ["processSigtermListenersCount", process.listenerCount("SIGTERM")],
    ["processSigusr1ListenersCount", process.listenerCount("SIGUSR1")],
  ];
  if (activeHandles) {
    metrics.push(["activeHandlesCount", activeHandles.length]);
  }
  if (activeRequests) {
    metrics.push(["activeRequestsCount", activeRequests.length]);
  }
  const activeTimersCount = activeResources
    ? countActiveTimersFromResourceInfo(activeResources)
    : activeHandles
      ? countActiveTimersFromHandles(activeHandles)
      : undefined;
  if (activeTimersCount !== undefined) {
    metrics.push(["activeTimersCount", activeTimersCount]);
  }
  return metrics.length > 0 ? metrics : null;
}

function countActiveTimersFromResourceInfo(activeResources: readonly string[]): number {
  return activeResources.filter((resource) => resource === "Timeout" || resource === "Timer")
    .length;
}

function countActiveTimersFromHandles(activeHandles: readonly unknown[]): number {
  let count = 0;
  for (const handle of activeHandles) {
    if (typeof handle !== "object" || handle === null) {
      continue;
    }
    const constructorName = (handle as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName === "Timeout" || constructorName === "Timer") {
      count += 1;
    }
  }
  return count;
}

function normalizeRestartTraceHandoff(value: unknown): GatewayRestartTraceHandoff | null {
  // Handoff values come from another process. Reject stale/future values so a
  // reused shell environment cannot poison later restart measurements.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as { startedAt?: unknown; lastAt?: unknown };
  if (
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.lastAt !== "number" ||
    !Number.isFinite(record.lastAt) ||
    record.startedAt <= 0 ||
    record.lastAt < record.startedAt ||
    record.lastAt - record.startedAt > RESTART_TRACE_HANDOFF_MAX_AGE_MS
  ) {
    return null;
  }
  const now = nowMs();
  if (record.startedAt > now || now - record.startedAt > RESTART_TRACE_HANDOFF_MAX_AGE_MS) {
    return null;
  }
  return {
    startedAt: record.startedAt,
    lastAt: record.lastAt,
  };
}

/** Captures restart trace handoff state for a child replacement process. */
export function captureGatewayRestartTraceHandoff(): GatewayRestartTraceHandoff | undefined {
  if (!isGatewayRestartTraceActive()) {
    return undefined;
  }
  return { startedAt, lastAt };
}

/** Builds env vars that carry restart trace handoff state to a replacement process. */
export function createGatewayRestartTraceHandoffEnv(
  handoff: GatewayRestartTraceHandoff | undefined = captureGatewayRestartTraceHandoff(),
): NodeJS.ProcessEnv | undefined {
  const normalized = normalizeRestartTraceHandoff(handoff);
  if (!normalized) {
    return undefined;
  }
  return {
    [RESTART_TRACE_HANDOFF_STARTED_AT_ENV]: String(normalized.startedAt),
    [RESTART_TRACE_HANDOFF_LAST_AT_ENV]: String(normalized.lastAt),
  };
}

/** Resumes restart tracing from a validated in-memory handoff object. */
export function resumeGatewayRestartTraceFromHandoff(
  handoff: unknown,
  metrics?: RestartTraceMetrics,
): boolean {
  if (!isRestartTraceEnabled() || active) {
    return false;
  }
  const normalized = normalizeRestartTraceHandoff(handoff);
  if (!normalized) {
    return false;
  }
  startedAt = normalized.startedAt;
  lastAt = normalized.lastAt;
  active = true;
  markGatewayRestartTrace("restart.process-resume", metrics);
  return true;
}

/** Resumes restart tracing from env handoff vars and removes them from the env. */
export function resumeGatewayRestartTraceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  metrics?: RestartTraceMetrics,
): boolean {
  const startedRaw = env[RESTART_TRACE_HANDOFF_STARTED_AT_ENV];
  const lastRaw = env[RESTART_TRACE_HANDOFF_LAST_AT_ENV];
  delete env[RESTART_TRACE_HANDOFF_STARTED_AT_ENV];
  delete env[RESTART_TRACE_HANDOFF_LAST_AT_ENV];
  return resumeGatewayRestartTraceFromHandoff(
    {
      startedAt: Number(startedRaw),
      lastAt: Number(lastRaw),
    },
    metrics,
  );
}

/** Resets restart trace globals for tests. */
export function resetGatewayRestartTraceForTest(): void {
  startedAt = 0;
  lastAt = 0;
  active = false;
}
