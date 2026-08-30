/** Tests foreground reply delivery ordering for buffered inbound dispatch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRoomEventSource,
  createAdmittedUserRequestSource,
} from "../../test/helpers/admitted-room-event-source.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { readCurrentHostChannelContextOwner } from "../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { getTotalPendingReplies } from "./reply/dispatcher-registry.js";
import { hasAuthorizedQueuedRoomEventSourceDelivery } from "./reply/queue.js";
import type { ReplyDispatchBeforeDeliver } from "./reply/reply-dispatcher.js";
import type { ReplyDispatchBeforeDeliverOptions } from "./reply/reply-dispatcher.types.js";
import { bindSourceFinalizationPrivateOptions } from "./reply/source-finalization-private-state.js";
import type { QueuedSourceReplyDelivery } from "./reply/source-finalization.types.js";
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

function queuedFinalResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  };
}

function settledFinalResult() {
  return {
    ...queuedFinalResult(),
    settledReceipt: {
      counts: {
        tool: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        block: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        final: {
          delivered: 1,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
      },
      anyVisibleDelivered: true,
    },
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

describe("foreground reply delivery order", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    hoisted.dispatchReplyFromConfigMock.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("retains each opted-in queued turn's exact post-hook source dispatcher", async () => {
    const owners = new Map<string, QueuedSourceReplyDelivery>();
    const deliveries = new Map<string, Delivery[]>();
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        const messageId = params.ctx.MessageSid;
        const owner = params.replyOptions?.queuedSourceReplyDelivery;
        if (messageId && owner) {
          owners.set(messageId, owner);
        }
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      },
    );

    const dispatch = async (messageId: string, installHook = false) => {
      const target: Delivery[] = [];
      deliveries.set(messageId, target);
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: buildForegroundCtx({ MessageSid: messageId }),
        cfg: {} as OpenClawConfig,
        dispatcherOptions: {
          ...(installHook
            ? {
                beforeDeliver: (payload: ReplyPayload) => ({
                  ...payload,
                  text: `hooked: ${payload.text}`,
                }),
              }
            : {}),
          deliver: async (payload, info) => {
            target.push({ kind: info.kind, text: payload.text });
          },
        },
        replyOptions: bindSourceFinalizationPrivateOptions(
          messageId === "older-trigger"
            ? {
                onQueuedFollowupAdmitted,
                sourceReplyDeliveryMode: "automatic" as const,
              }
            : {},
          {
            deferSourceMessageToolDelivery: true,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });
    };

    await dispatch("older-trigger", true);
    await dispatch("newer-trigger");
    expect(owners.get("older-trigger")?.presentationOptions.onQueuedFollowupAdmitted).toBe(
      onQueuedFollowupAdmitted,
    );
    expect(owners.get("older-trigger")?.presentationOptions).toHaveProperty(
      "onReasoningStream",
      undefined,
    );
    expect(owners.get("older-trigger")?.presentationOptions).toHaveProperty(
      "onQueuedFollowupSettled",
      undefined,
    );
    await owners
      .get("older-trigger")!
      .deliver({ text: "older queued final" }, { kind: "final", runId: "older-run" });
    await owners
      .get("newer-trigger")!
      .deliver({ text: "newer queued final" }, { kind: "final", runId: "newer-run" });

    expect(deliveries.get("older-trigger")).toEqual([
      { kind: "final", text: "hooked: older queued final" },
    ]);
    expect(deliveries.get("newer-trigger")).toEqual([
      { kind: "final", text: "newer queued final" },
    ]);
  });

  it("rejects a retained room-event owner carrying the former structural marker", async () => {
    let owner: QueuedSourceReplyDelivery | undefined;
    const deliver = vi.fn(async () => {});
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildForegroundCtx({
        ChatType: "group",
        InboundEventKind: "room_event",
        MessageSid: "legacy-structural-authority",
        OriginatingChannel: "matrix",
        Provider: "matrix",
        Surface: "matrix",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver },
      replyOptions: bindSourceFinalizationPrivateOptions(
        {
          sourceReplyDeliveryMode: "automatic",
          roomEventSourceReplyDeliveryAuthority: "host_owned",
        } as Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["replyOptions"] & {
          roomEventSourceReplyDeliveryAuthority: "host_owned";
        },
        {
          deferSourceMessageToolDelivery: true,
          retainQueuedSourceReplyDelivery: true,
        },
      ),
    });

    expect(owner).toBeDefined();
    expect(
      hasAuthorizedQueuedRoomEventSourceDelivery({
        currentInboundEventKind: "room_event",
        run: { sourceReplyDeliveryMode: "automatic" },
        queuedSourceReplyDelivery: owner,
      }),
    ).toBe(false);
    await expect(
      owner!.deliver({ text: "forged late final" }, { kind: "final", runId: "forged-run" }),
    ).resolves.toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("binds retained room-event delivery to the exact live admitted source owner", async () => {
    const source = await createAdmittedRoomEventSource();
    const transportDeliver = vi.fn(async () => {});
    let owner: QueuedSourceReplyDelivery | undefined;
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    try {
      source.bindNextDispatchAttempt();
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: source.context,
        cfg: {} as OpenClawConfig,
        dispatcherOptions: { deliver: transportDeliver },
        replyOptions: bindSourceFinalizationPrivateOptions(
          { sourceReplyDeliveryMode: "automatic" },
          {
            deferSourceMessageToolDelivery: true,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });

      expect(owner).toBeDefined();
      const queuedRun = {
        currentInboundEventKind: "room_event" as const,
        run: { sourceReplyDeliveryMode: "automatic" as const },
        queuedSourceReplyDelivery: owner,
      };
      expect(hasAuthorizedQueuedRoomEventSourceDelivery(queuedRun)).toBe(true);
      expect(
        hasAuthorizedQueuedRoomEventSourceDelivery({
          ...queuedRun,
          run: { sourceReplyDeliveryMode: "message_tool_only" },
        }),
      ).toBe(true);
      expect(
        hasAuthorizedQueuedRoomEventSourceDelivery({
          ...queuedRun,
          queuedSourceReplyDelivery: { ...owner! },
        }),
      ).toBe(false);

      await expect(
        owner!.deliver({ text: "live late final" }, { kind: "final", runId: "live-run" }),
      ).resolves.toBe("delivered");
      expect(transportDeliver).toHaveBeenCalledOnce();

      source.retire();
      expect(hasAuthorizedQueuedRoomEventSourceDelivery(queuedRun)).toBe(false);
      await expect(
        owner!.deliver({ text: "stale late final" }, { kind: "final", runId: "stale-run" }),
      ).resolves.toBe("cancelled");
      expect(transportDeliver).toHaveBeenCalledOnce();
    } finally {
      source.retire();
    }
  });

  it("rechecks retained room-event ownership after waiting for the delivery lane", async () => {
    const source = await createAdmittedRoomEventSource();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const transportDeliver = vi.fn(async (payload: ReplyPayload) => {
      if (payload.text === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    let owner: QueuedSourceReplyDelivery | undefined;
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    try {
      source.bindNextDispatchAttempt();
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: source.context,
        cfg: {} as OpenClawConfig,
        dispatcherOptions: { deliver: transportDeliver },
        replyOptions: bindSourceFinalizationPrivateOptions(
          { sourceReplyDeliveryMode: "automatic" },
          {
            deferSourceMessageToolDelivery: true,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });
      const first = owner!.deliver({ text: "first" }, { kind: "final", runId: "first-run" });
      await firstStarted.promise;
      const waiting = owner!.deliver({ text: "waiting" }, { kind: "final", runId: "waiting-run" });

      source.retire();
      releaseFirst.resolve();

      await expect(first).resolves.toBe("delivered");
      await expect(waiting).resolves.toBe("cancelled");
      expect(transportDeliver).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      source.retire();
    }
  });

  it("cancels a retained Matrix user-request delivery after its source owner retires", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const sourceOwner = readCurrentHostChannelContextOwner(source.context);
    const transportDeliver = vi.fn(async () => {});
    let owner: QueuedSourceReplyDelivery | undefined;
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    try {
      expect(sourceOwner).toBeDefined();
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: source.context,
        cfg: {} as OpenClawConfig,
        dispatcherOptions: { deliver: transportDeliver },
        replyOptions: bindSourceFinalizationPrivateOptions(
          { sourceReplyDeliveryMode: "automatic" },
          {
            deferSourceMessageToolDelivery: true,
            isSourceLive: () => readCurrentHostChannelContextOwner(source.context) === sourceOwner,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });

      await expect(
        owner!.deliver({ text: "live late final" }, { kind: "final", runId: "live-run" }),
      ).resolves.toBe("delivered");
      source.retire();
      await expect(
        owner!.deliver({ text: "stale late final" }, { kind: "final", runId: "stale-run" }),
      ).resolves.toBe("cancelled");
      expect(transportDeliver).toHaveBeenCalledOnce();
    } finally {
      source.retire();
    }
  });

  it("rechecks a retained Matrix user-request owner after waiting for its delivery lane", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const sourceOwner = readCurrentHostChannelContextOwner(source.context);
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const transportDeliver = vi.fn(async (payload: ReplyPayload) => {
      if (payload.text === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    let owner: QueuedSourceReplyDelivery | undefined;
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    try {
      expect(sourceOwner).toBeDefined();
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: source.context,
        cfg: {} as OpenClawConfig,
        dispatcherOptions: { deliver: transportDeliver },
        replyOptions: bindSourceFinalizationPrivateOptions(
          { sourceReplyDeliveryMode: "automatic" },
          {
            deferSourceMessageToolDelivery: true,
            isSourceLive: () => readCurrentHostChannelContextOwner(source.context) === sourceOwner,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });
      const first = owner!.deliver({ text: "first" }, { kind: "final", runId: "first-run" });
      await firstStarted.promise;
      const waiting = owner!.deliver({ text: "waiting" }, { kind: "final", runId: "waiting-run" });

      source.retire();
      releaseFirst.resolve();

      await expect(first).resolves.toBe("delivered");
      await expect(waiting).resolves.toBe("cancelled");
      expect(transportDeliver).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      source.retire();
    }
  });

  it("rechecks a retained source after its before-delivery hook settles", async () => {
    const source = await createAdmittedUserRequestSource({ channelId: "matrix" });
    const sourceOwner = readCurrentHostChannelContextOwner(source.context);
    const beforeDeliverStarted = createDeferred();
    const releaseBeforeDeliver = createDeferred();
    const transportDeliver = vi.fn(async () => {});
    let owner: QueuedSourceReplyDelivery | undefined;
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    try {
      expect(sourceOwner).toBeDefined();
      await dispatchInboundMessageWithBufferedDispatcher({
        ctx: source.context,
        cfg: {} as OpenClawConfig,
        dispatcherOptions: {
          beforeDeliver: async (payload) => {
            beforeDeliverStarted.resolve();
            await releaseBeforeDeliver.promise;
            return payload;
          },
          deliver: transportDeliver,
        },
        replyOptions: bindSourceFinalizationPrivateOptions(
          { sourceReplyDeliveryMode: "automatic" },
          {
            deferSourceMessageToolDelivery: true,
            isSourceLive: () => readCurrentHostChannelContextOwner(source.context) === sourceOwner,
            retainQueuedSourceReplyDelivery: true,
          },
        ),
      });
      const delivery = owner!.deliver(
        { text: "stale after hook" },
        { kind: "final", runId: "stale-run" },
      );
      await beforeDeliverStarted.promise;
      source.retire();
      releaseBeforeDeliver.resolve();

      await expect(delivery).resolves.toBe("cancelled");
      expect(transportDeliver).not.toHaveBeenCalled();
    } finally {
      releaseBeforeDeliver.resolve();
      source.retire();
    }
  });

  it("tracks and serializes fresh deferred dispatchers after foreground settlement", async () => {
    let owner: QueuedSourceReplyDelivery | undefined;
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const started: string[] = [];
    const delivered: string[] = [];
    const onSettled = vi.fn();
    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        owner = params.replyOptions?.queuedSourceReplyDelivery;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildForegroundCtx({ MessageSid: "queued-owner" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        beforeDeliver: (payload) => ({ ...payload, text: `hooked: ${payload.text}` }),
        deliver: async (payload) => {
          const text = payload.text ?? "";
          started.push(text);
          if (text.endsWith("first")) {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            secondStarted.resolve();
            await releaseSecond.promise;
          }
          delivered.push(text);
        },
        onSettled,
      },
      replyOptions: bindSourceFinalizationPrivateOptions(
        {},
        {
          deferSourceMessageToolDelivery: true,
          retainQueuedSourceReplyDelivery: true,
        },
      ),
    });

    expect(owner).toBeDefined();
    expect(getTotalPendingReplies()).toBe(0);
    expect(onSettled).toHaveBeenCalledOnce();

    const first = owner!.deliver({ text: "first" }, { kind: "final", runId: "run:first" });
    const second = owner!.deliver({ text: "second" }, { kind: "final", runId: "run:second" });
    try {
      await firstStarted.promise;
      await Promise.resolve();
      expect(started).toEqual(["hooked: first"]);
      expect(getTotalPendingReplies()).toBeGreaterThan(0);
      expect(onSettled).toHaveBeenCalledOnce();

      releaseFirst.resolve();
      await secondStarted.promise;
      expect(started).toEqual(["hooked: first", "hooked: second"]);
      expect(getTotalPendingReplies()).toBeGreaterThan(0);

      releaseSecond.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual(["delivered", "delivered"]);
      expect(delivered).toEqual(["hooked: first", "hooked: second"]);
      expect(getTotalPendingReplies()).toBe(0);
      // Deferred sends keep wire observers, but do not replay the foreground
      // typing/draft onIdle -> onSettled lifecycle.
      expect(onSettled).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("delivers same-target foreground finals once in inbound order", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFinal = createDeferred();

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
          params.dispatcher.sendFinalReply({ text: "new final" });
          return queuedFinalResult();
        }
        throw new Error(`unexpected test message ${params.ctx.MessageSid ?? "<missing>"}`);
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "old-message" }),
      deliveries,
    );
    await olderStarted.promise;

    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newerStarted.promise;

    releaseOlderFinal.resolve();
    const [olderResult, newerResult] = await Promise.all([olderDispatch, newerDispatch]);

    expect(newerResult).toEqual(settledFinalResult());
    expect(olderResult).toEqual(settledFinalResult());
    expect(deliveries).toEqual([
      { kind: "final", text: "old final" },
      { kind: "final", text: "new final" },
    ]);
  });

  it("retains a waiting successor so a third foreground final cannot overtake", async () => {
    const deliveries: Delivery[] = [];
    const olderBeforeDeliverStarted = createDeferred();
    const releaseOlderBeforeDeliver = createDeferred<ReplyPayload | null>();
    const waitingSuccessorStarted = createDeferred();
    const newestStarted = createDeferred();
    const releaseWaitingSuccessor = createDeferred();

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "old-message") {
          params.dispatcher.sendFinalReply({ text: "old final" });
          return queuedFinalResult();
        }
        if (params.ctx.MessageSid === "waiting-message") {
          waitingSuccessorStarted.resolve();
          await releaseWaitingSuccessor.promise;
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
          };
        }
        if (params.ctx.MessageSid === "new-message") {
          newestStarted.resolve();
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

    const waitingSuccessorDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "waiting-message" }),
      deliveries,
    );
    await waitingSuccessorStarted.promise;
    const newestDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "new-message" }),
      deliveries,
    );
    await newestStarted.promise;

    releaseOlderBeforeDeliver.resolve({ text: "old final" });
    await olderDispatch;
    expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);

    releaseWaitingSuccessor.resolve();
    await Promise.all([waitingSuccessorDispatch, newestDispatch]);

    expect(deliveries).toEqual([
      { kind: "final", text: "old final" },
      { kind: "final", text: "new final" },
    ]);
  });

  it("does not charge predecessor waiting against the configured beforeDeliver budget", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Delivery[] = [];
      const olderHookStarted = createDeferred();
      const releaseOlderHook = createDeferred<ReplyPayload | null>();
      const hookStarted = createDeferred();
      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          params.dispatcher.sendFinalReply({ text: `${params.ctx.MessageSid} final` });
          return queuedFinalResult();
        },
      );

      const olderDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "older" }),
        deliveries,
        {
          beforeDeliver: () => {
            olderHookStarted.resolve();
            return releaseOlderHook.promise;
          },
          beforeDeliverOptions: { timeoutMs: 40_000 },
        },
      );
      await olderHookStarted.promise;
      const newerDispatch = dispatchWithDeliveries(
        buildForegroundCtx({ MessageSid: "newer" }),
        deliveries,
        {
          beforeDeliver: async (payload) => {
            hookStarted.resolve();
            await new Promise((resolve) => {
              setTimeout(resolve, 16_000);
            });
            return payload;
          },
          beforeDeliverOptions: { timeoutMs: 20_000 },
        },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      expect(deliveries).toEqual([]);
      releaseOlderHook.resolve({ text: "older final" });
      await expect(olderDispatch).resolves.toEqual(settledFinalResult());
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(16_000);

      await expect(newerDispatch).resolves.toEqual(settledFinalResult());
      expect(deliveries).toEqual([
        { kind: "final", text: "older final" },
        { kind: "final", text: "newer final" },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fence an older final behind a newer inbound waiting for its delivery", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFinal = createDeferred();
    const olderDelivered = createDeferred();

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
          await olderDelivered.promise;
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

    await expect(olderDispatch).resolves.toEqual(settledFinalResult());
    const newerResult = await newerDispatch;
    expect(newerResult).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(newerResult.settledReceipt?.anyVisibleDelivered).toBe(false);
    expect(deliveries).toEqual([{ kind: "final", text: "old final" }]);
  });

  it.each(["onSettled", "onFreshSettledDelivery"] as const)(
    "orders %s delivery behind an earlier foreground final",
    async (settledHook) => {
      const deliveries: Delivery[] = [];
      const olderBeforeDeliverStarted = createDeferred();
      const releaseOlderBeforeDeliver = createDeferred<ReplyPayload | null>();
      const newerStarted = createDeferred();

      hoisted.dispatchReplyFromConfigMock.mockImplementation(
        async (params: DispatchReplyFromConfigParams) => {
          if (params.ctx.MessageSid === "old-message") {
            params.dispatcher.sendFinalReply({ text: "old final" });
            return queuedFinalResult();
          }
          if (params.ctx.MessageSid === "new-message") {
            newerStarted.resolve();
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
        {
          [settledHook]: () => {
            deliveries.push({ kind: "final", text: "new settled final" });
            return { visibleReplySent: true };
          },
        },
      );
      await newerStarted.promise;

      releaseOlderBeforeDeliver.resolve({ text: "old final" });
      await Promise.all([olderDispatch, newerDispatch]);

      expect(deliveries).toEqual([
        { kind: "final", text: "old final" },
        { kind: "final", text: "new settled final" },
      ]);
    },
  );

  it("releases a same-target successor when an earlier dispatch fails", async () => {
    const deliveries: Delivery[] = [];
    const olderStarted = createDeferred();
    const newerStarted = createDeferred();
    const releaseOlderFailure = createDeferred();
    const error = new Error("resolver failed");

    hoisted.dispatchReplyFromConfigMock.mockImplementation(
      async (params: DispatchReplyFromConfigParams) => {
        if (params.ctx.MessageSid === "older") {
          olderStarted.resolve();
          await releaseOlderFailure.promise;
          throw error;
        }
        newerStarted.resolve();
        params.dispatcher.sendFinalReply({ text: "newer final" });
        return queuedFinalResult();
      },
    );

    const olderDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "older" }),
      deliveries,
    );
    await olderStarted.promise;
    const newerDispatch = dispatchWithDeliveries(
      buildForegroundCtx({ MessageSid: "newer" }),
      deliveries,
    );
    await newerStarted.promise;
    expect(deliveries).toEqual([]);

    releaseOlderFailure.resolve();
    await expect(olderDispatch).rejects.toBe(error);
    await expect(newerDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual([{ kind: "final", text: "newer final" }]);
  });

  it("keeps concurrent foreground finals isolated for different targets sharing a session", async () => {
    const deliveries: Delivery[] = [];
    const firstStarted = createDeferred();
    const releaseFirstFinal = createDeferred();

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
    await expect(secondDispatch).resolves.toEqual(settledFinalResult());

    releaseFirstFinal.resolve();
    await expect(firstDispatch).resolves.toEqual(settledFinalResult());
    expect(deliveries).toEqual([
      { kind: "final", text: "second chat final" },
      { kind: "final", text: "first chat final" },
    ]);
  });
});
