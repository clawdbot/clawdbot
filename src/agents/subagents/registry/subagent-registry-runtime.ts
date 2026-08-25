export async function replaceSubagentRunAfterSteer(
  params: Parameters<typeof import("./subagent-registry.js").replaceSubagentRunAfterSteerCore>[0],
) {
  return (await import("./subagent-registry.js")).replaceSubagentRunAfterSteerCore(params);
}
