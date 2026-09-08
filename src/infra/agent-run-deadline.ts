// Process-local hook that lets a run's owner extend the whole-run deadline when
// a new model fallback candidate actually starts.
//
// The fallback loop lives in `src/agents` and cannot see the gateway's abort
// registry, so the owner registers a renewer here and the loop asks for a fresh
// budget by run id. Runs without a registered owner (CLI, cron, tests) get a
// no-op, which keeps the loop's behavior unchanged outside the gateway.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Returns true when the owner actually extended the deadline. */
export type AgentRunDeadlineRenewer = () => boolean;

type AgentRunDeadlineState = {
  renewers: Map<string, AgentRunDeadlineRenewer>;
};

const AGENT_RUN_DEADLINE_STATE_KEY = Symbol.for("openclaw.agentRunDeadline.state");

function getAgentRunDeadlineState(): AgentRunDeadlineState {
  return resolveGlobalSingleton<AgentRunDeadlineState>(AGENT_RUN_DEADLINE_STATE_KEY, () => ({
    renewers: new Map<string, AgentRunDeadlineRenewer>(),
  }));
}

/**
 * Registers the owner allowed to extend `runId`'s whole-run deadline. The
 * returned disposer only clears the registration it created, so a same-run
 * successor registration is never dropped by a late cleanup.
 */
export function registerAgentRunDeadlineRenewer(
  runId: string,
  renew: AgentRunDeadlineRenewer,
): () => void {
  const state = getAgentRunDeadlineState();
  state.renewers.set(runId, renew);
  return () => {
    if (state.renewers.get(runId) === renew) {
      state.renewers.delete(runId);
    }
  };
}

/** Clears the registration owning `runId`, if any. */
export function unregisterAgentRunDeadlineRenewer(runId: string): void {
  getAgentRunDeadlineState().renewers.delete(runId);
}

/**
 * Asks the run owner for a fresh budget for an attempt that is about to start.
 * Returns false when no owner is registered or the owner declined; a declined
 * renewal is never fatal, the attempt still runs under the existing deadline.
 */
export function renewAgentRunDeadline(runId: string | undefined): boolean {
  if (!runId) {
    return false;
  }
  const renew = getAgentRunDeadlineState().renewers.get(runId);
  if (!renew) {
    return false;
  }
  try {
    return renew();
  } catch {
    // A failing owner hook must not abort the attempt it was meant to protect.
    return false;
  }
}

export function resetAgentRunDeadlineRenewersForTest(): void {
  getAgentRunDeadlineState().renewers.clear();
}
