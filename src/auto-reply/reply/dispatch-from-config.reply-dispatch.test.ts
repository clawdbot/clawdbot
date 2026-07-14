// Tests dispatch-from-config reply dispatch integration and final payload routing.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.test-fixtures.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  createHookCtx,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  internalHookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let runAfterReplyOperationClear: typeof import("./reply-run-registry.js").runAfterReplyOperationClear;
let resetReplyRunRegistry: typeof import("./reply-run-registry.js").testing.resetReplyRunRegistry;

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;

function firstRuntimeLoadCall() {
  return runtimePluginMocks.ensureRuntimePluginsLoaded.mock.calls[0]?.[0] as
    | { config?: unknown; workspaceDir?: unknown }
    | undefined;
}

function firstReplyDispatchCall() {
  return hookMocks.runner.runReplyDispatch.mock.calls[0] as
    | [
        {
          sessionKey?: string;
          toolsAllow?: string[];
          sendPolicy?: string;
          inboundAudio?: boolean;
        },
        {
          cfg?: unknown;
        },
      ]
    | undefined;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const replyRunRegistryModule = await import("./reply-run-registry.js");
    createReplyOperation = replyRunRegistryModule.createReplyOperation;
    replyRunRegistry = replyRunRegistryModule.replyRunRegistry;
    runAfterReplyOperationClear = replyRunRegistryModule.runAfterReplyOperationClear;
    resetReplyRunRegistry = () => replyRunRegistryModule.testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    mocks.routeReply.mockReset().mockResolvedValue({ ok: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStoreEntry.mockReset();
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(
      () => sessionStoreMocks.currentEntry,
    );
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.readSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    sessionStoreMocks.updateSessionEntry.mockClear();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
      resolveSession: () => ({ kind: "none" as const }),
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: vi.fn(),
    }));
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.emitAgentAuditEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockReset();
    resetPluginTtsAndThreadMocks();
  });

  it("returns handled dispatch results from plugins", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      fastAbortResolver: async () => ({ handled: false, aborted: false }),
      formatAbortReplyTextResolver: () => "⚙️ Agent was aborted.",
      replyOptions: { toolsAllow: ["message"] },
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(runtimePluginMocks.ensureRuntimePluginsLoaded).toHaveBeenCalledOnce();
    const runtimeLoadCall = firstRuntimeLoadCall();
    expect(runtimeLoadCall?.config).toBe(emptyConfig);
    expect(typeof runtimeLoadCall?.workspaceDir).toBe("string");
    expect(String(runtimeLoadCall?.workspaceDir).length).toBeGreaterThan(0);

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
    const [replyDispatchEvent, replyDispatchRuntime] = firstReplyDispatchCall() ?? [];
    expect(replyDispatchEvent?.sessionKey).toBe("agent:test:session");
    expect(replyDispatchEvent?.toolsAllow).toEqual(["message"]);
    expect(replyDispatchEvent?.sendPolicy).toBe("allow");
    expect(replyDispatchEvent?.inboundAudio).toBe(false);
    expect(replyDispatchRuntime?.cfg).toBe(emptyConfig);
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
  });
  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: {
        ...emptyConfig,
        session: {
          sendPolicy: { default: "deny" },
        },
      },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      noVisibleReplyFallbackEligible: true,
    });
  });

  it("clears pending final delivery after final dispatch succeeds", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryLastAttemptAt: 2,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { source: "heartbeat" },
    };
    sessionStoreMocks.loadSessionStore.mockClear();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "durable reply" }),
    });
    await dispatcher.waitForIdle();
    await vi.waitFor(() => {
      expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledOnce();
    });

    expect(result.queuedFinal).toBe(true);
    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "test",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: "agent:test:session",
      readConsistency: "latest",
      clone: false,
    });
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toBeUndefined();
  });

  it("clears pending final delivery when abort fires after a successful final send (#89115)", async () => {
    // Regression for #89115: an abort that lands after the final reply has
    // shipped (here, during sendFinalReply) must still clear the pending-final
    // bookkeeping — otherwise pendingFinalDelivery stays true and the get-reply
    // redelivery short-circuit silently blocks every later inbound.
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryLastAttemptAt: 2,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { source: "heartbeat" },
      pendingFinalDeliveryIntentId: "intent-89115",
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const abortController = new AbortController();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    const sendFinalReply = dispatcher.sendFinalReply.bind(dispatcher);
    vi.spyOn(dispatcher, "sendFinalReply").mockImplementation((payload) => {
      const queued = sendFinalReply(payload);
      abortController.abort();
      return queued;
    });

    const result = await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: { abortSignal: abortController.signal },
          replyResolver: async () => ({ text: "durable reply" }),
        }),
    });

    // Abort landed after delivery: the run is still surfaced as aborted
    // (queuedFinal:false), but the pending-final state is fully cleared.
    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("preserves pending final delivery when final dispatch fails", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendFinalReply).mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "durable reply" }),
    });

    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(1);
  });

  it("preserves pending final delivery when beforeDeliver times out", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "durable reply",
        pendingFinalDeliveryCreatedAt: 1,
        pendingFinalDeliveryContext: { channel: "whatsapp", to: "+1000" },
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      const deliver = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: () => {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => ({ text: "durable reply" }),
          }),
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;

      expect(result.queuedFinal).toBe(true);
      expect(deliver).not.toHaveBeenCalled();
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
      expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledOnce();
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toEqual({
        channel: "whatsapp",
        to: "+1000",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending final delivery when a later queued final succeeds", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "durable reply",
        pendingFinalDeliveryCreatedAt: 1,
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      const deliver = vi.fn().mockResolvedValue(undefined);
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: (payload) => {
          hookCalls += 1;
          if (hookCalls === 1) {
            hookStarted.resolve();
            return new Promise<never>(() => {});
          }
          return payload;
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => [{ text: "first" }, { text: "durable reply" }],
          }),
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await resultPromise;

      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "durable reply" }),
        expect.objectContaining({ kind: "final" }),
      );
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the durable final when an earlier auxiliary final succeeds", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "durable reply",
        pendingFinalDeliveryCreatedAt: 1,
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      const deliver = vi.fn().mockResolvedValue(undefined);
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: (payload) => {
          hookCalls += 1;
          if (hookCalls === 2) {
            hookStarted.resolve();
            return new Promise<never>(() => {});
          }
          return payload;
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => [{ text: "auxiliary" }, { text: "durable reply" }],
          }),
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await resultPromise;

      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "auxiliary" }),
        expect.objectContaining({ kind: "final" }),
      );
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows combined retry text to finals that failed before transport", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "auxiliary\n\ndurable reply",
        pendingFinalDeliveryCreatedAt: 1,
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver: vi.fn().mockResolvedValue(undefined),
        beforeDeliver: (payload) => {
          hookCalls += 1;
          if (hookCalls === 2) {
            hookStarted.resolve();
            return new Promise<never>(() => {});
          }
          return payload;
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => [{ text: "auxiliary" }, { text: "durable reply" }],
          }),
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await resultPromise;

      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows heartbeat-normalized retry text using its originating payloads", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "auxiliary durable reply",
        pendingFinalDeliveryCreatedAt: 1,
        pendingFinalDeliveryIntentId: "heartbeat-intent",
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver: vi.fn().mockResolvedValue(undefined),
        beforeDeliver: (payload) => {
          hookCalls += 1;
          if (hookCalls === 2) {
            hookStarted.resolve();
            return new Promise<never>(() => {});
          }
          return payload;
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => [
              setReplyPayloadMetadata(
                { text: "auxiliary" },
                {
                  pendingFinalDeliveryIntentId: "heartbeat-intent",
                  pendingFinalDeliveryRetryText: "auxiliary",
                },
              ),
              setReplyPayloadMetadata(
                { text: "durable reply" },
                {
                  pendingFinalDeliveryIntentId: "heartbeat-intent",
                  pendingFinalDeliveryRetryText: "durable reply",
                },
              ),
            ],
          }),
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await resultPromise;

      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(1);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryIntentId).toBe("heartbeat-intent");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older settlement rewrite a newer pending-final intent", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      sessionStoreMocks.currentEntry = {
        sessionKey: "agent:test:session",
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "older reply",
        pendingFinalDeliveryCreatedAt: 1,
        pendingFinalDeliveryIntentId: "older-intent",
      };
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
        existing: sessionStoreMocks.currentEntry,
      });
      const hookStarted = createDeferred<void>();
      const dispatcher = createReplyDispatcher({
        deliver: vi.fn().mockResolvedValue(undefined),
        beforeDeliver: () => {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        },
      });

      const resultPromise = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () =>
              setReplyPayloadMetadata(
                { text: "older reply" },
                { pendingFinalDeliveryIntentId: "older-intent" },
              ),
          }),
      });
      await hookStarted.promise;
      sessionStoreMocks.currentEntry = {
        ...sessionStoreMocks.currentEntry,
        pendingFinalDeliveryText: "newer reply",
        pendingFinalDeliveryCreatedAt: 2,
        pendingFinalDeliveryIntentId: "newer-intent",
      };
      await vi.advanceTimersByTimeAsync(15_000);
      await resultPromise;

      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("newer reply");
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(2);
      expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryIntentId).toBe("newer-intent");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending final delivery after transport delivery has started", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "possibly visible reply",
      pendingFinalDeliveryCreatedAt: 1,
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("transport failed after send started");
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async () => ({ text: "possibly visible reply" }),
        }),
    });

    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("clears pending final delivery after intentional pre-delivery cancellation", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "policy-suppressed reply",
      pendingFinalDeliveryCreatedAt: 1,
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: () => null,
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "policy-suppressed reply" }),
    });
    await dispatcher.waitForIdle();
    await vi.waitFor(() => {
      expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledOnce();
    });

    expect(result.queuedFinal).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("delivers a generated final reply before queued follow-up admission", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const deliveryOrder: string[] = [];
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
    vi.mocked(dispatcher.sendFinalReply).mockImplementation(() => {
      deliveryOrder.push("final");
      return true;
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.fail("run_failed", new Error("provider failed"));
          runAfterReplyOperationClear(operation, () => {
            deliveryOrder.push("followup");
            queuedOperation = createReplyOperation({
              sessionKey: "agent:test:session",
              sessionId: "queued-session",
              resetTriggered: false,
            });
          });
          return { text: "first reply" };
        },
      });

      expect(result.queuedFinal).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "first reply" });
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });
      expect(deliveryOrder).toEqual(["final", "followup"]);
      expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
    } finally {
      queuedOperation?.complete();
    }
  });

  it("releases a stalled finalizing dispatch and rejects its late reply", async () => {
    vi.useFakeTimers();
    const ownerStarted = createDeferred<void>();
    const releaseOwner = createDeferred<void>();
    const dispatcher = createDispatcher();
    let successor: ReturnType<typeof createReplyOperation> | undefined;
    hookMocks.runner.hasHooks.mockReturnValue(false);

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.freezeAbort();
          ownerStarted.resolve();
          await releaseOwner.promise;
          return { text: "late reply" };
        },
      });

      await ownerStarted.promise;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: false });

      expect(replyRunRegistry.get("agent:test:session")).toBeUndefined();
      successor = createReplyOperation({
        sessionKey: "agent:test:session",
        sessionId: "successor-session",
        resetTriggered: false,
      });

      releaseOwner.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyRunRegistry.get("agent:test:session")).toBe(successor);
    } finally {
      releaseOwner.resolve();
      successor?.complete();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps bounded TTS fallback work alive past the default finalization lease", async () => {
    vi.useFakeTimers();
    const ttsStarted = createDeferred<void>();
    const releaseTts = createDeferred<void>();
    const dispatcher = createDispatcher();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      ttsStarted.resolve();
      await releaseTts.promise;
      return (paramsUnknown as { payload: ReplyPayload }).payload;
    });

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.freezeAbort();
          return { text: "reply with slow TTS" };
        },
      });

      await ttsStarted.promise;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      const active = replyRunRegistry.get("agent:test:session");
      expect(active).toBeDefined();
      expect(active?.result).toBeNull();
      expect(replyRunRegistry.abort("agent:test:session")).toBe(false);

      releaseTts.resolve();
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "reply with slow TTS" });
      expect(replyRunRegistry.get("agent:test:session")).toBeUndefined();
    } finally {
      releaseTts.resolve();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("dedupes byte-identical non-streaming final payload entries for one turn", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const replyPayload = {
      text: "repeat once",
      mediaUrls: ["file:///tmp/repeat.png"],
      channelData: { telegram: { parseMode: "MarkdownV2" } },
    } satisfies ReplyPayload;

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [replyPayload, { ...replyPayload }],
    });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(replyPayload);
  });

  it("preserves same-content final payloads with distinct route metadata", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const firstReply = setReplyPayloadMetadata(
      { text: "same visible reply" } satisfies ReplyPayload,
      {
        replyDelivery: { chatType: "channel", replyToMode: "off" },
        replyDeliverySource: { channel: "slack", accountId: "primary" },
      },
    );
    const secondReply = setReplyPayloadMetadata(
      { text: "same visible reply" } satisfies ReplyPayload,
      {
        replyDelivery: { chatType: "channel", replyToMode: "off" },
        replyDeliverySource: { channel: "slack", accountId: "secondary" },
      },
    );

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [firstReply, secondReply],
    });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(1, firstReply);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(2, secondReply);
  });

  it("preserves same-content final payloads with distinct reply-threading identity", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const implicitReply = {
      text: "same threaded reply",
      replyToId: "message-1",
    } satisfies ReplyPayload;
    const explicitReply = setReplyPayloadMetadata(
      {
        text: "same threaded reply",
        replyToId: "message-1",
      } satisfies ReplyPayload,
      { replyToIdExplicit: true },
    );

    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [implicitReply, explicitReply],
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(1, implicitReply);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(2, explicitReply);
  });

  it("preserves same-content final payloads from distinct assistant messages", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const firstReply = setReplyPayloadMetadata(
      { text: "intentional repeat" } satisfies ReplyPayload,
      { assistantMessageIndex: 1 },
    );
    const secondReply = setReplyPayloadMetadata(
      { text: "intentional repeat" } satisfies ReplyPayload,
      { assistantMessageIndex: 2 },
    );

    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [firstReply, secondReply],
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(1, firstReply);
    expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(2, secondReply);
  });

  it("clears the reply lane but defers follow-up admission until final delivery settles", async () => {
    const deliveryOrder: string[] = [];
    let startDelivery: () => void = () => {};
    const deliveryStarted = new Promise<void>((resolve) => {
      startDelivery = resolve;
    });
    let releaseDelivery: () => void = () => {};
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliveryOrder.push("final-start");
        startDelivery();
        await deliveryGate;
        deliveryOrder.push("final-end");
      },
    });
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
    const abortController = new AbortController();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (_event, contextValue) => {
      const operation = replyRunRegistry.get("agent:test:session");
      if (!operation) {
        throw new Error("expected dispatch reply operation");
      }
      runAfterReplyOperationClear(operation, () => {
        deliveryOrder.push("followup");
        queuedOperation = createReplyOperation({
          sessionKey: "agent:test:session",
          sessionId: "queued-session",
          resetTriggered: false,
        });
      });
      const context = contextValue as { dispatcher: typeof dispatcher };
      return {
        handled: true,
        queuedFinal: context.dispatcher.sendFinalReply({ text: "first reply" }),
        counts: context.dispatcher.getQueuedCounts(),
      };
    });

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { abortSignal: abortController.signal },
      });

      await deliveryStarted;
      const result = await dispatchPromise;

      expect(result.queuedFinal).toBe(true);
      expect(replyRunRegistry.isActive("agent:test:session")).toBe(false);
      expect(deliveryOrder).toEqual(["final-start"]);
      expect(queuedOperation).toBeUndefined();

      abortController.abort();
      await Promise.resolve();
      expect(queuedOperation).toBeUndefined();

      releaseDelivery();
      await dispatcher.waitForIdle();
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });

      expect(deliveryOrder).toEqual(["final-start", "final-end", "followup"]);
      expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
    } finally {
      releaseDelivery();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      queuedOperation?.complete();
    }
  });
});
