import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createTelegramInboundBuffers } from "./bot-handlers.inbound-buffer.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { TelegramContext } from "./bot/types.js";
import { createTelegramIngressResolver, createTelegramIngressSubject } from "./ingress.js";

function createPipeline(
  processMessageWithReplyChain: TelegramMessagePipeline["processMessageWithReplyChain"],
  removeMessageFromReplyChain: TelegramMessagePipeline["removeMessageFromReplyChain"] = vi.fn(
    async () => true,
  ),
): TelegramMessagePipeline {
  return {
    promptContextBoundaryOptions: () => ({}),
    latestPromptContextMinTimestampMs: () => undefined,
    latestPromptContextAmbientWatermark: () => undefined,
    mergeDispatchDedupeClaims: (
      ...groups: Parameters<TelegramMessagePipeline["mergeDispatchDedupeClaims"]>
    ) => groups.flatMap((group) => group ?? []),
    releaseDispatchDedupeClaims: vi.fn(),
    buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
    settleSpooledReplayParticipants: vi.fn(),
    createSpooledReplayParticipantForBufferedWork: () => undefined,
    spooledReplayOptions: () => ({}),
    buildSyntheticTextMessage: ({ base, text }: { base: Message; text: string }) => ({
      ...base,
      text,
    }),
    buildSyntheticContext: (ctx: TelegramContext, syntheticMessage: Message) => ({
      ...ctx,
      message: syntheticMessage,
    }),
    formatTelegramAmbientTranscriptBody: () => undefined,
    processMessageWithReplyChain,
    removeMessageFromReplyChain,
  } as unknown as TelegramMessagePipeline;
}

describe("Telegram inbound provenance buffering", () => {
  it("preserves every exact authorization resolver through debounce collection", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async () => ({ kind: "completed" as const }));
    const message = {
      promptContextBoundaryOptions: () => ({}),
      latestPromptContextMinTimestampMs: () => undefined,
      latestPromptContextAmbientWatermark: () => undefined,
      mergeDispatchDedupeClaims: () => [],
      releaseDispatchDedupeClaims: () => undefined,
      buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
      settleSpooledReplayParticipants: () => undefined,
      createSpooledReplayParticipantForBufferedWork: () => undefined,
      spooledReplayOptions: () => ({}),
      buildSyntheticTextMessage: ({ base, text }: { base: Message; text: string }) => ({
        ...base,
        text,
      }),
      buildSyntheticContext: (ctx: TelegramContext, syntheticMessage: Message) => ({
        ...ctx,
        message: syntheticMessage,
      }),
      formatTelegramAmbientTranscriptBody: () => undefined,
      processMessageWithReplyChain,
    } as unknown as TelegramMessagePipeline;
    const { inboundDebouncer } = createTelegramInboundBuffers({
      params: {
        cfg: { messages: { inbound: { debounceMs: 50 } } },
        bot: { api: { sendMessage: vi.fn() } } as never,
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
        opts: { token: "test-token" },
        removeMessageFromGroupHistory: vi.fn(),
      },
      message,
    });
    const resolver = createTelegramIngressResolver({ accountId: "default" });
    const ingress = await Promise.all([
      resolver.message({
        subject: createTelegramIngressSubject("42"),
        conversation: { kind: "direct", id: "42" },
        dmPolicy: "open",
      }),
      resolver.message({
        subject: createTelegramIngressSubject("42"),
        conversation: { kind: "direct", id: "42" },
        dmPolicy: "open",
      }),
    ]);
    const ingressResolvers = ingress.map((result) => async () => await Promise.resolve(result));
    const baseMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 42, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text: "hello",
    } as Message;
    const ctx = { message: baseMessage } as TelegramContext;

    for (const [index, channelIngressResolver] of ingressResolvers.entries()) {
      await inboundDebouncer.enqueue({
        ctx,
        msg: { ...baseMessage, message_id: index + 1, text: `message ${index + 1}` },
        allMedia: [],
        storeAllowFrom: [],
        receivedAtMs: index + 1,
        debounceKey: "telegram:default:42:42:default",
        debounceLane: "default",
        threadSpec: { scope: "none" },
        dispatchDedupeClaims: [],
        channelIngressResolvers: [channelIngressResolver],
        cancelled: false,
        dispatchAdmission: "pending",
        dispatchAbortControllers: new Set(),
        pendingIgnoreSettlements: new Set(),
      });
    }
    await inboundDebouncer.drain();

    const carried =
      processMessageWithReplyChain.mock.calls[0]?.[0]?.options?.channelIngressResolvers;
    expect(carried).toEqual(ingressResolvers);
    expect(carried?.[0]).toBe(ingressResolvers[0]);
    expect(carried?.[1]).toBe(ingressResolvers[1]);
  });

  it("rebuilds a debounce batch without a message ignored at final dispatch", async () => {
    const firstMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 42, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text: "message 1",
    } as Message;
    const secondMessage = { ...firstMessage, message_id: 2, text: "message 2" } as Message;
    const ignoreControl: {
      begin?: ReturnType<typeof createTelegramInboundBuffers>["beginPendingBufferedMessageIgnore"];
    } = {};
    const privacyOrder: string[] = [];
    const removeMessageFromGroupHistory = vi.fn(() => {
      privacyOrder.push("group-history-purged");
      return true;
    });
    const removeMessageFromReplyChain = vi.fn(async () => {
      privacyOrder.push("reply-cache-purged");
      return true;
    });
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async (input) => {
      if (processMessageWithReplyChain.mock.calls.length === 1) {
        // Cross the final asynchronous skip check first. Admission still has to close the
        // synchronous race before dispatch/adoption becomes observable.
        expect(await input.shouldSkipBeforeDispatch?.()).toBe(false);
        privacyOrder.push("late-context-write");
        const pendingIgnore = ignoreControl.begin?.(firstMessage);
        expect(pendingIgnore).toBeDefined();
        pendingIgnore?.settle(true);
        expect(input.dispatchAdmission?.tryAdmit()).toBe(false);
        expect(input.deferCancelledBeforeDispatchSettlement).toBe(true);
        return { kind: "skipped", reason: "cancelled-before-dispatch" };
      }
      expect(await input.shouldSkipBeforeDispatch?.()).toBe(false);
      return { kind: "completed" };
    });
    const { inboundDebouncer, beginPendingBufferedMessageIgnore: beginPending } =
      createTelegramInboundBuffers({
        params: {
          cfg: { messages: { inbound: { debounceMs: 10 } } },
          bot: { api: { sendMessage: vi.fn() } } as never,
          runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
          opts: { token: "test-token" },
          removeMessageFromGroupHistory,
        },
        message: createPipeline(processMessageWithReplyChain, removeMessageFromReplyChain),
      });
    ignoreControl.begin = beginPending;
    const channelIngressResolver = async () => ({ allowed: true }) as never;

    for (const msg of [firstMessage, secondMessage]) {
      await inboundDebouncer.enqueue({
        ctx: { message: msg } as TelegramContext,
        msg,
        allMedia: [],
        storeAllowFrom: [],
        receivedAtMs: msg.message_id,
        debounceKey: "telegram:default:42:42:default",
        debounceLane: "default",
        threadSpec: { scope: "none" },
        dispatchDedupeClaims: [],
        channelIngressResolvers: [channelIngressResolver],
        cancelled: false,
        dispatchAdmission: "pending",
        dispatchAbortControllers: new Set(),
        pendingIgnoreSettlements: new Set(),
      });
    }
    await inboundDebouncer.drain();

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(2);
    expect(
      processMessageWithReplyChain.mock.calls[0]?.[0].options?.bufferedMessages?.map(
        (msg) => msg.message_id,
      ),
    ).toEqual([1, 2]);
    expect(processMessageWithReplyChain.mock.calls[1]?.[0].msg).toMatchObject({
      message_id: 2,
      text: "message 2",
    });
    expect(privacyOrder).toEqual([
      "late-context-write",
      "group-history-purged",
      "reply-cache-purged",
    ]);
    expect(removeMessageFromGroupHistory).toHaveBeenCalledExactlyOnceWith(firstMessage, {
      scope: "none",
    });
    expect(removeMessageFromReplyChain).toHaveBeenCalledExactlyOnceWith(firstMessage);
  });

  it("rebuilds text fragments without a fragment ignored at final dispatch", async () => {
    const firstMessage = {
      message_id: 10,
      date: 1,
      chat: { id: 42, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text: "a".repeat(4000),
    } as Message;
    const secondMessage = { ...firstMessage, message_id: 11, text: "survivor" } as Message;
    const ignoreControl: {
      begin?: ReturnType<typeof createTelegramInboundBuffers>["beginPendingBufferedMessageIgnore"];
    } = {};
    const privacyOrder: string[] = [];
    const removeMessageFromGroupHistory = vi.fn(() => {
      privacyOrder.push("group-history-purged");
      return true;
    });
    const removeMessageFromReplyChain = vi.fn(async () => {
      privacyOrder.push("reply-cache-purged");
      return true;
    });
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async (input) => {
      if (processMessageWithReplyChain.mock.calls.length === 1) {
        expect(await input.shouldSkipBeforeDispatch?.()).toBe(false);
        privacyOrder.push("late-context-write");
        const pendingIgnore = ignoreControl.begin?.(firstMessage);
        expect(pendingIgnore).toBeDefined();
        pendingIgnore?.settle(true);
        expect(input.dispatchAdmission?.tryAdmit()).toBe(false);
        expect(input.deferCancelledBeforeDispatchSettlement).toBe(true);
        return { kind: "skipped", reason: "cancelled-before-dispatch" };
      }
      expect(await input.shouldSkipBeforeDispatch?.()).toBe(false);
      return { kind: "completed" };
    });
    const { handleTextFragment, beginPendingBufferedMessageIgnore: beginPending } =
      createTelegramInboundBuffers({
        params: {
          cfg: {},
          bot: { api: { sendMessage: vi.fn() } } as never,
          runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
          opts: { token: "test-token", testTimings: { textFragmentGapMs: 10 } },
          removeMessageFromGroupHistory,
        },
        message: createPipeline(processMessageWithReplyChain, removeMessageFromReplyChain),
      });
    ignoreControl.begin = beginPending;
    const baseInput = {
      chatId: 42,
      threadSpec: { scope: "none" } as const,
      storeAllowFrom: [],
      isAbortControlMessage: false,
      isAuthorizedAbortControlMessage: async () => true,
      dispatchDedupeClaims: [],
      channelIngressResolver: async () => ({ allowed: true }) as never,
    };

    expect(
      await handleTextFragment({
        ...baseInput,
        ctx: { message: firstMessage } as TelegramContext,
        msg: firstMessage,
      }),
    ).toBe(true);
    expect(
      await handleTextFragment({
        ...baseInput,
        ctx: { message: secondMessage } as TelegramContext,
        msg: secondMessage,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(processMessageWithReplyChain).toHaveBeenCalledTimes(2));

    expect(
      processMessageWithReplyChain.mock.calls[0]?.[0].options?.bufferedMessages?.map(
        (msg) => msg.message_id,
      ),
    ).toEqual([10, 11]);
    expect(processMessageWithReplyChain.mock.calls[1]?.[0]).toMatchObject({
      msg: { message_id: 11, text: "survivor" },
      options: { bufferedMessages: [{ message_id: 11, text: "survivor" }] },
    });
    expect(privacyOrder).toEqual([
      "late-context-write",
      "group-history-purged",
      "reply-cache-purged",
    ]);
    expect(removeMessageFromGroupHistory).toHaveBeenCalledExactlyOnceWith(firstMessage, {
      scope: "none",
    });
    expect(removeMessageFromReplyChain).toHaveBeenCalledExactlyOnceWith(firstMessage);
  });
});
