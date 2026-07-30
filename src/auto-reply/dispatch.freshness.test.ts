/** Tests foreground reply freshness fencing for buffered inbound dispatch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelPartialDeliveryError } from "../channels/turn/delivery-result.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { getReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyDispatchBeforeDeliver } from "./reply/reply-dispatcher.js";
import type { ReplyDispatchBeforeDeliverOptions } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type DispatchReplyFromConfigParams = Parameters<DispatchReplyFromConfigFn>[0];

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfigMock(...args),
}));

const { dispatchInboundMessageWithBufferedDispatcher } = await import("./dispatch.js");

type Delivery = {
  kind: "tool" | "block" | "final";
  text: string | undefined;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function queuedFinalResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  };
}

function buildForegroundCtx(overrides: Partial<MsgContext> = {}): FinalizedMsgContext {
  return buildTestCtx({
    SessionKey: "agent:main:whatsapp:direct:+1000",
    AccountId: "default",
    From: "whatsapp:+1000",
    To: "whatsapp:bot",
    ChatType: "direct",
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "whatsapp:+1000",
    ...overrides,
  });
}

function dispatchWithDeliveries(
  ctx: FinalizedMsgContext,
  deliveries: Delivery[],
  dispatcherOptions: {
    beforeDeliver?: ReplyDispatchBeforeDeliver;
    beforeDeliverOptions?: ReplyDispatchBeforeDeliverOptions;
    deliver?: (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => Promise<object | void>;
    onBeforeDeliverCancelled?: (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => void;
    onSettled?: () => object | void | Promise<object | void>;
    onFreshSettledDelivery?: () => object | void | Promise<object | void>;
  } = {},
) {
  return dispatchInboundMessageWithBufferedDispatcher({
    ctx,
    cfg: {} as OpenClawConfig,
    dispatcherOptions: {
      ...dispatcherOptions,
      deliver:
        dispatcherOptions.deliver ??
        (async (payload: ReplyPayload, info: { kind: Delivery["kind"] }) => {
          deliveries.push({ kind: info.kind, text: payload.text });
        }),
    },
  });
}

describe("foreground reply freshness", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    hoisted.dispatchReplyFromConfigMock.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("suppresses an older foreground final after a newer inbound event starts for the same session target", async () => {
    const deliveries: Delivery[] = [];
    const cancellationReasons: Array<string | undefined> = [];
    const olderStarted = createDeferred<void>();
    const releaseOlderFinal = createDeferred<void>();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          olderStarted.resolve();
          await releaseOlderFinal.promise;
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      {
        onBeforeDeliverCancelled: (payload) => {
          cancellationReasons.push(
            getReplyPayloadMetadata(payload)?.foregroundDeliverySuppression?.reason,
          );
        },
      },
    );
    await olderStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );

    releaseOlderFinal.resolve();
    const olderResult = await olderDispatch;

    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
    expect(cancellationReasons).toEqual(["stale-foreground"]);
  });

  it("leaves configured beforeDeliver cancellations untagged", async () => {
    const deliveries: Delivery[] = [];
    const cancellationReasons: Array<string | undefined> = [];

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        params.dispatcher.sendFinalReply({ text: "policy-blocked final" });
        return queuedFinalResult();
      },
    );

    const result = await dispatchWithDeliveries(buildForegroundCtx(), deliveries, {
      beforeDeliver: () => null,
      onBeforeDeliverCancelled: (payload) => {
        cancellationReasons.push(
          getReplyPayloadMetadata(payload)?.foregroundDeliverySuppression?.reason,
        );
      },
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([]);
    expect(cancellationReasons).toEqual([undefined]);
  });

  it("releases a WhatsApp-shaped lane after beforeDeliver times out", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Delivery[] = [];
      const hookStarted = createDeferred<void>();
      const onSettled = vi.fn();
      let hookCalls = 0;
      const beforeDeliver = vi.fn((payload: ReplyPayload) => {
        hookCalls += 1;
        if (hookCalls === 1) {
          hookStarted.resolve();
          return new Promise<ReplyPayload>(() => {});
        }
        return payload;
      });
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          params.dispatcher.sendFinalReply({ text: "stuck final" });
          params.dispatcher.sendFinalReply({ text: "follow-up final" });
          return {
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 2 },
          };
        },
      );

      const dispatch = dispatchWithDeliveries(buildForegroundCtx(), deliveries, {
        beforeDeliver,
        onSettled,
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(dispatch).resolves.toEqual({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
        failedCounts: { tool: 0, block: 0, final: 1 },
      });
      expect(beforeDeliver).toHaveBeenCalledTimes(2);
      expect(deliveries).toEqual([{ kind: "final", text: "follow-up final" }]);
      expect(onSettled).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a configured beforeDeliver budget inside the foreground fence", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Delivery[] = [];
      const hookStarted = createDeferred<void>();
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          params.dispatcher.sendFinalReply({ text: "budgeted final" });
          return queuedFinalResult();
        },
      );

      const dispatch = dispatchWithDeliveries(buildForegroundCtx(), deliveries, {
        beforeDeliver: async (payload) => {
          hookStarted.resolve();
          await new Promise((resolve) => {
            setTimeout(resolve, 16_000);
          });
          return payload;
        },
        beforeDeliverOptions: { timeoutMs: 20_000 },
      });
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(deliveries).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(dispatch).resolves.toEqual(queuedFinalResult());
      expect(deliveries).toEqual([{ kind: "final", text: "budgeted final" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an older foreground final when a newer inbound has no visible delivery while beforeDeliver is pending", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
          };
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(olderResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "old rewritten final" }]);
  });

  it("does not fence an older final behind a newer inbound waiting for its delivery", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred<void>();
    const newerStarted = createDeferred<void>();
    const releaseOlderFinal = createDeferred<void>();
    const olderDelivered = createDeferred<void>();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          olderStarted.resolve();
          await releaseOlderFinal.promise;
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          newerStarted.resolve();
          // Same-session follow-up admission waits for the owning final delivery.
          params.replyOptions?.onReplyAdmissionWaitChange?.(true);
          try {
            await olderDelivered.promise;
          } finally {
            params.replyOptions?.onReplyAdmissionWaitChange?.(false);
          }
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
          };
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      {
        deliver: async (payload, info) => {
          deliveries.push({ kind: info.kind, text: payload.text });
          olderDelivered.resolve();
        },
      },
    );
    await olderStarted.promise;

    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newerStarted.promise;
    releaseOlderFinal.resolve();

    await expect(olderDispatch).resolves.toEqual(queuedFinalResult());
    await expect(newerDispatch).resolves.toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);
  });

  it("keeps an older final fenced while a newer independent turn resolves", async () => {
    const deliveries: Delivery[] = [];
    const olderBeforeDeliverStarted = createDeferred<void>();
    const releaseOlderBeforeDeliver = createDeferred<ReplyPayload | null>();
    const newerStarted = createDeferred<void>();
    const releaseNewerFinal = createDeferred<void>();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          newerStarted.resolve();
          await releaseNewerFinal.promise;
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      {
        beforeDeliver: () => {
          olderBeforeDeliverStarted.resolve();
          return releaseOlderBeforeDeliver.promise;
        },
      },
    );
    await olderBeforeDeliverStarted.promise;

    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newerStarted.promise;
    releaseOlderBeforeDeliver.resolve({ text: "old final" });
    await Promise.resolve();
    expect(deliveries).toEqual([]);

    releaseNewerFinal.resolve();
    await expect(newerDispatch).resolves.toEqual(queuedFinalResult());
    await expect(olderDispatch).resolves.toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
  });

  it("keeps an older foreground final fenced while a newer visible delivery is unresolved", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const newerDeliverStarted = createDeferred<void>();
    const releaseNewerDeliver = createDeferred<void>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
      {
        deliver: async (payload, info) => {
          newerDeliverStarted.resolve();
          await releaseNewerDeliver.promise;
          deliveries.push({ kind: info.kind, text: payload.text });
        },
      },
    );
    await newerDeliverStarted.promise;

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    await Promise.resolve();
    expect(deliveries).toEqual([]);

    releaseNewerDeliver.resolve();
    const newerResult = await newerDispatch;
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
  });

  it("keeps an older foreground final when a newer visible delivery fails", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
      {
        deliver: async () => {
          throw new Error("delivery failed");
        },
      },
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      failedCounts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "old rewritten final" }]);
  });

  it.each([
    {
      label: "shared outbound error",
      createError: () =>
        new OutboundDeliveryError("second chunk failed", {
          cause: new Error("second chunk failed"),
          results: [{ channel: "whatsapp", messageId: "wa-1" }],
        }),
    },
    {
      label: "channel partial-delivery envelope",
      createError: () =>
        createChannelPartialDeliveryError(new Error("finalization failed"), {
          content: "new final",
          messageIds: ["provider-1"],
          visibleReplySent: true,
        }),
    },
  ])("suppresses an older foreground final after $label", async ({ createError }) => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
      {
        deliver: async (payload, info) => {
          deliveries.push({ kind: info.kind, text: payload.text });
          throw createError();
        },
      },
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      failedCounts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
  });

  it("keeps an older foreground final when a newer adapter reports non-visible delivery", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
      {
        deliver: async () => ({ visibleReplySent: false }),
      },
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "old rewritten final" }]);
  });

  it("suppresses an older foreground final when a newer settled hook reports visible delivery", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
      {
        deliver: async () => ({ visibleReplySent: false }),
        onSettled: async () => ({ visibleReplySent: true }),
      },
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([]);
  });

  it("still runs stale generic settled hooks after a newer visible reply", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });
    const olderSettled = vi.fn();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver, onSettled: olderSettled },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(olderSettled).toHaveBeenCalledTimes(1);
    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
  });

  it("suppresses an older fresh settled delivery after a newer visible reply", async () => {
    const deliveries: Delivery[] = [];
    const beforeDeliverStarted = createDeferred<void>();
    const releaseBeforeDeliver = createDeferred<ReplyPayload | null>();
    const beforeDeliver = vi.fn(() => {
      beforeDeliverStarted.resolve();
      return releaseBeforeDeliver.promise;
    });
    const olderFreshDelivery = vi.fn(() => {
      deliveries.push({ kind: "final", text: "old settled fallback" });
      return { visibleReplySent: true };
    });

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "new-message") {
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
      { beforeDeliver, onFreshSettledDelivery: olderFreshDelivery },
    );
    await beforeDeliverStarted.promise;

    const newerResult = await dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );

    releaseBeforeDeliver.resolve({ text: "old rewritten final" });
    const olderResult = await olderDispatch;

    expect(beforeDeliver).toHaveBeenCalledTimes(1);
    expect(olderFreshDelivery).not.toHaveBeenCalled();
    expect(newerResult).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(olderResult).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(deliveries).toEqual([{ kind: "final", text: "new final" }]);
  });

  it("runs the settled delivery hook when dispatch fails after queueing a reply", async () => {
    const deliveries: Delivery[] = [];
    let settled = false;
    const error = new Error("resolver failed");

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        params.dispatcher.sendFinalReply({ text: "queued final" });
        throw error;
      },
    );

    await expect(
      dispatchWithDeliveries(buildForegroundCtx(), deliveries, {
        deliver: async () => ({ visibleReplySent: false }),
        onSettled: () => {
          settled = true;
          return { visibleReplySent: true };
        },
      }),
    ).rejects.toBe(error);

    expect(settled).toBe(true);
  });

  it("keeps concurrent foreground finals isolated for different targets sharing a session", async () => {
    const deliveries: Delivery[] = [];
    const firstStarted = createDeferred<void>();
    const releaseFirstFinal = createDeferred<void>();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "first-chat") {
          firstStarted.resolve();
          await releaseFirstFinal.promise;
          params.dispatcher.sendFinalReply({ text: "first chat final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "second-chat") {
          params.dispatcher.sendFinalReply({ text: "second chat final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const sharedSessionKey = "agent:main:main";
    const firstDispatch = dispatchWithDeliveries(
      buildForegroundCtx({
        MessageSid: "first-chat",
        SessionKey: sharedSessionKey,
        From: "whatsapp:+1000",
        OriginatingTo: "whatsapp:+1000",
      }),
      deliveries,
    );
    await firstStarted.promise;

    const secondDispatch = dispatchWithDeliveries(
      buildForegroundCtx({
        MessageSid: "second-chat",
        SessionKey: sharedSessionKey,
        From: "whatsapp:+3000",
        OriginatingTo: "whatsapp:+3000",
      }),
      deliveries,
    );
    await expect(secondDispatch).resolves.toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });

    releaseFirstFinal.resolve();
    await expect(firstDispatch).resolves.toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(deliveries).toEqual([
      { kind: "final", text: "second chat final" },
      { kind: "final", text: "first chat final" },
    ]);
  });
});
