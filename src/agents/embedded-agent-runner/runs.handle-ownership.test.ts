import { describe, expect, it } from "vitest";
import {
  markReplyOperationExecutionStarted,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  clearActiveEmbeddedRun,
  resolveActiveEmbeddedRunSessionId,
  resolveEmbeddedAgentRunProgressState,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";

describe("embedded run execution ownership", () => {
  it("keeps pre-dispatch reply ownership queued until execution actually starts", () => {
    const sessionKey = "agent:main:bind-source";
    const sessionId = "bind-source-session";
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });

    try {
      expect(resolveActiveEmbeddedRunSessionId(sessionKey)).toBe(sessionId);
      expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("queued");

      markReplyOperationExecutionStarted(operation);
      expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
    } finally {
      operation.complete();
    }
  });

  it("reports a concrete embedded run handle as running", () => {
    const sessionKey = "agent:main:active-source";
    const sessionId = "active-source-session";
    const handle = {
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => undefined,
    } satisfies EmbeddedAgentQueueHandle;

    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    try {
      expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });
});
