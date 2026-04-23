import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { TELEGRAM_FORUM_SERVICE_FIELDS } from "./forum-service-message.js";

describe("buildTelegramMessageContext implicitMention forum service messages", () => {
  /**
   * Build a group message context where the user sends a message inside a
   * forum topic that has `reply_to_message` pointing to a message from the
   * bot.  Callers control whether the reply target looks like a forum service
   * message (carries `forum_topic_created` etc.) or a real bot reply.
   */
  async function buildGroupReplyCtx(params: {
    replyToMessageText?: string;
    replyToMessageCaption?: string;
    replyFromIsBot?: boolean;
    replyFromId?: number;
    /** Extra fields on reply_to_message (e.g. forum_topic_created). */
    replyToMessageExtra?: Record<string, unknown>;
  }) {
    const BOT_ID = 7; // matches test harness primaryCtx.me.id
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum Group" },
        date: 1700000000,
        text: "hello everyone",
        from: { id: 42, first_name: "Alice" },
        reply_to_message: {
          message_id: 1,
          text: params.replyToMessageText ?? undefined,
          ...(params.replyToMessageCaption != null
            ? { caption: params.replyToMessageCaption }
            : {}),
          from: {
            id: params.replyFromId ?? BOT_ID,
            first_name: "OpenClaw",
            is_bot: params.replyFromIsBot ?? true,
          },
          ...params.replyToMessageExtra,
        },
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });
  }

  it("does NOT trigger implicitMention for forum_topic_created service message", async () => {
    // Bot auto-generated "Topic created" message carries forum_topic_created.
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyFromIsBot: true,
      replyToMessageExtra: {
        forum_topic_created: { name: "New Topic", icon_color: 0x6fb9f0 },
      },
    });

    // With requireMention and no explicit @mention, the message should be
    // skipped (null) because implicitMention should NOT fire.
    expect(ctx).toBeNull();
  });

  it.each(TELEGRAM_FORUM_SERVICE_FIELDS)(
    "does NOT trigger implicitMention for %s service message",
    async (field) => {
      const ctx = await buildGroupReplyCtx({
        replyToMessageText: undefined,
        replyFromIsBot: true,
        replyToMessageExtra: { [field]: {} },
      });

      expect(ctx).toBeNull();
    },
  );

  it("does NOT trigger implicitMention for forum_topic_closed service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyFromIsBot: true,
      replyToMessageExtra: { forum_topic_closed: {} },
    });

    expect(ctx).toBeNull();
  });

  it("does NOT trigger implicitMention for general_forum_topic_hidden service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyFromIsBot: true,
      replyToMessageExtra: { general_forum_topic_hidden: {} },
    });

    expect(ctx).toBeNull();
  });

  it("DOES trigger implicitMention for real bot replies (non-empty text)", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "Here is my answer",
      replyFromIsBot: true,
    });

    // Real bot reply → implicitMention fires → message is NOT skipped.
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot media messages with caption", async () => {
    // Media messages from the bot have caption but no text — they should
    // still count as real bot replies, not service messages.
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyToMessageCaption: "Check out this image",
      replyFromIsBot: true,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("DOES trigger implicitMention for bot sticker/voice (no text, no caption, no service field)", async () => {
    // Stickers, voice notes, and captionless photos have neither text nor
    // caption, but they are NOT service messages — they are legitimate bot
    // replies that should trigger implicitMention.
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: undefined,
      replyFromIsBot: true,
      // No forum_topic_* fields → not a service message
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });

  it("does NOT trigger implicitMention when reply is from a different user", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "some message",
      replyFromIsBot: false,
      replyFromId: 999,
    });

    // Different user's message → not an implicit mention → skipped.
    expect(ctx).toBeNull();
  });
});
