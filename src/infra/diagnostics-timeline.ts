import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import { isTruthyEnvValue } from "./env.js";
import { appendRegularFileSync } from "./regular-file.js";

const OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION = "openclaw.diagnostics.v1";

type DiagnosticsTimelineEventType =
  | "span.start"
  | "span.end"
  | "span.error"
  | "mark"
  | "eventLoop.sample"
  | "provider.request"
  | "childProcess.exit";

type DiagnosticsTimelineAttributes = Record<string, string | number | boolean | null>;

type DiagnosticsTimelineEvent = {
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
  omitErrorMessage?: boolean;
};

type DiagnosticsTimelineOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

export type ActiveDiagnosticsTimelineSpan = {
  name: string;
  phase?: string;
  spanId: string;
  parentSpanId?: string;
  attributes?: DiagnosticsTimelineAttributes;
};

type StartedDiagnosticsTimelineSpan = ActiveDiagnosticsTimelineSpan & {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  startedAt: number;
  omitErrorMessage?: boolean;
};

let warnedAboutTimelineWrite = false;
const createdTimelineDirs = new Set<string>();
const activeDiagnosticsTimelineSpan = new AsyncLocalStorage<ActiveDiagnosticsTimelineSpan>();

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
    appendRegularFileSync({ filePath: path, content: line });
  } catch (error) {
    if (!warnedAboutTimelineWrite) {
      warnedAboutTimelineWrite = true;
      process.stderr.write(`[diagnostics] failed to write timeline event: ${String(error)}\n`);
    }
  }
}

export function getActiveDiagnosticsTimelineSpan(): ActiveDiagnosticsTimelineSpan | undefined {
  return activeDiagnosticsTimelineSpan.getStore();
}

function startDiagnosticsTimelineSpan(
  name: string,
  options: DiagnosticsTimelineSpanOptions,
): StartedDiagnosticsTimelineSpan | undefined {
  const env = options.env ?? process.env;
  if (!isDiagnosticsTimelineEnabled({ config: options.config, env })) {
    return undefined;
  }
  const activeSpan = getActiveDiagnosticsTimelineSpan();
  const phase = options.phase ?? activeSpan?.phase;
  const parentSpanId = options.parentSpanId ?? activeSpan?.spanId;
  const span: StartedDiagnosticsTimelineSpan = {
    name,
    env,
    ...(options.config ? { config: options.config } : {}),
    spanId: randomUUID(),
    startedAt: performance.now(),
    ...(phase ? { phase } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(options.attributes ? { attributes: options.attributes } : {}),
    ...(options.omitErrorMessage ? { omitErrorMessage: true } : {}),
  };
  emitDiagnosticsTimelineEvent(
    {
      type: "span.start",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      attributes: span.attributes,
    },
    { config: span.config, env: span.env },
  );
  return span;
}

function runInDiagnosticsTimelineSpan<T>(span: StartedDiagnosticsTimelineSpan, run: () => T): T {
  return activeDiagnosticsTimelineSpan.run(
    {
      name: span.name,
      ...(span.phase ? { phase: span.phase } : {}),
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      ...(span.attributes ? { attributes: span.attributes } : {}),
    },
    run,
  );
}

function emitFinishedDiagnosticsTimelineSpan(span: StartedDiagnosticsTimelineSpan): void {
  emitDiagnosticsTimelineEvent(
    {
      type: "span.end",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      durationMs: performance.now() - span.startedAt,
      attributes: span.attributes,
    },
    { config: span.config, env: span.env },
  );
}

function emitFailedDiagnosticsTimelineSpan(
  span: StartedDiagnosticsTimelineSpan,
  error: unknown,
): void {
  emitDiagnosticsTimelineEvent(
    {
      type: "span.error",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      durationMs: performance.now() - span.startedAt,
      attributes: span.attributes,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(span.omitErrorMessage
        ? {}
        : { errorMessage: error instanceof Error ? error.message : String(error) }),
    },
    { config: span.config, env: span.env },
  );
}

export async function measureDiagnosticsTimelineSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options: DiagnosticsTimelineSpanOptions = {},
): Promise<T> {
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return await run();
  }
  try {
    const result = await runInDiagnosticsTimelineSpan(span, () => run());
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFailedDiagnosticsTimelineSpan(span, error);
    throw error;
  }
}

export function measureDiagnosticsTimelineSpanSync<T>(
  name: string,
  run: () => T,
  options: DiagnosticsTimelineSpanOptions = {},
): T {
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return run();
  }
  try {
    const result = runInDiagnosticsTimelineSpan(span, run);
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFailedDiagnosticsTimelineSpan(span, error);
    throw error;
  }
}

export async function flushDiagnosticsTimelineForTest(): Promise<void> {
  await Promise.resolve();
}
