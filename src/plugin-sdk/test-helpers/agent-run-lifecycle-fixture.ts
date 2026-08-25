export async function beginReplyOperationLifecycleFixture(params: {
  sessionKey: string;
  sessionId: string;
}) {
  const { markReplyOperationExecutionStarted, replyRunRegistry } =
    await import("../../auto-reply/reply/reply-run-registry.js");
  const operation = replyRunRegistry.begin({ ...params, resetTriggered: false });
  return {
    complete: () => operation.complete(),
    markExecutionStarted: () => markReplyOperationExecutionStarted(operation),
  };
}

export async function resolveAgentRunProgressStateForTest(sessionId: string) {
  const { resolveEmbeddedAgentRunProgressState } =
    await import("../../agents/embedded-agent-runner/runs.js");
  return resolveEmbeddedAgentRunProgressState(sessionId);
}
