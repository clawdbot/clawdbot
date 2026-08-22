import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCopilotActiveRun } from "./attempt-active-run.js";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { SessionLike } from "./event-bridge.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";

const harnessMocks = vi.hoisted(() => ({
  cancelPendingAgentQuestionForSession: vi.fn(async () => false),
  claimPendingAgentQuestionAnswer: vi.fn(async () => false),
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    cancelPendingAgentQuestionForSession: harnessMocks.cancelPendingAgentQuestionForSession,
    claimPendingAgentQuestionAnswer: harnessMocks.claimPendingAgentQuestionAnswer,
    setActiveEmbeddedRun: harnessMocks.setActiveEmbeddedRun,
  };
});

function registerTestRun(params?: {
  canAcceptSteering?: () => boolean;
  receipt?: Promise<void>;
  send?: SessionLike["send"];
}) {
  const send = params?.send ?? vi.fn(async () => "steer-1");
  const waitForSdkUserPersisted = vi.fn(() => params?.receipt ?? Promise.resolve());
  const session: SessionLike = {
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn() as SessionLike["on"],
    send,
    sendAndWait: vi.fn(async () => undefined),
  };
  const handle = registerCopilotActiveRun({
    abortActiveSession: vi.fn(),
    bridge: undefined,
    canAcceptSteering: params?.canAcceptSteering ?? (() => true),
    input: { runId: "run-1", sessionId: "session-1" } as AttemptParamsLike,
    isAborted: () => false,
    isSettled: () => false,
    session,
    transcriptJournal: { waitForSdkUserPersisted } as unknown as AttemptTranscriptJournal,
    userInputBridge: {
      cancelPending: vi.fn(),
      onUserInputRequest: vi.fn(),
    } as unknown as CopilotUserInputBridge,
  });
  return { handle, send, waitForSdkUserPersisted };
}

describe("registerCopilotActiveRun", () => {
  beforeEach(() => {
    harnessMocks.cancelPendingAgentQuestionForSession.mockClear();
    harnessMocks.claimPendingAgentQuestionAnswer.mockReset();
    harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValue(false);
    harnessMocks.setActiveEmbeddedRun.mockClear();
  });

  it("reports acceptance after send while the transcript receipt is still pending", async () => {
    const receipt = createDeferred<void>();
    const onQueueAccepted = vi.fn();
    const { handle, send, waitForSdkUserPersisted } = registerTestRun({
      receipt: receipt.promise,
    });

    let deliverySettled = false;
    const delivery = handle
      .queueMessage("change course", { onQueueAccepted, waitForTranscriptCommit: true })
      .then(() => {
        deliverySettled = true;
      });

    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    expect(send).toHaveBeenCalledWith({ prompt: "change course" });
    expect(waitForSdkUserPersisted).toHaveBeenCalledWith("steer-1");
    expect(deliverySettled).toBe(false);

    receipt.resolve();
    await expect(delivery).resolves.toBeUndefined();
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });

  it("reports a claimed pending question as accepted without sending steering", async () => {
    harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValueOnce(true);
    const onQueueAccepted = vi.fn();
    const { handle, send } = registerTestRun();

    await expect(
      handle.queueMessage("answer", { isInboundUserMessage: true, onQueueAccepted }),
    ).resolves.toBeUndefined();

    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("exposes pending-question cancellation for queued image fallback", async () => {
    const { handle } = registerTestRun();

    await expect(handle.cancelPendingUserInput?.("image-reply")).resolves.toBe(false);

    expect(harnessMocks.cancelPendingAgentQuestionForSession).toHaveBeenCalledWith({
      sessionKey: "session-1",
      resolvedBy: "image-reply",
    });
  });

  it("reports pre-ownership validation failure as rejected", async () => {
    const onQueueAccepted = vi.fn();
    const { handle, send } = registerTestRun({ canAcceptSteering: () => false });

    await expect(handle.queueMessage("too early", { onQueueAccepted })).rejects.toThrow(
      "unavailable before initial user validation",
    );

    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a rejected send as rejected", async () => {
    const onQueueAccepted = vi.fn();
    const sendError = new Error("send rejected");
    const { handle } = registerTestRun({
      send: vi.fn(async () => {
        throw sendError;
      }),
    });

    await expect(handle.queueMessage("change course", { onQueueAccepted })).rejects.toBe(sendError);
    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
  });

  it("keeps acceptance irrevocable when transcript confirmation fails", async () => {
    const receipt = createDeferred<void>();
    const onQueueAccepted = vi.fn();
    const { handle } = registerTestRun({ receipt: receipt.promise });
    const delivery = handle.queueMessage("change course", {
      onQueueAccepted,
      waitForTranscriptCommit: true,
    });

    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    receipt.reject(new Error("journal failed"));

    await expect(delivery).resolves.toEqual({
      transcriptCommit: "unconfirmed",
      errorMessage: "journal failed",
    });
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });
});
