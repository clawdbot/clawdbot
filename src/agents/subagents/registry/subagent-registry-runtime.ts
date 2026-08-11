export {
  countActiveDescendantRuns,
  getLatestSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
export {
  countPendingDescendantRuns,
  countPendingDescendantRunsExcludingRun,
  hasDescendantRunAwaitingSettle,
  isSubagentSessionRunActive,
  listAncestorSessionKeys,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-announce-read.js";

export async function replaceSubagentRunAfterSteer(
  params: Parameters<typeof import("./subagent-registry.js").replaceSubagentRunAfterSteer>[0],
) {
  return (await import("./subagent-registry.js")).replaceSubagentRunAfterSteer(params);
}

export async function getSubagentRunByRunId(runId: string) {
  return (await import("./subagent-registry.js")).getSubagentRunByRunId(runId);
}

export async function recordAcceptedSubagentSteerDispatch(
  params: Parameters<
    typeof import("./subagent-registry.js").recordAcceptedSubagentSteerDispatch
  >[0],
) {
  return (await import("./subagent-registry.js")).recordAcceptedSubagentSteerDispatch(params);
}

export async function clearSubagentRunSteerRestart(
  ...args: Parameters<typeof import("./subagent-registry.js").clearSubagentRunSteerRestart>
) {
  return (await import("./subagent-registry.js")).clearSubagentRunSteerRestart(...args);
}
