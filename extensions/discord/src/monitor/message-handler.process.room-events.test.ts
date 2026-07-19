// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDirectMessageContextOverrides,
  createNoQueuedDispatchResult,
  createThreadBindingManager,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  getLastDispatchCtx,
  getLastDispatchReplyOptions,
  getLastRouteUpdate,
  notifyDiscordInboundEventOutboundSuccess,
  readSessionUpdatedAt,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectRecordFields,
  getReactionEmojis,
  requireRecord,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage session routing and room events", () => {
  it("suppresses Discord reactions for room events when ack scope does not force all messages", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "group-all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "group-all",
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual([]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("sends Discord ack reactions for room events when ack scope is all", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("records Discord room events in history while source replies are tool-only", async () => {
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    expect(getLastDispatchReplyOptions()?.queuedDeliveryCorrelations).toHaveLength(1);
    expect(guildHistories.get("c1")).toMatchObject([
      {
        body: "hi",
        messageId: "m1",
        sender: "Alice",
      },
    ]);
  });

  it("clears Discord room event history after a visible action send succeeds", async () => {
    const guildHistories = new Map();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      notifyDiscordInboundEventOutboundSuccess({
        sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
        inboundEventKind: "room_event",
        to: "channel:c1",
        accountId: "default",
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(guildHistories.get("c1")).toEqual([]);
  });

  it("clears Discord group DM room event history after a visible action send succeeds", async () => {
    const guildHistories = new Map();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      notifyDiscordInboundEventOutboundSuccess({
        sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
        inboundEventKind: "room_event",
        to: "channel:c1",
        accountId: "default",
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      isGuildMessage: false,
      isGroupDm: true,
      isDirectMessage: false,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(guildHistories.get("c1")).toEqual([]);
    expect(getLastDispatchCtx()?.GroupRequireMention).toBe(false);
  });

  it("clears Discord room event history after a queued core send succeeds", async () => {
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    const begin = getLastDispatchReplyOptions()?.queuedDeliveryCorrelations?.[0]?.begin;
    expect(begin).toBeTypeOf("function");
    const end = begin?.();
    notifyDiscordInboundEventOutboundSuccess({
      sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      inboundEventKind: "room_event",
      to: "channel:c1",
      accountId: "default",
    });
    end?.();

    expect(guildHistories.get("c1")).toEqual([]);
  });

  it("uses PluralKit original ids for inbound dedupe while preserving the Discord message id", async () => {
    const ctx = await createBaseContext({
      canonicalMessageId: "orig-123",
      message: {
        id: "proxy-456",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      MessageSid: "orig-123",
      MessageSidFull: "proxy-456",
    });
  });

  it("resolves guild source delivery from default, explicit, and room-event modes", async () => {
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        cfg: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
            },
          },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        inboundEventKind: "room_event",
        cfg: {
          messages: {
            groupChat: {
              visibleReplies: "automatic",
            },
          },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        ...createDirectMessageContextOverrides(),
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
      cfg: {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "c-parent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
    });

    const ctx = await createBaseContext({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: "agent:main:subagent:child",
      MessageThreadId: "thread-1",
    });
    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:subagent:child",
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
    });
  });

  it("passes Discord thread parent only for model inheritance when transcript inheritance is off", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:thread-1",
      route: {
        ...BASE_CHANNEL_ROUTE,
        sessionKey: "agent:main:discord:channel:thread-1",
      },
      messageChannelId: "thread-1",
      message: {
        id: "m1",
        channelId: "thread-1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      threadChannel: { id: "thread-1", name: "child-thread" },
      threadParentId: "parent-1",
      discordConfig: { thread: { inheritParent: false } },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: "agent:main:discord:channel:thread-1",
      MessageThreadId: "thread-1",
      ThreadParentId: "parent-1",
      ModelParentSessionKey: "agent:main:discord:channel:parent-1",
    });
    expect(getLastDispatchCtx()?.ParentSessionKey).toBeUndefined();
  });

  it("omits thread starter context when the effective thread session already exists", async () => {
    const threadSessionKey = "agent:main:discord:channel:thread-1";
    readSessionUpdatedAt.mockImplementation((params?: unknown) => {
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      return sessionKey === threadSessionKey ? 1_700_000_000_000 : undefined;
    });
    const rest = {
      get: vi.fn(async () => ({
        content: "original thread starter",
        embeds: [],
        author: { id: "U2", username: "bob", discriminator: "0" },
        timestamp: new Date().toISOString(),
      })),
    };
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
      },
      baseSessionKey: threadSessionKey,
      route: BASE_CHANNEL_ROUTE,
      messageChannelId: "thread-1",
      message: {
        id: "m1",
        channelId: "thread-1",
        content: "follow-up",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageText: "follow-up",
      baseText: "follow-up",
      threadChannel: { id: "thread-1", name: "child-thread" },
      threadParentId: "parent-1",
      client: { rest },
      channelConfig: { allowed: true, users: ["U2"] },
    });

    await runProcessDiscordMessage(ctx);

    expect(rest.get).toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: threadSessionKey,
      MessageThreadId: "thread-1",
      ThreadLabel: "Discord thread #parent",
    });
    expect(getLastDispatchCtx()?.ThreadStarterBody).toBeUndefined();
  });
});
