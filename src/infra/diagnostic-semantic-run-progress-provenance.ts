type CoreSemanticRunProgressEvent = { type: "run.progress" };

type CoreSemanticRunProgressProvenanceState = {
  marker: symbol;
  events: WeakSet<object>;
};

export const CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY = "coreSemanticRunProgress";

const STATE_KEY = Symbol.for("openclaw.diagnosticSemanticRunProgressProvenance.state.v1");

function getProvenanceState(): CoreSemanticRunProgressProvenanceState {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const existing = globals[STATE_KEY] as CoreSemanticRunProgressProvenanceState | undefined;
  if (existing?.marker === STATE_KEY) {
    return existing;
  }
  const state: CoreSemanticRunProgressProvenanceState = {
    marker: STATE_KEY,
    events: new WeakSet<object>(),
  };
  globals[STATE_KEY] = state;
  return state;
}

// Exact object identity is the core-only authority; payload fields cannot forge it.
export function markCoreSemanticRunProgressDiagnosticEvent<T extends CoreSemanticRunProgressEvent>(
  event: T,
): T {
  getProvenanceState().events.add(event);
  return event;
}

export function consumeCoreSemanticRunProgressDiagnosticEvent(event: object): boolean {
  const events = getProvenanceState().events;
  const marked = events.has(event);
  events.delete(event);
  return marked;
}
