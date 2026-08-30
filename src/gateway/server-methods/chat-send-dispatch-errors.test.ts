import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
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
        chatRunState: createChatRunState(),
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
    await lifecycle.finalize();

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

  it("preserves an explicitly aborted terminal when its dispatch later rejects", async () => {
    const runId = "explicit-abort-before-dispatch-rejection";
    const sessionKey = "agent:main:main";
    const chatAbortControllers = new Map();
    const chatRunState = createChatRunState();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: "sess-main",
      sessionKey,
      timeoutMs: 60_000,
    });
    const entry = registration.entry;
    const removeChatRun = vi.fn();
    const broadcast = vi.fn();
    const dedupe = new Map();
    const warn = vi.fn();
    const terminalizeRestartSafeAdmission = vi.fn();
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
        return;
      }
      const current = chatAbortControllers.get(runId);
      if (current) {
        current.projectSessionTerminalPending = true;
        current.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      expect(
        abortChatRunById(
          {
            chatAbortControllers,
            chatRunState,
            removeChatRun,
            agentRunSeq: new Map(),
            broadcast,
            nodeSendToSession: vi.fn(),
          },
          { runId, sessionKey },
        ),
      ).toEqual({ aborted: true });

      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: registration.cleanup,
          lifecycleGeneration: "test-generation",
          restartSafeAdmission: {} as never,
        },
        context: {
          agentRunSeq: new Map(),
          broadcast,
          chatRunState,
          dedupe,
          getRuntimeConfig: () => ({}),
          logGateway: { warn },
          nodeSendToSession: vi.fn(),
          removeChatRun,
        } as never,
        isQueuedFollowupEnqueued: () => false,
        persistUserTurnTranscript: vi.fn(),
        session: {
          agentId: "main",
          backingSessionId: "sess-main",
          cfg: {},
          clientRunId: runId,
          now: 1,
          rawSessionKey: sessionKey,
          sessionKey,
        },
        terminalizeRestartSafeAdmission,
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
      await lifecycle.finalize();

      expect(dedupe.get(`chat:${runId}`)).toMatchObject({
        ok: true,
        payload: { runId, status: "timeout", summary: "aborted" },
      });
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error" }),
        expect.anything(),
      );
      expect(chatAbortControllers.get(runId)).toBe(entry);
      expect(entry).toMatchObject({
        projectSessionTerminalPending: true,
        registrationCleanupRequested: true,
      });
      expect(terminalizeRestartSafeAdmission).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      registration.cleanup();
    }
  });

  it("keeps a signal-only dispatch rejection as an error without an explicit abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("restart interrupted dispatch"));
    const chatRunState = createChatRunState();
    const dedupe = new Map();
    const broadcast = vi.fn();
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        activeRunAbort: {
          cleanup: vi.fn(),
          controller,
          entry: undefined,
          registered: true,
        } as never,
        cleanupAdmittedRun: vi.fn(),
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState,
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      isQueuedFollowupEnqueued: () => false,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: "sess-main",
        cfg: {},
        clientRunId: "signal-only-dispatch-rejection",
        now: 1,
        rawSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
      userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
    });

    await lifecycle.handleError(new Error("dispatch rejected after restart"));

    expect(dedupe.get("chat:signal-only-dispatch-rejection")).toMatchObject({
      ok: false,
      payload: { runId: "signal-only-dispatch-rejection", status: "error" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "signal-only-dispatch-rejection", state: "error" }),
      { sessionKeys: ["agent:main:main"] },
    );
  });

  it("does not overwrite a terminal already owned by the agent lifecycle", async () => {
    const runId = "agent-owned-terminal-before-dispatch-rejection";
    const sessionKey = "agent:main:main";
    const chatAbortControllers = new Map();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: "sess-main",
      sessionKey,
      timeoutMs: 60_000,
    });
    if (!registration.entry) {
      throw new Error("expected the chat abort controller to be registered");
    }
    registration.entry.projectSessionTerminalPersisted = true;
    const terminalEntry = {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok" as const },
    };
    const dedupe = new Map([[`chat:${runId}`, terminalEntry]]);
    const broadcast = vi.fn();
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        activeRunAbort: registration,
        cleanupAdmittedRun: registration.cleanup,
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState: createChatRunState(),
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      isQueuedFollowupEnqueued: () => false,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: "sess-main",
        cfg: {},
        clientRunId: runId,
        now: 1,
        rawSessionKey: sessionKey,
        sessionKey,
      },
      terminalizeRestartSafeAdmission: vi.fn(),
      userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
    });

    await lifecycle.handleError(new Error("dispatch rejected after agent terminal"));

    expect(dedupe.get(`chat:${runId}`)).toBe(terminalEntry);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId, state: "error" }),
      expect.anything(),
    );
  });

  it("keeps a failed non-default global send admitted through lifecycle persistence", async () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          list: [{ id: "main" }, { id: "ops" }],
        },
      },
      "main",
    );
    const persistenceEntered = createDeferred();
    const releasePersistence = createDeferred();
    const persistLifecycleEvent = vi
      .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
      .mockImplementation(async () => {
        persistenceEntered.resolve();
        await releasePersistence.promise;
      });
    const cleanupAdmittedRun = vi.fn();
    const activeRunCleanup = vi.fn();
    const clientRunId = "failed-ops-global-send";
    const chatAbortControllers = new Map([
      [
        "compat-owner-run",
        {
          controller: new AbortController(),
          sessionId: "sess-main",
          sessionKey: "global",
        },
      ],
    ]);

    try {
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: {
            cleanup: activeRunCleanup,
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
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          chatAbortControllers,
          chatRunState: createChatRunState(),
          dedupe: new Map(),
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
          logGateway: { warn: vi.fn() },
          nodeSendToSession: vi.fn(),
          removeChatRun: vi.fn(),
        } as never,
        isQueuedFollowupEnqueued: () => false,
        persistUserTurnTranscript: vi.fn(),
        session: {
          agentId: "ops",
          backingSessionId: "sess-ops",
          cfg,
          clientRunId,
          now: 1,
          rawSessionKey: "global",
          sessionKey: "global",
        },
        terminalizeRestartSafeAdmission: vi.fn(),
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("dispatch rejected"));
      const finalization = lifecycle.finalize();
      await persistenceEntered.promise;
      expect(persistLifecycleEvent).toHaveBeenCalledWith({
        sessionKey: "global",
        agentId: "ops",
        event: expect.objectContaining({
          runId: clientRunId,
          sessionId: "sess-ops",
          data: expect.objectContaining({ phase: "error" }),
        }),
      });
      expect(cleanupAdmittedRun).not.toHaveBeenCalled();
      releasePersistence.resolve();
      await finalization;
      expect(activeRunCleanup).toHaveBeenCalledExactlyOnceWith();
      expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
    } finally {
      releasePersistence.resolve();
      persistLifecycleEvent.mockRestore();
    }
  });
});
