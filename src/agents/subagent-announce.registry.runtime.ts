/**
 * Runtime barrel for subagent announce registry helpers. Announce delivery
 * imports this narrow surface so tests can replace registry behavior without
 * loading the full persistence layer.
 */
export {
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  countPendingDescendantRunsExcludingRun,
  getLatestSubagentRunByChildSessionKey,
  hasDescendantRunAwaitingSettle,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  replaceSubagentRunAfterSteer,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-runtime.js";
