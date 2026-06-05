// Subagent session reactivation helper.
// Replaces completed subagent run records when a user steers the child session.
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";

// Completed subagent sessions can be reactivated after a user steer by replacing
// the previous completed run id with the next run id through a lazy runtime
// import. Active subagent runs are never replaced here.
async function loadSessionSubagentReactivationRuntime() {
  return import("./session-subagent-reactivation.runtime.js");
}

/** Reactivates a completed subagent session by swapping in the new run id. */
export async function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const existing = getLatestSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  const { replaceSubagentRunAfterSteer } = await loadSessionSubagentReactivationRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
}
