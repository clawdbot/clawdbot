import { describe, expect, it, vi } from "vitest";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";

describe("createChatSendDispatchErrorLifecycle", () => {
  it("terminalizes an admitted queued followup as successful despite later dispatch failure", async () => {
    const broadcast = vi.fn();
    const cleanupAdmittedRun = vi.fn();
    const removeChatRun = vi.fn();
    const warn = vi.fn();
    const dedupe = new Map();
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        activeRunAbort: {
          cleanup: vi.fn(),
          controller: new AbortController(),
          entry: undefined,
          registered: true,
        } as never,
        cleanupAdmittedRun,
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatAbortedRuns: new Set(),
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn },
        nodeSendToSession: vi.fn(),
        removeChatRun,
      } as never,
      isQueuedFollowupEnqueued: () => true,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-1",
        now: 1,
        rawSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
      userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
    });

    await lifecycle.handleError(new Error("late failure"));
    lifecycle.finalize();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dispatch failed after followup queue admission"),
    );
    expect(dedupe.get("chat:run-1")).toMatchObject({
      ok: true,
      payload: { runId: "run-1", status: "ok" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "final" }),
      { sessionKeys: ["agent:main:main"] },
    );
    expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
    expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "agent:main:main");
  });
});
