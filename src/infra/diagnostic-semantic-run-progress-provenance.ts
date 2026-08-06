type CoreSemanticRunProgressEvent = { type: "run.progress" };

export const CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY = "coreSemanticRunProgress";

const coreSemanticRunProgressEvents = new WeakSet<object>();

// Exact object identity is the core-only authority; payload fields cannot forge it.
export function markCoreSemanticRunProgressDiagnosticEvent<T extends CoreSemanticRunProgressEvent>(
  event: T,
): T {
  coreSemanticRunProgressEvents.add(event);
  return event;
}

export function consumeCoreSemanticRunProgressDiagnosticEvent(event: object): boolean {
  const marked = coreSemanticRunProgressEvents.has(event);
  coreSemanticRunProgressEvents.delete(event);
  return marked;
}
