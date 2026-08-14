export type CoreModelRequestOwnerGeneration = object;

type CoreModelRequestLifecycleEvent = {
  type: "model.call.started" | "model.call.completed" | "model.call.error";
};

export type CoreModelRequestLifecycleProvenance = Readonly<{
  generation: CoreModelRequestOwnerGeneration;
  phase: "started" | "ended";
}>;

export const CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY = "coreModelRequestLifecycle";

const coreModelRequestLifecycleEvents = new WeakMap<object, CoreModelRequestLifecycleProvenance>();

// Exact event and generation identity are core-only authority; payload fields cannot forge either.
export function markCoreModelRequestLifecycleDiagnosticEvent<
  T extends CoreModelRequestLifecycleEvent,
>(event: T, provenance: CoreModelRequestLifecycleProvenance): T {
  coreModelRequestLifecycleEvents.set(event, provenance);
  return event;
}

export function consumeCoreModelRequestLifecycleDiagnosticEvent(
  event: object,
): CoreModelRequestLifecycleProvenance | undefined {
  const provenance = coreModelRequestLifecycleEvents.get(event);
  coreModelRequestLifecycleEvents.delete(event);
  return provenance;
}
