export async function replaceSubagentRunAfterSteer(
  params: Parameters<typeof import("./subagent-registry.js").replaceSubagentRunAfterSteerCore>[0],
) {
  return (await import("./subagent-registry.js")).replaceSubagentRunAfterSteerCore(params);
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
