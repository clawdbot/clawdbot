import { afterEach, describe, expect, it } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  claimAgentRunContext,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  sweepStaleRunContexts,
} from "../../infra/agent-events.js";
import {
  clearActiveEmbeddedRun,
  clearSessionsSendTargetBlocksForRun,
  isSessionsSendTargetBlockedForActiveRun,
  retainSessionsSendTargetBlockForActiveRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

function createRunHandle(runId?: string): EmbeddedAgentQueueHandle {
  return {
    runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded run sessions_send target blocks", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetAgentEventsForTest({ preserveListeners: true });
  });

  it("preserves blocks across replacement handles without a run id", () => {
    const firstHandle = createRunHandle();
    const replacementHandle = createRunHandle();
    setActiveEmbeddedRun("session-replaced", firstHandle);
    const release = retainSessionsSendTargetBlockForActiveRun({
      sessionId: "session-replaced",
      targetSessionKey: "global",
    });

    setActiveEmbeddedRun("session-replaced", replacementHandle);

    const isBlocked = () =>
      isSessionsSendTargetBlockedForActiveRun({
        sessionId: "session-replaced",
        targetSessionKey: "agent:requester:main",
        matchesSessionKey: (blockedSessionKey, targetSessionKey) =>
          blockedSessionKey === "global" && targetSessionKey === "agent:requester:main",
      });
    expect(isBlocked()).toBe(true);
    release?.();
    expect(isBlocked()).toBe(false);
  });

  it("preserves run-owned blocks across context sweep and attempt cleanup", () => {
    const runId = "run-retry";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(runId, { lifecycleGeneration, registeredAt: 1 });
    const firstHandle = createRunHandle(runId);
    setActiveEmbeddedRun("session-retry", firstHandle);
    retainSessionsSendTargetBlockForActiveRun({
      sessionId: "session-retry",
      targetSessionKey: "agent:requester:main",
    });

    expect(sweepStaleRunContexts(0)).toBe(1);
    clearActiveEmbeddedRun("session-retry", firstHandle);
    const replacementHandle = createRunHandle(runId);
    setActiveEmbeddedRun("session-retry", replacementHandle);

    expect(
      isSessionsSendTargetBlockedForActiveRun({
        sessionId: "session-retry",
        targetSessionKey: "agent:requester:main",
      }),
    ).toBe(true);

    clearSessionsSendTargetBlocksForRun(runId);
    expect(
      isSessionsSendTargetBlockedForActiveRun({
        sessionId: "session-retry",
        targetSessionKey: "agent:requester:main",
      }),
    ).toBe(false);
  });

  it("keeps blocks on the reply lifecycle across retry attempts", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:worker:main",
      sessionId: "session-retry",
      resetTriggered: false,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun("session-retry", createRunHandle(), "agent:worker:main");
    retainSessionsSendTargetBlockForActiveRun({
      sessionId: "session-retry",
      targetSessionKey: "agent:requester:main",
    });

    setActiveEmbeddedRun("session-retry", createRunHandle(), "agent:worker:main");

    expect(
      isSessionsSendTargetBlockedForActiveRun({
        sessionId: "session-retry",
        targetSessionKey: "agent:requester:main",
      }),
    ).toBe(true);
    operation.complete();
  });
});
