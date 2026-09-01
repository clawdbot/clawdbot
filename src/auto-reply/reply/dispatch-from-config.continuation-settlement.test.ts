// Continuation settlement tests cover status delivery and child-terminal handoff.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createHookCtx,
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;

function pendingFinalDelivery(text: string, intentId = "intent-1") {
  return {
    kind: "replayable" as const,
    text,
    createdAt: 1,
    intentId,
    deliveries: [{ id: "delivery-1", state: "prepared" as const }],
  };
}

function pendingFinalReply(text: string, intentId = "intent-1"): ReplyPayload {
  return setReplyPayloadMetadata(
    { text },
    {
      pendingFinalDeliveryCompletion: {
        deliveryId: "delivery-1",
        intentId,
        sessionId: "session-1",
        sessionKey: "agent:test:session",
        storePath: "/tmp/mock-sessions.json",
      },
    },
  );
}

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({
    testing: { resetReplyRunRegistry },
  } = await import("./reply-run-registry.test-support.js"));
});

beforeEach(() => {
  clearAgentHarnesses();
  resetReplyRunRegistry();
  resetInboundDedupe();
  setDiscordTestRegistry();
  resetPluginTtsAndThreadMocks();
  hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionStoreEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
  sessionStoreMocks.readSessionEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveSessionStorePathCore
    .mockReset()
    .mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
  sessionStoreMocks.updateSessionEntry.mockClear();
});

afterEach(() => {
  resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

describe("accepted continuation status delivery", () => {
  it("clears pending final delivery after final dispatch succeeds", async () => {
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      sessionKey: "agent:test:session",
      pendingFinalDelivery: pendingFinalDelivery("durable reply", "intent-1"),
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => pendingFinalReply("durable reply"),
    });
    await dispatcher.waitForIdle();
    await vi.waitFor(() => {
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    });

    expect(result.queuedFinal).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledTimes(3);
  });

  it("settles an accepted continuation only after its waiting status is delivered", async () => {
    const order: string[] = [];
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async (statusDelivered: boolean) => {
      order.push(`settle:${statusDelivered}`);
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        order.push(`deliver:${payload.text}`);
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingContinuation?.({ statusPayload, settle });
            return statusPayload;
          },
        }),
    });

    expect(order).toEqual(["deliver:Continuing work; the result will follow.", "settle:true"]);
  });

  it("releases child delivery when an acknowledged continuation status cannot settle its batch", async () => {
    const order: string[] = [];
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async (statusDelivered: boolean) => {
      order.push(`settle:${statusDelivered}`);
      if (statusDelivered) {
        throw new Error("continuation batch is unavailable");
      }
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        order.push(`deliver:${payload.text}`);
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingContinuation?.({ statusPayload, settle });
            return statusPayload;
          },
        }),
    });

    expect(order).toEqual([
      "deliver:Continuing work; the result will follow.",
      "settle:true",
      "settle:false",
    ]);
  });

  it("releases an accepted continuation when its waiting status is not delivered", async () => {
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingContinuation?.({ statusPayload, settle });
            return statusPayload;
          },
        }),
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases an accepted continuation when finalization aborts before status dispatch", async () => {
    const abortController = new AbortController();
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: { abortSignal: abortController.signal },
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingContinuation?.({ statusPayload, settle });
            abortController.abort();
            return statusPayload;
          },
        }),
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases an accepted continuation when status dispatch rejects before queueing", async () => {
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    vi.spyOn(dispatcher, "sendFinalReply").mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingContinuation?.({ statusPayload, settle });
              return statusPayload;
            },
          }),
      }),
    ).rejects.toThrow("queue unavailable");

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases an accepted continuation when buffered commentary routing rejects", async () => {
    sessionStoreMocks.currentEntry = { verboseLevel: "on" };
    const statusPayload = { text: "Continuing work; the result will follow." };
    const settle = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    const ctx = createHookCtx();
    Object.assign(ctx, { OriginatingChannel: "discord", OriginatingTo: "user:1" });
    mocks.routeReply.mockRejectedValueOnce(new Error("commentary delivery unavailable"));

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx,
            cfg: emptyConfig,
            dispatcher,
            replyOptions: { onItemEvent: vi.fn() },
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingContinuation?.({ statusPayload, settle });
              await opts?.onItemEvent?.({
                itemId: "commentary-1",
                kind: "preamble",
                progressText: "Working on the request.",
              });
              return statusPayload;
            },
          }),
      }),
    ).rejects.toThrow("commentary delivery unavailable");

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases an accepted continuation when session-writer delivery is revoked", async () => {
    const statusPayload = setReplyPayloadMetadata(
      { text: "Continuing work; the result will follow." },
      {
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-before-replacement",
          expectedSessionId: "session-1",
          expectedWriterRunId: "run-before-replacement",
          sessionKey: "agent:test:session",
          storePath: "/tmp/mock-sessions.json",
        },
      },
    );
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      lifecycleRevision: "revision-after-replacement",
      activeWriterRunId: "run-after-replacement",
    };
    const settle = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingContinuation?.({ statusPayload, settle });
            return statusPayload;
          },
        }),
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("clears pending final delivery when abort fires after a successful final send (#89115)", async () => {
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      sessionKey: "agent:test:session",
      pendingFinalDelivery: pendingFinalDelivery("durable reply", "intent-89115"),
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
          replyResolver: async () => pendingFinalReply("durable reply", "intent-89115"),
        }),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionEntry).toHaveBeenCalledTimes(3);
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
  });
});
