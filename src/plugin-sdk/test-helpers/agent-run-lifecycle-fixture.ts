import { resolveEmbeddedAgentRunProgressState } from "../../agents/embedded-agent-runner/runs.js";
import {
  markReplyOperationExecutionStarted,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";

export function beginReplyOperationLifecycleFixture(params: {
  sessionKey: string;
  sessionId: string;
}) {
  const operation = replyRunRegistry.begin({ ...params, resetTriggered: false });
  return {
    complete: () => operation.complete(),
    markExecutionStarted: () => markReplyOperationExecutionStarted(operation),
  };
}

export const resolveAgentRunProgressStateForTest = resolveEmbeddedAgentRunProgressState;
