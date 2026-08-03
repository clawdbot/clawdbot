/** Process-wide listener counts used to avoid telemetry work without consumers. */

const DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY = Symbol.for(
  "openclaw.diagnosticEventListenerPresence.v1",
);

type DiagnosticEventListenerPresence = {
  marker: symbol;
  internalCount: number;
  trustedCount: number;
};

function getDiagnosticEventListenerPresence(): DiagnosticEventListenerPresence {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    (existing as Partial<DiagnosticEventListenerPresence>).marker ===
      DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY
  ) {
    return existing as DiagnosticEventListenerPresence;
  }
  const state: DiagnosticEventListenerPresence = {
    marker: DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY,
    internalCount: 0,
    trustedCount: 0,
  };
  Object.defineProperty(globalThis, DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

export function setInternalDiagnosticEventListenerCounts(
  internalCount: number,
  trustedCount: number,
): void {
  const state = getDiagnosticEventListenerPresence();
  state.internalCount = internalCount;
  state.trustedCount = trustedCount;
}

export function hasInternalDiagnosticEventListeners(): boolean {
  const state = getDiagnosticEventListenerPresence();
  return state.internalCount > 0 || state.trustedCount > 0;
}
