import { performance } from "node:perf_hooks";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const restartTraceLog = createSubsystemLogger("gateway");
const RESTART_TRACE_HANDOFF_STARTED_AT_ENV = "OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS";
const RESTART_TRACE_HANDOFF_LAST_AT_ENV = "OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS";
const RESTART_TRACE_HANDOFF_MAX_AGE_MS = 10 * 60_000;

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

export function markGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  const now = nowMs();
  emitRestartTrace(name, now - lastAt, now - startedAt, metrics);
  lastAt = now;
}

export function finishGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  markGatewayRestartTrace(name, metrics);
  active = false;
}

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

export function recordGatewayRestartTraceDetail(name: string, metrics: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  emitRestartTraceDetail(name, metrics);
}

export function collectGatewayProcessMemoryUsageMb(): ReadonlyArray<readonly [string, number]> {
  const usage = process.memoryUsage();
  const toMb = (bytes: number) => bytes / 1024 / 1024;
  return [
    ["rssMb", toMb(usage.rss)],
    ["heapTotalMb", toMb(usage.heapTotal)],
    ["heapUsedMb", toMb(usage.heapUsed)],
    ["externalMb", toMb(usage.external)],
    ["arrayBuffersMb", toMb(usage.arrayBuffers)],
  ];
}

function normalizeRestartTraceHandoff(value: unknown): GatewayRestartTraceHandoff | null {
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

export function captureGatewayRestartTraceHandoff(): GatewayRestartTraceHandoff | undefined {
  if (!isGatewayRestartTraceActive()) {
    return undefined;
  }
  return { startedAt, lastAt };
}

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

export function resetGatewayRestartTraceForTest(): void {
  startedAt = 0;
  lastAt = 0;
  active = false;
}
