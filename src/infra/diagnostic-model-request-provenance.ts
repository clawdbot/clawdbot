type CoreModelRequestStartedEvent = { type: "model.call.started" };

export const CORE_MODEL_REQUEST_STARTED_METADATA_KEY = "coreModelRequestStarted";

const coreModelRequestStartedEvents = new WeakSet<object>();

// Exact object identity is the core-only authority; payload fields cannot forge it.
export function markCoreModelRequestStartedDiagnosticEvent<T extends CoreModelRequestStartedEvent>(
  event: T,
): T {
  coreModelRequestStartedEvents.add(event);
  return event;
}

export function consumeCoreModelRequestStartedDiagnosticEvent(event: object): boolean {
  const marked = coreModelRequestStartedEvents.has(event);
  coreModelRequestStartedEvents.delete(event);
  return marked;
}
