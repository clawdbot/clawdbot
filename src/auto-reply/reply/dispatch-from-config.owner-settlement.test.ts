// Resolver ownership ends before delivery-only after-clear work.
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  acpManagerRuntimeMocks,
  createDispatcher,
  createHookCtx,
  emptyConfig,
  hookMocks,
  mocks,
  runtimePluginMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  replyRunRegistry,
  requireBlockReplyHandler,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let getActiveReplyRunCount: typeof import("./reply-run-registry.registry.js").getActiveReplyRunCount;
let runAfterReplyOperationClear: typeof import("./reply-run-registry.js").runAfterReplyOperationClear;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

beforeAll(async () => {
  await globalBeforeAll0();
  ({ getActiveReplyRunCount } = await import("./reply-run-registry.registry.js"));
  ({ runAfterReplyOperationClear } = await import("./reply-run-registry.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("./reply-run-registry.test-support.js");
  resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
});

describe("dispatchReplyFromConfig owner settlement", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(() => {
    resetReplyRunRegistry();
    resetInboundDedupe();
    vi.useRealTimers();
    clearAgentHarnesses();
  });

  it("holds an owned lifecycle lease until abort-insensitive resolver work settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:channel:owned-resolver-race";
    const sessionId = "owned-resolver-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    let releaseResolver: () => void = () => {};
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let signalResolverEntered: () => void = () => {};
    const resolverEntered = new Promise<void>((resolve) => {
      signalResolverEntered = resolve;
    });
    type ResolverOptions = import("./get-reply.types.js").InternalGetReplyOptions;
    let operation: ResolverOptions["replyOperation"];
    let resumedResolverOwner: ResolverOptions["replyOperation"];
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: ResolverOptions) => {
      operation = opts?.replyOperation;
      signalResolverEntered();
      await resolverGate;
      resumedResolverOwner = replyRunRegistry.get(sessionKey);
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "stale late final" } satisfies ReplyPayload;
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owned-resolver-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "hold this resolver",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;

    const externalLifecycleRequest = new AsyncResource("external-owned-resolver-lifecycle");
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runExclusiveSessionLifecycleMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionWorkAdmissions({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );

    try {
      expect(operation).toBeDefined();
      const result = await dispatch;
      expect(result.queuedFinal).toBe(false);
      expect(replyRunRegistry.get(sessionKey)).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(mutationRan).toBe(false);
      expect(isSessionWorkAdmissionActive("/tmp/mock-sessions.json", [sessionKey, sessionId])).toBe(
        true,
      );

      releaseResolver();
      await mutation;

      expect(resumedResolverOwner).toBe(operation);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      expect(mutationRan).toBe(true);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    } finally {
      releaseResolver();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  describe("delivery settlement", () => {
    beforeEach(() => {
      // Keep the delivery cases on their original non-ACP, Discord-only fixture.
      setDiscordTestRegistry();
      mocks.tryFastAbortFromMessage.mockReset();
      setNoAbort();
      hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
      sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({ existing: undefined });
      sessionStoreMocks.updateSessionEntry.mockClear();
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
      runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(
        runtimePluginMocks.pluginRegistry,
      );
    });

    it.each(["final delivery", "block receipt callback"] as const)(
      "clears the reply lane but defers follow-up admission until %s settles",
      async (phase) => {
        const holdReceiptCallback = phase === "block receipt callback";
        const heldOrder = holdReceiptCallback
          ? ["block-delivered", "callback-start"]
          : ["final-start"];
        const completedOrder = holdReceiptCallback
          ? ["block-delivered", "callback-start", "callback-end", "followup"]
          : ["final-start", "final-end", "followup"];
        const deliveryOrder: string[] = [];
        const releaseDelivery = createDeferred();
        let receiptCallbackWork: Promise<void> | undefined;
        const dispatcher = createReplyDispatcher({
          deliver: async (_payload, info) => {
            if (holdReceiptCallback) {
              deliveryOrder.push(`${info.kind}-delivered`);
              return;
            }
            deliveryOrder.push("final-start");
            await releaseDelivery.promise;
            deliveryOrder.push("final-end");
          },
        });
        let operation: ReturnType<typeof createReplyOperation> | undefined;
        let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
        const abortController = new AbortController();
        hookMocks.runner.runReplyDispatch.mockImplementation(async (_event, contextValue) => {
          operation = replyRunRegistry.get("agent:test:session");
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
          if (holdReceiptCallback) {
            return undefined;
          }
          const context = contextValue as { dispatcher: typeof dispatcher };
          return {
            handled: true,
            queuedFinal: context.dispatcher.sendFinalReply({ text: "first reply" }),
            counts: context.dispatcher.getQueuedCounts(),
          };
        });
        const dispatchPromise = dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: {
            abortSignal: abortController.signal,
            onBlockReplyQueued: holdReceiptCallback
              ? () => {
                  deliveryOrder.push("callback-start");
                  receiptCallbackWork = releaseDelivery.promise.then(() => {
                    deliveryOrder.push("callback-end");
                  });
                  return receiptCallbackWork;
                }
              : undefined,
          },
          replyResolver: async (_ctx, opts) => {
            await opts?.onBlockReply?.({ text: "first reply" });
            return undefined;
          },
        });

        try {
          await vi.waitFor(() => {
            expect(deliveryOrder).toEqual(heldOrder);
          });
          const result = await dispatchPromise;

          expect(operation).toBeDefined();
          expect(result.queuedFinal).toBe(!holdReceiptCallback);
          expect(replyRunRegistry.get("agent:test:session")).toBeUndefined();
          if (holdReceiptCallback) {
            const receipt = await dispatcher.waitForIdle();
            expect(receipt?.counts.block.delivered).toBe(1);
          }
          expect(deliveryOrder).toEqual(heldOrder);
          expect(queuedOperation).toBeUndefined();

          abortController.abort();
          await Promise.resolve();
          expect(queuedOperation).toBeUndefined();

          releaseDelivery.resolve();
          await dispatcher.waitForIdle();
          await vi.waitFor(() => {
            expect(queuedOperation).toBeDefined();
          });

          expect(deliveryOrder).toEqual(completedOrder);
          expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
        } finally {
          releaseDelivery.resolve();
          dispatcher.markComplete();
          await Promise.allSettled([dispatchPromise, receiptCallbackWork]);
          await dispatcher.waitForIdle();
          operation?.complete();
          if (operation) {
            await vi.waitFor(() => {
              expect(queuedOperation).toBeDefined();
            });
          }
          queuedOperation?.complete();
          expect(getActiveReplyRunCount()).toBe(0);
        }
      },
    );
  });
});
