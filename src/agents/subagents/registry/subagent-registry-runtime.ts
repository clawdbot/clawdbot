export {
  countActiveDescendantRuns,
  getLatestSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
export {
  countPendingDescendantRuns,
  countPendingDescendantRunsExcludingRun,
  hasDescendantRunAwaitingSettle,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-announce-read.js";

export async function replaceSubagentRunAfterSteer(
  params: Parameters<typeof import("./subagent-registry.js").replaceSubagentRunAfterSteerCore>[0],
) {
  return (await import("./subagent-registry.js")).replaceSubagentRunAfterSteerCore(params);
}
