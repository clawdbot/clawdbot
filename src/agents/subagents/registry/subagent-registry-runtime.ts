export async function replaceSubagentRunAfterSteer(
  params: Parameters<typeof import("./subagent-registry.js").replaceSubagentRunAfterSteerCore>[0],
) {
  return (await import("./subagent-registry.js")).replaceSubagentRunAfterSteerCore(params);
}

export async function recordAcceptedRunTermination(
  ...args: Parameters<typeof import("./subagent-registry.js").recordAcceptedRunTermination>
) {
  return (await import("./subagent-registry.js")).recordAcceptedRunTermination(...args);
}

export async function markAcceptedRunTerminationPending(
  ...args: Parameters<typeof import("./subagent-registry.js").markAcceptedRunTerminationPending>
) {
  return (await import("./subagent-registry.js")).markAcceptedRunTerminationPending(...args);
}

export async function completeAcceptedRunTermination(
  ...args: Parameters<typeof import("./subagent-registry.js").completeAcceptedRunTermination>
) {
  return (await import("./subagent-registry.js")).completeAcceptedRunTermination(...args);
}

export async function scheduleSubagentRegistrySweep(
  ...args: Parameters<typeof import("./subagent-registry.js").scheduleSubagentRegistrySweep>
) {
  return (await import("./subagent-registry.js")).scheduleSubagentRegistrySweep(...args);
}
