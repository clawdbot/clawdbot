import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as deliveryTesting } from "../subagents/announce/subagent-announce-delivery.test-support.js";
import { sendSubagentAnnounceDirectly } from "../subagents/announce/subagent-announce-direct-delivery.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  markActiveEmbeddedRunAbandoned,
  markEmbeddedRunRecoveringTimeout,
  restoreEmbeddedRunTimeoutAbandonment,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing as runsTesting } from "./runs.test-support.js";

const sessionId = "session-timeout-delivery";
const sessionKey = "agent:main:timeout-delivery";

function sendCompletion() {
  return sendSubagentAnnounceDirectly({
    requesterSessionKey: sessionKey,
    targetRequesterSessionKey: sessionKey,
    triggerMessage: "child completed",
    expectsCompletionMessage: true,
    requesterIsSubagent: true,
    directIdempotencyKey: "timeout-recovery-completion",
  });
}

describe("timeout recovery completion delivery", () => {
  afterEach(() => {
    deliveryTesting.setDepsForTest();
    runsTesting.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("defers during recovery, delivers to the successor, and restores terminal suppression", async () => {
    const dispatchGatewayMethodInProcess = vi.fn();
    deliveryTesting.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRuntimeConfig: () => ({}) as never,
      getRequesterSessionActivity: () => ({
        sessionId,
        isActive: isEmbeddedAgentRunActive(sessionId),
      }),
      loadRequesterSessionEntry: (requestedKey) => ({
        cfg: {} as never,
        entry: undefined,
        canonicalKey: requestedKey,
        agentId: "main",
      }),
    });

    const timedOutHandle = createEmbeddedRunHandle({ runId: "run-timeout" });
    setActiveEmbeddedRun(sessionId, timedOutHandle, sessionKey);
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId,
        handle: timedOutHandle,
        sessionKey,
        reason: "timeout",
      }),
    ).toBe(true);
    clearActiveEmbeddedRun(sessionId, timedOutHandle, sessionKey);

    const marker = markEmbeddedRunRecoveringTimeout({ sessionId, runId: "run-timeout" });
    expect(marker).toBeDefined();
    await expect(sendCompletion()).resolves.toMatchObject({
      delivered: false,
      path: "none",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    });
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();

    const queueMessage = vi.fn(async () => undefined);
    const successorHandle = createEmbeddedRunHandle({
      runId: "run-successor",
      queueMessage,
      supportsTranscriptCommitWait: true,
    });
    setActiveEmbeddedRun(sessionId, successorHandle, sessionKey);
    await expect(sendCompletion()).resolves.toMatchObject({ delivered: true, path: "steered" });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();

    clearActiveEmbeddedRun(sessionId, successorHandle, sessionKey);
    const replacementHandle = createEmbeddedRunHandle({ runId: "run-terminal" });
    setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId,
        handle: replacementHandle,
        sessionKey,
        reason: "timeout",
      }),
    ).toBe(true);
    clearActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    const terminalMarker = markEmbeddedRunRecoveringTimeout({
      sessionId,
      runId: "run-terminal",
    });
    expect(terminalMarker).toBeDefined();
    expect(restoreEmbeddedRunTimeoutAbandonment(terminalMarker!)).toBe(true);
    await expect(sendCompletion()).resolves.toMatchObject({
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
    });
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });
});
