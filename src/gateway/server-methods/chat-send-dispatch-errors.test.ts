import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import * as sessionRunError from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
import { broadcastChatDelta } from "./chat-broadcast.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import {
  createChatSendDispatchErrorLifecycle,
  handleChatSendSetupError,
} from "./chat-send-dispatch-errors.js";

describe("handleChatSendSetupError", () => {
  it("returns typed projection setup failures to the client retry owner without a terminal broadcast", async () => {
    const cleanupAdmittedRun = vi.fn();
    const clearRun = vi.fn();
    const broadcast = vi.fn();
    const respond = vi.fn();
    const dedupe = new Map();

    await handleChatSendSetupError({
      admission: {
        cleanupAdmittedRun,
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState: { clearRun },
        dedupe,
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      error: new SessionTranscriptProjectionUnavailableError("sess-main"),
      respond,
      session: {
        agentId: "main",
        clientRunId: "setup-projection-retry",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "setup-projection-retry", status: "error" }),
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true, retryAfterMs: 250 }),
      expect.anything(),
    );
    expect(dedupe.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
  });
});

describe("createChatSendDispatchErrorLifecycle", () => {
  it.each(["fallback", "restart-safe"])(
    "records the rejected input before its durable failure through %s settlement",
    async (settlement) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "dispatch-failure-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const runId = "dispatch-failure-run";
        const restartSafe = settlement === "restart-safe";
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1_000,
          startedAt: 1_000,
          lifecycleRunId: runId,
          status: "running",
          ...(restartSafe
            ? {
                restartRecoveryDeliveryRunId: runId,
                restartRecoveryDeliverySourceRunId: runId,
              }
            : {}),
        });
        let userPersisted = false;
        const persistUserTurnTranscript = async () => {
          await appendTranscriptMessage(target, {
            message: { role: "user", content: "Please continue." },
          });
          userPersisted = true;
        };
        if (restartSafe) {
          await persistUserTurnTranscript();
        }
        const warn = vi.fn();
        const chatRunState = createChatRunState();
        const broadcast = vi.fn();
        const agentRunSeq = new Map<string, number>();
        broadcastChatDelta({
          context: { chatRunState, broadcast, agentRunSeq, nodeSendToSession: vi.fn() },
          runId,
          sessionKey: target.sessionKey,
          text: "Command instructions",
          isCurrent: () => true,
        });
        const previewGroup = chatRunState.runs.get(runId)?.liveTextGroup;
        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            activeRunAbort: {
              cleanup: vi.fn(),
              controller: new AbortController(),
              entry: undefined,
              registered: true,
            } as never,
            cleanupAdmittedRun: vi.fn(),
            lifecycleGeneration: "test-generation",
            restartSafeAdmission: restartSafe
              ? { requestFingerprint: "test-fingerprint" }
              : undefined,
          },
          context: {
            agentRunSeq,
            broadcast,
            broadcastToConnIds: vi.fn(),
            chatAbortControllers: new Map(),
            chatRunState,
            dedupe: new Map(),
            getRuntimeConfig: () => ({}),
            getSessionEventSubscriberConnIds: () => new Set<string>(),
            logGateway: { warn },
            nodeSendToSession: vi.fn(),
            removeChatRun: vi.fn(),
          } as never,
          isQueuedFollowupEnqueued: () => false,
          isAgentRunStarted: () => false,
          persistUserTurnTranscript,
          session: {
            agentId: target.agentId,
            backingSessionId: target.sessionId,
            cfg: {},
            clientRunId: runId,
            now: 1_000,
            rawSessionKey: target.sessionKey,
            sessionKey: target.sessionKey,
          },
          terminalizeRestartSafeAdmission: (terminal) =>
            terminalizeRestartSafeChatAdmission({
              ...terminal,
              ...target,
              admittedSessionId: target.sessionId,
              clientRunId: runId,
              startedAt: 1_000,
            }),
          userTurnRecorder: { hasPersisted: () => userPersisted, isBlocked: () => false },
        });

        await lifecycle.handleError(new Error("Cloud worker unavailable"));
        expect(previewGroup?.signal.aborted).toBe(false);
        await lifecycle.finalize();
        expect(broadcast).toHaveBeenLastCalledWith(
          "chat",
          expect.objectContaining({ state: "error" }),
          expect.objectContaining({ liveText: { group: previewGroup?.signal } }),
        );
        expect(chatRunState.runs.has(runId)).toBe(false);
        expect(previewGroup?.signal.aborted).toBe(true);

        expect(warn).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toMatchObject({ status: "failed", lastRunId: runId });
        const messages = (await loadTranscriptEvents(target)).filter(
          (entry) =>
            isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
        );
        expect(messages).toMatchObject([
          { type: "message", message: { role: "user", content: "Please continue." } },
          {
            type: "custom_message",
            customType: "run-failed-before-reply",
            display: true,
            details: { runId },
          },
        ]);
        if (restartSafe) {
          expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBe(runId);
          const terminal = {
            ...target,
            admittedSessionId: target.sessionId,
            clientRunId: runId,
            startedAt: 1_000,
            error: "Late duplicate rejection",
            status: "failed" as const,
            retryable: false,
          };
          expect(await terminalizeRestartSafeChatAdmission(terminal)).toBe(true);
          expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
          expect(await terminalizeRestartSafeChatAdmission(terminal)).toBe(false);
          expect(
            (await loadTranscriptEvents(target)).filter(
              (entry) => isRecord(entry) && entry.type === "custom_message",
            ),
          ).toHaveLength(1);
        }
      });
    },
  );

  it("keeps restart-safe settlement successful when its notice cannot be written", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        sessionKey: "agent:main:main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: "settled-session",
        updatedAt: 1_000,
        restartRecoveryDeliveryRunId: "settled-run",
      });
      const report = vi
        .spyOn(sessionRunError, "recordGatewaySessionRunFailure")
        .mockRejectedValueOnce(new Error("notice write failed"));
      try {
        expect(
          await terminalizeRestartSafeChatAdmission({
            ...target,
            admittedSessionId: "settled-session",
            clientRunId: "settled-run",
            startedAt: 1_000,
            status: "failed",
            error: "Worker unavailable",
            retryable: false,
          }),
        ).toBe(true);
        expect(loadSessionEntry(target)).toMatchObject({
          status: "failed",
          lastRunId: "settled-run",
        });
        expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
      } finally {
        report.mockRestore();
      }
    });
  });

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
      isAgentRunStarted: () => false,
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
    if (!registration.registered) {
      throw new Error("expected the chat abort controller to be registered");
    }
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
        isAgentRunStarted: () => false,
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
      isAgentRunStarted: () => false,
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
    await lifecycle.finalize();

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
    const chatRunState = createChatRunState();
    chatRunState.getOrCreate(runId).buffer = "Native-owned output";
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
        chatRunState,
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      isQueuedFollowupEnqueued: () => false,
      isAgentRunStarted: () => true,
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
    await lifecycle.finalize();

    expect(dedupe.get(`chat:${runId}`)).toBe(terminalEntry);
    expect(chatRunState.runs.get(runId)?.buffer).toBe("Native-owned output");
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
    const broadcast = vi.fn();
    const dedupe = new Map();
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
          broadcast,
          broadcastToConnIds: vi.fn(),
          chatAbortControllers,
          chatRunState: createChatRunState(),
          dedupe,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
          logGateway: { warn: vi.fn() },
          nodeSendToSession: vi.fn(),
          removeChatRun: vi.fn(),
        } as never,
        isQueuedFollowupEnqueued: () => false,
        isAgentRunStarted: () => false,
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
      expect(dedupe.get(`chat:${clientRunId}`)).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
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
      expect(dedupe.get(`chat:${clientRunId}`)).toMatchObject({
        ok: false,
        payload: { runId: clientRunId, status: "error" },
      });
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: clientRunId, state: "error" }),
        expect.anything(),
      );
      expect(activeRunCleanup).toHaveBeenCalledExactlyOnceWith();
      expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
    } finally {
      releasePersistence.resolve();
      persistLifecycleEvent.mockRestore();
    }
  });
});
