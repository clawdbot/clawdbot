import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "./agent-run-registry.js";

export function isAgentRunWaitingForCapacity(runId: string): boolean {
  const context = getAgentRunContext(runId);
  return (
    context !== undefined &&
    context.lifecycleGeneration === getAgentRunLifecycleGeneration() &&
    (context.capacityWaits?.size ?? 0) > 0
  );
}

/** Records a scheduler-owned wait and releases only the exact captured run instance. */
export function registerAgentRunCapacityWait(
  runId: string,
  lifecycleGeneration: string,
): (() => void) | undefined {
  const context = getAgentRunContext(runId);
  if (
    !context ||
    context.lifecycleGeneration !== lifecycleGeneration ||
    lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    return undefined;
  }
  const waits = (context.capacityWaits ??= new Set());
  const token = Symbol("agent-run-capacity-wait");
  const publish = () => {
    if (
      context.sessionKey &&
      context.projectSessionLifecycle !== false &&
      context.projectSessionActive !== false
    ) {
      emitSessionLifecycleEvent({
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        reason: "run-capacity",
      });
    }
  };
  waits.add(token);
  if (waits.size === 1) {
    publish();
  }
  return () => {
    // Queue cancellation and lifecycle rotation can outlive a recycled run id.
    // A stale callback must never publish or clear a replacement's wait state.
    if (
      getAgentRunContext(runId) !== context ||
      context.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
      !waits.delete(token) ||
      waits.size > 0
    ) {
      return;
    }
    delete context.capacityWaits;
    publish();
  };
}
