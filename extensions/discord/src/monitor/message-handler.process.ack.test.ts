// Discord message processing coverage split by cohesive behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createBaseContext,
  createDiscordRestClientSpyForTest as createDiscordRestClientSpy,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  discordTargetMocksForTest as discordTargetMocks,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  getLastDispatchReplyOptions,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
  typingMocksForTest as typingMocks,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectReactAckCallAt,
  expectReactionCallsContain,
  firstMockArg,
  firstMockCall,
  getReactionEmojis,
  requireReactionCall,
  requireRecord,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    await runProcessDiscordMessage(ctx);

    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      accountId: "ops",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "ops",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expectReactAckCallAt(0, "👀", {
      accountId: "ops",
      ackReaction: "👀",
    });
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    await runProcessDiscordMessage(ctx);

    expectReactAckCallAt(0, "👀", {
      channelId: "fallback-channel",
      accountId: "default",
      ackReaction: "👀",
    });
  });

  it("uses separate REST clients for feedback and reply delivery", async () => {
    const feedbackRest = { post: vi.fn(async () => undefined) };
    const deliveryRest = { post: vi.fn(async () => undefined) };
    createDiscordRestClientSpy
      .mockReturnValueOnce({
        token: "",
        rest: feedbackRest as never,
        account: { config: {} } as never,
      })
      .mockReturnValueOnce({
        token: "",
        rest: deliveryRest as never,
        account: { config: {} } as never,
      });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "hello" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(sendMocks.reactMessageDiscord).toHaveBeenCalled();
    const feedbackOptions = requireRecord(
      requireReactionCall(sendMocks.reactMessageDiscord, 0)[3],
      "feedback reaction options",
    );
    expect(feedbackOptions.rest).toBe(feedbackRest);
    const deliveryParams = requireRecord(
      firstMockArg(deliverDiscordReply, "deliverDiscordReply"),
      "delivery params",
    );
    expect(deliveryParams.rest).toBe(deliveryRest);
    expect(feedbackRest).not.toBe(deliveryRest);
  });

  it("starts typing only after reply dispatch is admitted", async () => {
    const admit = vi.fn();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      admit();
      await params?.replyOptions?.onReplyStart?.();
      await params?.dispatcher.sendFinalReply({ text: "normal reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(expectDefined(admit.mock.invocationCallOrder[0], "admission call order")).toBeLessThan(
      expectDefined(typingMocks.sendTyping.mock.invocationCallOrder[0], "typing call order"),
    );
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("starts typing when an admitted fast reply bypasses resolver lifecycle", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "fast reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not start typing for fast replies when typing mode is never", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "fast reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { agents: { defaults: { typingMode: "never" } } },
    });

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not start typing for fast room-event replies", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "room event reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      inboundEventKind: "room_event",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("forwards repeated resolver typing refresh callbacks", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onReplyStart?.();
      await params?.dispatcher.sendFinalReply({ text: "long reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { agents: { defaults: { typingMode: "message" } } },
    });

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not create visible typing feedback when reply dispatch stays silent", async () => {
    dispatchInboundMessage.mockResolvedValueOnce(createNoQueuedDispatchResult());
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
  });

  it("keeps one typing refresh loop for default message-tool replies", async () => {
    vi.useFakeTimers();
    try {
      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        await params?.replyOptions?.onReplyStart?.();
        await vi.advanceTimersByTimeAsync(3_500);
        return createNoQueuedDispatchResult();
      });
      const ctx = await createBaseContext({
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        cfg: {
          messages: { groupChat: { visibleReplies: "message_tool" } },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      });

      await runProcessDiscordMessage(ctx);

      expect(getLastDispatchReplyOptions()?.typingKeepalive).toBe(false);
      expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain("👀");
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.thinking);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.coding);
  });

  it("marks automatic visible replies as failed when final Discord delivery fails", async () => {
    dispatchInboundMessage.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { final: 0, tool: 0, block: 0 },
      failedCounts: { final: 1 },
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.error);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
  });

  it("can bind status reactions to an explicitly tracked reaction target", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "message",
        phase: "start",
        args: {
          action: "react",
          channelId: "c1",
          messageId: "m1",
          emoji: "📈",
          trackToolCalls: true,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { messages: { ackReaction: "👀" } },
    });

    await runProcessDiscordMessage(ctx);
    await vi.runAllTimersAsync();

    expectReactionCallsContain("c1", "m1", "📈");
    expectReactionCallsContain("c1", "m1", "✉️");
    expectReactionCallsContain("c1", "m1", DEFAULT_EMOJIS.done);
  });

  it("resolves tracked reaction to targets like the Discord reaction action", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "message",
        phase: "start",
        args: {
          action: "react",
          to: "user:u1",
          messageId: "m1",
          emoji: "📈",
          trackToolCalls: true,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { messages: { ackReaction: "👀" } },
    });

    await runProcessDiscordMessage(ctx);
    await vi.runAllTimersAsync();

    const resolveCall = firstMockCall(
      discordTargetMocks.resolveDiscordTargetChannelId,
      "resolveDiscordTargetChannelId",
    );
    expect(resolveCall[0]).toBe("user:u1");
    expect(requireRecord(resolveCall[1], "Discord target resolve options").accountId).toBe(
      "default",
    );
    expectReactionCallsContain("dm-u1", "m1", "📈");
    expectReactionCallsContain("dm-u1", "m1", "✉️");
    expectReactionCallsContain("dm-u1", "m1", DEFAULT_EMOJIS.done);
  });

  it("shows stall emojis for long no-progress runs", async () => {
    vi.useFakeTimers();
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = () => resolve();
    });
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await dispatchGate;
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext();
    const runPromise = runProcessDiscordMessage(ctx);

    await vi.advanceTimersByTimeAsync(30_001);
    if (!releaseDispatch) {
      throw new Error("Expected Discord dispatch release callback to be initialized");
    }
    releaseDispatch();
    await vi.runAllTimersAsync();

    await runPromise;
    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallSoft);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallHard);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
  });

  it("falls back to plain ack when status reactions are disabled", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            enabled: false,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getReactionEmojis()).toEqual(["👀"]);
  });

  it("shows compacting reaction during auto-compaction and resumes thinking", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onCompactionStart?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      await params?.replyOptions?.onCompactionEnd?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.runAllTimersAsync();
    await runPromise;

    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.compacting);
    expect(emojis).toContain(DEFAULT_EMOJIS.thinking);
  });

  it("keeps the plain ack reaction when status reactions are disabled", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            enabled: false,
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });
});
