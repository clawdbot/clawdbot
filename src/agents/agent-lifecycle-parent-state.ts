/** Shared classification for an ended model turn whose parent task is still waiting. */
type AgentLifecycleParentStateEvent = {
  phase?: unknown;
  yielded?: unknown;
  livenessState?: unknown;
  stopReason?: unknown;
  aborted?: unknown;
  status?: unknown;
  timeoutPhase?: unknown;
  error?: unknown;
};

export function isAgentLifecycleYieldedWaiting(event: AgentLifecycleParentStateEvent): boolean {
  return (
    event.phase === "end" &&
    event.yielded === true &&
    event.livenessState === "paused" &&
    event.stopReason === "end_turn" &&
    event.aborted !== true &&
    event.status !== "cancelled" &&
    event.status !== "timed_out" &&
    event.timeoutPhase == null &&
    event.error == null
  );
}
