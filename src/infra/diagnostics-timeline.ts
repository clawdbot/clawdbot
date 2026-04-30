import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import { isTruthyEnvValue } from "./env.js";

export const OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION = "openclaw.diagnostics.v1";

export type DiagnosticsTimelineEventType =
  | "span.start"
  | "span.end"
  | "span.error"
  | "mark"
  | "eventLoop.sample"
  | "provider.request"
  | "childProcess.exit";

export type DiagnosticsTimelineAttributes = Record<string, string | number | boolean | null>;

export type DiagnosticsTimelineEvent = {
  type: DiagnosticsTimelineEventType;
  name: string;
  timestamp?: string;
  runId?: string;
  envName?: string;
  pid?: number;
  phase?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  attributes?: DiagnosticsTimelineAttributes;
  errorName?: string;
  errorMessage?: string;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  activeSpanName?: string;
  provider?: string;
  operation?: string;
  ok?: boolean;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
};

type DiagnosticsTimelineSpanOptions = {
  phase?: string;
  parentSpanId?: string;
  attributes?: DiagnosticsTimelineAttributes;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

type DiagnosticsTimelineOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

let warnedAboutTimelineWrite = false;
const createdTimelineDirs = new Set<string>();

function resolveDiagnosticsTimelineOptions(
  options: DiagnosticsTimelineOptions = {},
): Required<Pick<DiagnosticsTimelineOptions, "env">> & Pick<DiagnosticsTimelineOptions, "config"> {
  return {
    env: options.env ?? process.env,
    ...(options.config ? { config: options.config } : {}),
  };
}

export function isDiagnosticsTimelineEnabled(options: DiagnosticsTimelineOptions = {}): boolean {
  const { config, env } = resolveDiagnosticsTimelineOptions(options);
  return (
    (isDiagnosticFlagEnabled("timeline", config, env) ||
      isDiagnosticFlagEnabled("diagnostics.timeline", config, env) ||
      isTruthyEnvValue(env.OPENCLAW_DIAGNOSTICS)) &&
    typeof env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH === "string" &&
    env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.trim().length > 0
  );
}

function normalizeNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function normalizeAttributes(
  attributes: DiagnosticsTimelineAttributes | undefined,
): DiagnosticsTimelineAttributes | undefined {
  if (!attributes) {
    return undefined;
  }
  const normalized: DiagnosticsTimelineAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        normalized[key] = normalizeNumber(value) ?? 0;
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || value === null) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function serializeTimelineEvent(event: DiagnosticsTimelineEvent, env: NodeJS.ProcessEnv): string {
  const normalized = {
    schemaVersion: OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION,
    type: event.type,
    timestamp: event.timestamp ?? new Date().toISOString(),
    name: event.name,
    ...(env.OPENCLAW_DIAGNOSTICS_RUN_ID ? { runId: env.OPENCLAW_DIAGNOSTICS_RUN_ID } : {}),
    ...(env.OPENCLAW_DIAGNOSTICS_ENV ? { envName: env.OPENCLAW_DIAGNOSTICS_ENV } : {}),
    pid: process.pid,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.envName ? { envName: event.envName } : {}),
    ...(typeof event.pid === "number" ? { pid: event.pid } : {}),
    ...(event.phase ? { phase: event.phase } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    ...(typeof event.durationMs === "number"
      ? { durationMs: normalizeNumber(event.durationMs) }
      : {}),
    ...(event.errorName ? { errorName: event.errorName } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    ...(typeof event.p50Ms === "number" ? { p50Ms: normalizeNumber(event.p50Ms) } : {}),
    ...(typeof event.p95Ms === "number" ? { p95Ms: normalizeNumber(event.p95Ms) } : {}),
    ...(typeof event.p99Ms === "number" ? { p99Ms: normalizeNumber(event.p99Ms) } : {}),
    ...(typeof event.maxMs === "number" ? { maxMs: normalizeNumber(event.maxMs) } : {}),
    ...(event.activeSpanName ? { activeSpanName: event.activeSpanName } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(typeof event.ok === "boolean" ? { ok: event.ok } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.signal !== undefined ? { signal: event.signal } : {}),
    ...(normalizeAttributes(event.attributes)
      ? { attributes: normalizeAttributes(event.attributes) }
      : {}),
  };
  return `${JSON.stringify(normalized)}\n`;
}

export function emitDiagnosticsTimelineEvent(
  event: DiagnosticsTimelineEvent,
  options: DiagnosticsTimelineOptions = {},
): void {
  const { env } = resolveDiagnosticsTimelineOptions(options);
  if (!isDiagnosticsTimelineEnabled(options)) {
    return;
  }
  const path = env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH?.trim();
  if (!path) {
    return;
  }
  const line = serializeTimelineEvent(event, env);
  try {
    const dir = dirname(path);
    if (!createdTimelineDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      createdTimelineDirs.add(dir);
    }
    appendFileSync(path, line, "utf8");
  } catch (error) {
    if (!warnedAboutTimelineWrite) {
      warnedAboutTimelineWrite = true;
      process.stderr.write(`[diagnostics] failed to write timeline event: ${String(error)}\n`);
    }
  }
}

export async function measureDiagnosticsTimelineSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options: DiagnosticsTimelineSpanOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  if (!isDiagnosticsTimelineEnabled({ config: options.config, env })) {
    return await run();
  }
  const spanId = randomUUID();
  const startedAt = performance.now();
  emitDiagnosticsTimelineEvent(
    {
      type: "span.start",
      name,
      phase: options.phase,
      spanId,
      parentSpanId: options.parentSpanId,
      attributes: options.attributes,
    },
    { config: options.config, env },
  );
  try {
    const result = await run();
    emitDiagnosticsTimelineEvent(
      {
        type: "span.end",
        name,
        phase: options.phase,
        spanId,
        parentSpanId: options.parentSpanId,
        durationMs: performance.now() - startedAt,
        attributes: options.attributes,
      },
      { config: options.config, env },
    );
    return result;
  } catch (error) {
    emitDiagnosticsTimelineEvent(
      {
        type: "span.error",
        name,
        phase: options.phase,
        spanId,
        parentSpanId: options.parentSpanId,
        durationMs: performance.now() - startedAt,
        attributes: options.attributes,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      { config: options.config, env },
    );
    throw error;
  }
}

export function measureDiagnosticsTimelineSpanSync<T>(
  name: string,
  run: () => T,
  options: DiagnosticsTimelineSpanOptions = {},
): T {
  const env = options.env ?? process.env;
  if (!isDiagnosticsTimelineEnabled({ config: options.config, env })) {
    return run();
  }
  const spanId = randomUUID();
  const startedAt = performance.now();
  emitDiagnosticsTimelineEvent(
    {
      type: "span.start",
      name,
      phase: options.phase,
      spanId,
      parentSpanId: options.parentSpanId,
      attributes: options.attributes,
    },
    { config: options.config, env },
  );
  try {
    const result = run();
    emitDiagnosticsTimelineEvent(
      {
        type: "span.end",
        name,
        phase: options.phase,
        spanId,
        parentSpanId: options.parentSpanId,
        durationMs: performance.now() - startedAt,
        attributes: options.attributes,
      },
      { config: options.config, env },
    );
    return result;
  } catch (error) {
    emitDiagnosticsTimelineEvent(
      {
        type: "span.error",
        name,
        phase: options.phase,
        spanId,
        parentSpanId: options.parentSpanId,
        durationMs: performance.now() - startedAt,
        attributes: options.attributes,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      { config: options.config, env },
    );
    throw error;
  }
}

export async function flushDiagnosticsTimelineForTest(): Promise<void> {
  await Promise.resolve();
}
