// Creates and propagates lightweight W3C diagnostic trace contexts.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  normalizeDiagnosticTraceparent,
  normalizeSpanId,
  normalizeTraceFlags,
  normalizeTraceId,
  parseDiagnosticTraceparent,
  TRACEPARENT_VERSION,
} from "./diagnostic-trace-context-pure.js";
import type { DiagnosticTraceContext } from "./diagnostic-trace-context-pure.js";

const DEFAULT_TRACE_FLAGS = "01";
const DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

export {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  normalizeDiagnosticTraceparent,
  parseDiagnosticTraceparent,
};
export type { DiagnosticTraceContext };

type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
  traceparent?: string;
};

type DiagnosticTraceScopeState = {
  marker: symbol;
  storage: AsyncLocalStorage<DiagnosticTraceContext>;
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

function randomTraceId(): string {
  let traceId = randomHex(16);
  while (!isNonZeroHex(traceId)) {
    traceId = randomHex(16);
  }
  return traceId;
}

function randomSpanId(): string {
  let spanId = randomHex(8);
  while (!isNonZeroHex(spanId)) {
    spanId = randomHex(8);
  }
  return spanId;
}

function createDiagnosticTraceScopeState(): DiagnosticTraceScopeState {
  return {
    marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY,
    storage: new AsyncLocalStorage<DiagnosticTraceContext>(),
  };
}

function isDiagnosticTraceScopeState(value: unknown): value is DiagnosticTraceScopeState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticTraceScopeState>;
  return (
    candidate.marker === DIAGNOSTIC_TRACE_SCOPE_STATE_KEY &&
    candidate.storage instanceof AsyncLocalStorage
  );
}

function getDiagnosticTraceScopeState(): DiagnosticTraceScopeState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
  if (isDiagnosticTraceScopeState(existing)) {
    return existing;
  }
  const state = createDiagnosticTraceScopeState();
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

/** Formats a diagnostic trace context as a W3C `traceparent` header. */
export function formatDiagnosticTraceparent(
  context: DiagnosticTraceContext | undefined,
): string | undefined {
  if (!context?.spanId) {
    return undefined;
  }
  const traceId = normalizeTraceId(context.traceId);
  const spanId = normalizeSpanId(context.spanId);
  const traceFlags = normalizeTraceFlags(context.traceFlags) ?? DEFAULT_TRACE_FLAGS;
  if (!traceId || !spanId) {
    return undefined;
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${traceFlags}`;
}

/** Creates a normalized trace context from explicit fields, traceparent, or generated ids. */
export function createDiagnosticTraceContext(
  input: DiagnosticTraceContextInput = {},
): DiagnosticTraceContext {
  const parsed = parseDiagnosticTraceparent(input.traceparent);
  const traceId = normalizeTraceId(input.traceId) ?? parsed?.traceId ?? randomTraceId();
  const explicitSpanId = normalizeSpanId(input.spanId);
  const spanId = explicitSpanId ?? parsed?.spanId ?? randomSpanId();
  const parentSpanId = normalizeSpanId(input.parentSpanId);
  const spanIdSource =
    input.spanIdSource === "remote" || (!explicitSpanId && parsed?.spanId) ? "remote" : undefined;
  const parentSpanIdSource = input.parentSpanIdSource === "remote" ? "remote" : undefined;
  return {
    traceId,
    spanId,
    ...(parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {}),
    traceFlags: normalizeTraceFlags(input.traceFlags) ?? parsed?.traceFlags ?? DEFAULT_TRACE_FLAGS,
    ...(spanIdSource ? { spanIdSource } : {}),
    ...(parentSpanIdSource && parentSpanId && parentSpanId !== spanId
      ? { parentSpanIdSource }
      : {}),
  };
}

/** Creates a child context that preserves the parent trace id and records the parent span id. */
export function createChildDiagnosticTraceContext(
  parent: DiagnosticTraceContext,
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const parentSpanId = normalizeSpanId(input.parentSpanId) ?? normalizeSpanId(parent.spanId);
  return createDiagnosticTraceContext({
    traceId: parent.traceId,
    spanId: input.spanId,
    parentSpanId,
    traceFlags: input.traceFlags ?? parent.traceFlags,
    parentSpanIdSource: input.parentSpanIdSource ?? parent.spanIdSource,
  });
}

/** Creates a child of the active trace scope, or a new root context when no scope is active. */
export function createDiagnosticTraceContextFromActiveScope(
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const active = getActiveDiagnosticTraceContext();
  if (!active) {
    return createDiagnosticTraceContext(input);
  }
  return createChildDiagnosticTraceContext(active, input);
}

/** Returns an immutable defensive copy of a trace context. */
export function freezeDiagnosticTraceContext(
  context: DiagnosticTraceContext,
): DiagnosticTraceContext {
  return Object.freeze({
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
    ...(context.traceFlags ? { traceFlags: context.traceFlags } : {}),
    ...(context.spanIdSource ? { spanIdSource: context.spanIdSource } : {}),
    ...(context.parentSpanIdSource ? { parentSpanIdSource: context.parentSpanIdSource } : {}),
  });
}

/** Returns the trace context bound to the current async scope. */
export function getActiveDiagnosticTraceContext(): DiagnosticTraceContext | undefined {
  return getDiagnosticTraceScopeState().storage.getStore();
}

export function formatActiveDiagnosticTraceparent(): string | undefined {
  return formatDiagnosticTraceparent(getActiveDiagnosticTraceContext());
}

/** Runs a callback with a frozen trace context bound to async-local storage. */
export function runWithDiagnosticTraceContext<T>(
  trace: DiagnosticTraceContext,
  callback: () => T,
): T {
  return getDiagnosticTraceScopeState().storage.run(freezeDiagnosticTraceContext(trace), callback);
}

export function runWithDiagnosticTraceparent<T>(
  traceparent: string | undefined,
  callback: () => T,
): T {
  const parsed = parseDiagnosticTraceparent(traceparent);
  if (!parsed?.spanId) {
    return callback();
  }
  return runWithDiagnosticTraceContext(createDiagnosticTraceContext({ traceparent }), callback);
}

/** Clears async-local trace context state between tests. */
export function resetDiagnosticTraceContextForTest(): void {
  getDiagnosticTraceScopeState().storage.disable();
}
