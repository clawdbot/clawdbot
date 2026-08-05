import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "./diagnostic-events.js";
import {
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

export type DiagnosticTracePropagationBridge = Readonly<{
  /** Prepares exporter-owned state before an outbound caller can resolve it. */
  prepareEvent?: (
    event: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => void;
  /** Translates a diagnostic correlation context to an exporter-owned context. */
  resolveTraceContext: (traceContext: DiagnosticTraceContext) => DiagnosticTraceContext | undefined;
}>;

type DiagnosticTracePropagationResolution =
  | { active: false }
  | { active: true; traceContext: DiagnosticTraceContext | undefined };

type DiagnosticTracePropagationState = {
  marker: symbol;
  bridges: Set<DiagnosticTracePropagationBridge>;
};

const DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY = Symbol.for(
  "openclaw.diagnosticTracePropagation.state.v1",
);

function createDiagnosticTracePropagationState(): DiagnosticTracePropagationState {
  return {
    marker: DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY,
    bridges: new Set(),
  };
}

function isDiagnosticTracePropagationState(
  value: unknown,
): value is DiagnosticTracePropagationState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticTracePropagationState>;
  return (
    candidate.marker === DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY && candidate.bridges instanceof Set
  );
}

function getDiagnosticTracePropagationState(): DiagnosticTracePropagationState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY];
  if (isDiagnosticTracePropagationState(existing)) {
    return existing;
  }
  const state = createDiagnosticTracePropagationState();
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

function activeDiagnosticTracePropagationBridge(): DiagnosticTracePropagationBridge | undefined {
  return Array.from(getDiagnosticTracePropagationState().bridges).at(-1);
}

export function registerDiagnosticTracePropagationBridge(
  bridge: DiagnosticTracePropagationBridge,
): () => void {
  const state = getDiagnosticTracePropagationState();
  state.bridges.add(bridge);
  return () => {
    state.bridges.delete(bridge);
  };
}

export function prepareDiagnosticTracePropagation(
  event: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
  privateData: DiagnosticEventPrivateData,
): void {
  const bridge = activeDiagnosticTracePropagationBridge();
  if (!bridge?.prepareEvent) {
    return;
  }
  try {
    bridge.prepareEvent(event, metadata, privateData);
  } catch (error) {
    console.error(
      `[diagnostic-trace-propagation] prepare error type=${event.type} seq=${event.seq}: ${String(error)}`,
    );
  }
}

function resolveDiagnosticTraceContextForPropagation(
  traceContext: DiagnosticTraceContext,
): DiagnosticTracePropagationResolution {
  const bridge = activeDiagnosticTracePropagationBridge();
  if (!bridge) {
    return { active: false };
  }
  try {
    return {
      active: true,
      traceContext: bridge.resolveTraceContext(traceContext),
    };
  } catch (error) {
    // An active exporter owns propagation. Falling back to diagnostic ids here
    // would name a parent span that the exporter never created.
    console.error(`[diagnostic-trace-propagation] resolve error: ${String(error)}`);
    return { active: true, traceContext: undefined };
  }
}

/** Formats the exporter-owned context when one is active, suppressing unresolved identities. */
export function formatPropagatedDiagnosticTraceparent(
  traceContext: DiagnosticTraceContext | undefined,
): string | undefined {
  if (!traceContext) {
    return undefined;
  }
  const resolution = resolveDiagnosticTraceContextForPropagation(traceContext);
  return formatDiagnosticTraceparent(resolution.active ? resolution.traceContext : traceContext);
}

export function resetDiagnosticTracePropagationForTest(): void {
  getDiagnosticTracePropagationState().bridges.clear();
}
