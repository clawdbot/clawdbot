// Telegram tests cover bot message context.require mention plugin behavior.
import { describe, expect, it, vi } from "vitest";

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");
const { buildTelegramSelfSenderName } = await import("./group-history-window.js");

describe("buildTelegramMessageContext requireMention precedence", () => {
  function buildForumMessage(threadId = 99) {
    return {
      message_id: 1,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1_700_000_000,
      text: "hello everyone",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    };
  }

  it("lets explicit topic requireMention=false override group requireMention=true", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    if (!ctx) {
      throw new Error("expected Telegram context when topic disables requireMention");
    }
  });

  it("keeps unmentioned always-on group messages as user requests by default", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
  });

  it("marks unmentioned always-on group messages as room events when configured", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
  });

  it("keeps explicit bot mentions as user requests in always-on room-event groups", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: {
        ...buildForumMessage(),
        text: "@bot status",
        entities: [{ type: "mention", offset: 0, length: "@bot".length }],
      },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.ctxPayload.WasMentioned).toBe(true);
    expect(ctx?.ctxPayload.ExplicitlyMentionedBot).toBe(true);
  });

  it("keeps ambient abort phrases as user requests", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: { ...buildForumMessage(), text: "stop" },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
  });

  it("keeps room events as context for the next direct group request", async () => {
    const groupHistories = new Map();
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
    };
    await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), text: "side chatter" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        ...buildForumMessage(99),
        message_id: 2,
        text: "replying directly",
        reply_to_message: {
          message_id: 10,
          chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 7, first_name: "Bot", username: "bot", is_bot: true },
          text: "previous bot message",
        },
      },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(JSON.stringify(ctx?.ctxPayload.ChannelStructuredContext)).toContain("side chatter");
    expect(ctx?.ctxPayload.Body).not.toContain("side chatter");
  });

  it("keeps room events as context with default group history mode", async () => {
    const groupHistories = new Map();
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
    };
    await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), text: "side chatter" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        ...buildForumMessage(99),
        message_id: 2,
        text: "replying directly",
        reply_to_message: {
          message_id: 10,
          chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 7, first_name: "Bot", username: "bot", is_bot: true },
          text: "previous bot message",
        },
      },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(JSON.stringify(ctx?.ctxPayload.ChannelStructuredContext)).toContain("side chatter");
    expect(ctx?.ctxPayload.Body).not.toContain("side chatter");
    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "side chatter" }),
    ]);
  });

  it("passes prior silent room events to the next default ambient turn", async () => {
    const groupHistories = new Map();
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
    };
    await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), text: "Tell Sam deploy moved" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), message_id: 2, text: "What changed?" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "Tell Sam deploy moved" }),
    ]);
  });

  it("passes user requests to later default ambient turns", async () => {
    const groupHistories = new Map();
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
    };
    await buildTelegramMessageContextForTest({
      cfg,
      message: {
        ...buildForumMessage(99),
        text: "@bot note the deploy moved",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), message_id: 2, text: "What now?" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(ctx?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "@bot note the deploy moved" }),
    ]);
  });

  it("uses outbound self entries as the non-destructive user-request watermark", async () => {
    const historyKey = "-1001234567890:topic:99";
    const groupHistories = new Map([
      [
        historyKey,
        [
          { sender: "Alice", body: "before self marker", timestamp: 1, messageId: "1" },
          {
            sender: buildTelegramSelfSenderName("OpenClaw"),
            body: "self marker body",
            timestamp: 2,
            messageId: "2",
          },
          { sender: "Riley", body: "after watermark", timestamp: 3, messageId: "3" },
        ],
      ],
    ]);
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
    };

    const userRequest = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        ...buildForumMessage(99),
        message_id: 4,
        text: "@bot answer after watermark",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(userRequest?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(JSON.stringify(userRequest?.ctxPayload.ChannelStructuredContext)).toContain(
      "after watermark",
    );
    expect(JSON.stringify(userRequest?.ctxPayload.ChannelStructuredContext)).not.toContain(
      "before self marker",
    );
    expect(JSON.stringify(userRequest?.ctxPayload.ChannelStructuredContext)).not.toContain(
      "self marker body",
    );
    expect(userRequest?.ctxPayload.Body).not.toContain("before self marker");
    expect(userRequest?.ctxPayload.Body).not.toContain("self marker body");
    expect(userRequest?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "after watermark" }),
    ]);

    const roomEvent = await buildTelegramMessageContextForTest({
      cfg,
      message: { ...buildForumMessage(99), message_id: 5, text: "ambient after watermark" },
      historyLimit: 10,
      groupHistories,
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(roomEvent?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(JSON.stringify(roomEvent?.ctxPayload.ChannelStructuredContext)).toContain(
      "before self marker",
    );
    expect(JSON.stringify(roomEvent?.ctxPayload.ChannelStructuredContext)).toContain(
      "self marker body",
    );
    expect(JSON.stringify(roomEvent?.ctxPayload.ChannelStructuredContext)).toContain(
      "after watermark",
    );
    expect(roomEvent?.ctxPayload.Body).not.toContain("before self marker");
    expect(roomEvent?.ctxPayload.InboundHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "before self marker" }),
        expect.objectContaining({ body: "self marker body", sender: "OpenClaw (you)" }),
        expect.objectContaining({ body: "after watermark" }),
      ]),
    );
  });

  it("lets explicit topic requireMention=false override mention activation", async () => {
    const resolveGroupActivation = vi.fn(() => true);

    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram context payload when topic disables requireMention");
    }
    const activationCalls = resolveGroupActivation.mock.calls as unknown as Array<
      [{ chatId: number; messageThreadId?: number; sessionKey: string }]
    >;
    const [activationOptions] = activationCalls[0] ?? [];
    expect(activationOptions?.chatId).toBe(-1001234567890);
    expect(activationOptions?.messageThreadId).toBe(99);
    expect(activationOptions?.sessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
  });

  it("lets explicit topic requireMention=true override always activation", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { requireMention: true },
      }),
    });

    expect(ctx).toBeNull();
  });

  it("keeps activation fallback when no topic requireMention is configured", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { agentId: "main" },
      }),
    });

    if (!ctx) {
      throw new Error("expected Telegram context when topic config keeps agent");
    }
  });
});
