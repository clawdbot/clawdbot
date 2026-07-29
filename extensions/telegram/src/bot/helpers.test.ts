// Telegram tests cover helpers plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTelegramTextEntities } from "./body-helpers.js";
import {
  buildTelegramInboundOriginTarget,
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  normalizeForwardedContext,
  resolveTelegramDirectPeerId,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
  resetTelegramForumFlagCacheForTest,
  shouldUseTelegramDmThreadSession,
} from "./helpers.js";

type TelegramMessage = Parameters<typeof normalizeForwardedContext>[0];

function asMalformedTelegramMessage(message: unknown): TelegramMessage {
  return message as TelegramMessage;
}

describe("resolveTelegramForumThreadId", () => {
  it.each([
    { isForum: false, messageThreadId: 42 },
    { isForum: false, messageThreadId: undefined },
    { isForum: undefined, messageThreadId: 99 },
  ])("returns undefined for non-forum groups", (params) => {
    // Reply threads in regular groups should not create separate sessions.
    expect(resolveTelegramForumThreadId(params)).toBeUndefined();
  });

  it.each([
    { isForum: true, messageThreadId: undefined, expected: 1 },
    { isForum: true, messageThreadId: null, expected: 1 },
    { isForum: true, messageThreadId: 99, expected: 99 },
  ])("resolves forum topic ids", ({ expected, ...params }) => {
    expect(resolveTelegramForumThreadId(params)).toBe(expected);
  });
});

describe("resolveTelegramForumFlag", () => {
  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps explicit forum metadata when Telegram already provides it", async () => {
    const getChat = vi.fn(async () => ({ is_forum: false }));
    await expect(
      resolveTelegramForumFlag({
        chatId: -100123,
        chatType: "supergroup",
        isGroup: true,
        isForum: true,
        getChat,
      }),
    ).resolves.toBe(true);
    expect(getChat).not.toHaveBeenCalled();
  });

  it("falls back to getChat for supergroups when is_forum is omitted", async () => {
    const getChat = vi.fn(async () => ({ is_forum: true }));
    await expect(
      resolveTelegramForumFlag({
        chatId: -100789,
        chatType: "supergroup",
        isGroup: true,
        getChat,
      }),
    ).resolves.toBe(true);
    expect(getChat).toHaveBeenCalledWith(-100789);
  });

  it("uses supergroup topic-message metadata before getChat lookup", async () => {
    const getChat = vi.fn(async () => {
      throw new Error("lookup should not run");
    });
    await expect(
      resolveTelegramForumFlag({
        chatId: -100987,
        chatType: "supergroup",
        isGroup: true,
        isTopicMessage: true,
        getChat,
      }),
    ).resolves.toBe(true);
    expect(getChat).not.toHaveBeenCalled();
  });

  it("does not treat private DM topic metadata as forum metadata", async () => {
    const getChat = vi.fn(async () => ({ is_forum: true }));
    await expect(
      resolveTelegramForumFlag({
        chatId: 123456,
        chatType: "private",
        isGroup: false,
        isTopicMessage: true,
        getChat,
      }),
    ).resolves.toBe(false);
    expect(getChat).not.toHaveBeenCalled();
  });

  it("reuses resolved forum metadata for later supergroup updates", async () => {
    const getChat = vi.fn(async () => ({ is_forum: true }));
    const params = {
      chatId: -100456,
      chatType: "supergroup" as const,
      isGroup: true,
      getChat,
    };
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    expect(getChat).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached forum metadata from explicit Telegram updates", async () => {
    const getChat = vi.fn(async () => ({ is_forum: true }));
    const params = {
      chatId: -100654,
      chatType: "supergroup" as const,
      isGroup: true,
      getChat,
    };
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    await expect(resolveTelegramForumFlag({ ...params, isForum: false })).resolves.toBe(false);
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(false);
    expect(getChat).toHaveBeenCalledTimes(1);
  });

  it("drops cached forum metadata when the current clock is not a valid date timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const getChat = vi.fn(async () => ({ is_forum: true }));
    const params = {
      chatId: -100655,
      chatType: "supergroup" as const,
      isGroup: true,
      getChat,
    };
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    nowSpy.mockReturnValue(Number.NaN);
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    expect(getChat).toHaveBeenCalledTimes(2);
  });

  it("does not cache forum metadata when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const getChat = vi.fn(async () => ({ is_forum: true }));
    const params = {
      chatId: -100656,
      chatType: "supergroup" as const,
      isGroup: true,
      getChat,
    };
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    await expect(resolveTelegramForumFlag(params)).resolves.toBe(true);
    expect(getChat).toHaveBeenCalledTimes(2);
  });

  it("returns false when forum lookup is unavailable", async () => {
    const getChat = vi.fn(async () => {
      throw new Error("lookup failed");
    });
    await expect(
      resolveTelegramForumFlag({
        chatId: -100999,
        chatType: "supergroup",
        isGroup: true,
        getChat,
      }),
    ).resolves.toBe(false);
  });
});

describe("buildTelegramThreadParams", () => {
  it.each([
    { input: { id: 1, scope: "forum" as const }, expected: undefined },
    { input: { id: 99, scope: "forum" as const }, expected: { message_thread_id: 99 } },
    { input: { id: 1, scope: "dm" as const }, expected: { message_thread_id: 1 } },
    { input: { id: 2, scope: "dm" as const }, expected: { message_thread_id: 2 } },
    { input: { id: 0, scope: "dm" as const }, expected: undefined },
    { input: { id: -1, scope: "dm" as const }, expected: undefined },
    { input: { id: 1.9, scope: "dm" as const }, expected: { message_thread_id: 1 } },
    // id=0 should be included for forum scope (not falsy).
    { input: { id: 0, scope: "forum" as const }, expected: { message_thread_id: 0 } },
    { input: { id: 42, scope: "none" as const }, expected: undefined },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
  });
});

describe("shouldUseTelegramDmThreadSession", () => {
  it("requires a DM thread id", () => {
    expect(
      shouldUseTelegramDmThreadSession({
        botHasTopicsEnabled: true,
      }),
    ).toBe(false);
  });

  it("keeps DM thread ids flat when bot topics are not enabled", () => {
    expect(shouldUseTelegramDmThreadSession({ dmThreadId: 42 })).toBe(false);
    expect(
      shouldUseTelegramDmThreadSession({
        dmThreadId: 42,
        botHasTopicsEnabled: false,
      }),
    ).toBe(false);
  });

  it("uses DM thread sessions when Telegram reports bot topics enabled", () => {
    expect(
      shouldUseTelegramDmThreadSession({
        dmThreadId: 42,
        botHasTopicsEnabled: true,
      }),
    ).toBe(true);
  });
});

describe("resolveTelegramBotHasTopicsEnabled", () => {
  it("trusts only Telegram getMe has_topics_enabled=true", () => {
    expect(resolveTelegramBotHasTopicsEnabled({ has_topics_enabled: true })).toBe(true);
    expect(resolveTelegramBotHasTopicsEnabled({ has_topics_enabled: false })).toBe(false);
    expect(resolveTelegramBotHasTopicsEnabled({ has_topics_enabled: "true" })).toBe(false);
    expect(resolveTelegramBotHasTopicsEnabled(null)).toBe(false);
  });
});

describe("buildTelegramRoutingTarget", () => {
  it.each([
    {
      name: "keeps General forum topic chat-scoped",
      chatId: -100123,
      thread: { id: 1, scope: "forum" as const },
      expected: "telegram:-100123",
    },
    {
      name: "includes real forum topic ids",
      chatId: -100123,
      thread: { id: 42, scope: "forum" as const },
      expected: "telegram:-100123:topic:42",
    },
    {
      name: "falls back to bare chat when thread is missing",
      chatId: -100123,
      thread: null,
      expected: "telegram:-100123",
    },
  ])("$name", ({ chatId, thread, expected }) => {
    expect(buildTelegramRoutingTarget(chatId, thread)).toBe(expected);
  });
});

describe("buildTelegramInboundOriginTarget", () => {
  it.each([
    {
      name: "keeps DM topic thread ids out of the origin target",
      chatId: 42,
      thread: { id: 77, scope: "dm" as const },
      expected: "telegram:42",
    },
    {
      name: "keeps regular groups chat-scoped",
      chatId: -100123,
      thread: { scope: "none" as const },
      expected: "telegram:-100123",
    },
    {
      name: "keeps General forum topic chat-scoped",
      chatId: -100123,
      thread: { id: 1, scope: "forum" as const },
      expected: "telegram:-100123",
    },
    {
      name: "includes real forum topic ids",
      chatId: -100123,
      thread: { id: 42, scope: "forum" as const },
      expected: "telegram:-100123:topic:42",
    },
  ])("$name", ({ chatId, thread, expected }) => {
    expect(buildTelegramInboundOriginTarget(chatId, thread)).toBe(expected);
  });
});

describe("buildTypingThreadParams", () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: 1, expected: { message_thread_id: 1 } },
  ])("builds typing params", ({ input, expected }) => {
    expect(buildTypingThreadParams(input)).toEqual(expected);
  });
});

describe("resolveTelegramDirectPeerId", () => {
  it("prefers sender id when available", () => {
    expect(resolveTelegramDirectPeerId({ chatId: 777777777, senderId: 123456789 })).toBe(
      "123456789",
    );
  });

  it("falls back to chat id when sender id is missing", () => {
    expect(resolveTelegramDirectPeerId({ chatId: 777777777, senderId: undefined })).toBe(
      "777777777",
    );
  });
});

describe("thread id normalization", () => {
  it.each([
    {
      build: () => buildTelegramThreadParams({ id: 42.9, scope: "forum" }),
      expected: { message_thread_id: 42 },
    },
    {
      build: () => buildTypingThreadParams(42.9),
      expected: { message_thread_id: 42 },
    },
  ])("normalizes thread ids to integers", ({ build, expected }) => {
    expect(build()).toEqual(expected);
  });
});

describe("normalizeForwardedContext", () => {
  it("handles forward_origin users", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "user",
        sender_user: { first_name: "Ada", last_name: "Lovelace", username: "ada", id: 42 },
        date: 123,
      },
    } as TelegramMessage);
    expect(ctx?.from).toBe("Ada Lovelace (@ada)");
    expect(ctx?.fromType).toBe("user");
    expect(ctx?.fromId).toBe("42");
    expect(ctx?.fromUsername).toBe("ada");
    expect(ctx?.fromTitle).toBe("Ada Lovelace");
    expect(ctx?.date).toBe(123);
  });

  it("handles hidden forward_origin names", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: { type: "hidden_user", sender_user_name: "Hidden Name", date: 456 },
    } as TelegramMessage);
    expect(ctx?.from).toBe("Hidden Name");
    expect(ctx?.fromType).toBe("hidden_user");
    expect(ctx?.fromTitle).toBe("Hidden Name");
    expect(ctx?.date).toBe(456);
  });

  it("handles forward_origin channel with author_signature and message_id", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: {
          title: "Tech News",
          username: "technews",
          id: -1001234,
          type: "channel",
        },
        date: 500,
        author_signature: "Editor",
        message_id: 42,
      },
    } as TelegramMessage);
    expect(ctx?.from).toBe("Tech News (Editor)");
    expect(ctx?.fromType).toBe("channel");
    expect(ctx?.fromId).toBe("-1001234");
    expect(ctx?.fromUsername).toBe("technews");
    expect(ctx?.fromTitle).toBe("Tech News");
    expect(ctx?.fromSignature).toBe("Editor");
    expect(ctx?.fromChatType).toBe("channel");
    expect(ctx?.fromMessageId).toBe(42);
    expect(ctx?.date).toBe(500);
  });

  it("handles forward_origin chat with sender_chat and author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "chat",
        sender_chat: {
          title: "Discussion Group",
          id: -1005678,
          type: "supergroup",
        },
        date: 600,
        author_signature: "Admin",
      },
    } as TelegramMessage);
    expect(ctx?.from).toBe("Discussion Group (Admin)");
    expect(ctx?.fromType).toBe("chat");
    expect(ctx?.fromId).toBe("-1005678");
    expect(ctx?.fromTitle).toBe("Discussion Group");
    expect(ctx?.fromSignature).toBe("Admin");
    expect(ctx?.fromChatType).toBe("supergroup");
    expect(ctx?.date).toBe(600);
  });

  it("uses author_signature from forward_origin", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "My Channel", id: -100999, type: "channel" },
        date: 700,
        author_signature: "New Sig",
        message_id: 1,
      },
    } as TelegramMessage);
    expect(ctx?.fromSignature).toBe("New Sig");
    expect(ctx?.from).toBe("My Channel (New Sig)");
  });

  it("returns undefined signature when author_signature is blank", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "Updates", id: -100333, type: "channel" },
        date: 860,
        author_signature: "   ",
        message_id: 1,
      },
    } as TelegramMessage);
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.from).toBe("Updates");
  });

  it("handles forward_origin channel without author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "News", id: -100111, type: "channel" },
        date: 900,
        message_id: 1,
      },
    } as TelegramMessage);
    expect(ctx?.from).toBe("News");
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.fromChatType).toBe("channel");
  });
});

describe("describeReplyTarget", () => {
  it("returns null when no reply_to_message", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 1,
        date: 1000,
        chat: { id: 1, type: "private" },
      }),
    );
    expect(result).toBeNull();
  });

  it("extracts basic reply info", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private" },
          text: "Original message",
          from: { id: 42, first_name: "Alice", is_bot: false },
        },
      }),
    );
    expect(result?.body).toBe("Original message");
    expect(result?.sender).toBe("Alice");
    expect(result?.id).toBe("1");
    expect(result?.kind).toBe("reply");
    expect(result?.source).toBe("reply_to_message");
  });

  it("handles non-string reply text gracefully (issue #27201)", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private", first_name: "Test" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private", first_name: "Test" },
          // Simulate edge case where text is an unexpected non-string value
          text: { some: "object" },
          from: { id: 42, first_name: "Alice", is_bot: false },
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("falls back to caption when reply text is malformed", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private", first_name: "Test" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private", first_name: "Test" },
          text: { some: "object" },
          caption: "Caption body",
          from: { id: 42, first_name: "Alice", is_bot: false },
        },
      }),
    );
    expect(result?.body).toBe("Caption body");
    expect(result?.kind).toBe("reply");
  });

  it("describes rich-message-only reply targets with a sanitized placeholder", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private", first_name: "Test" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private", first_name: "Test" },
        rich_message: { blocks: [{ type: "paragraph" }] },
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as TelegramMessage);

    expect(result?.body).toBe("[unsupported Telegram rich_message received]");
    expect(result?.quoteSourceText).toBeUndefined();
  });

  it("describes rich-message-only reply targets with rich text", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private", first_name: "Test" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: "Forwarded reply text",
            },
          ],
        },
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as never);

    expect(result?.body).toBe("Forwarded reply text");
    expect(result?.quoteSourceText).toBeUndefined();
  });

  it("describes rich-message-only reply targets with canonical block text", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        rich_message: {
          blocks: [
            {
              type: "details",
              summary: "Run summary",
              blocks: [
                {
                  type: "list",
                  items: [
                    {
                      label: "1.",
                      blocks: [{ type: "paragraph", text: "CI clean" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "mathematical_expression",
              expression: "a^2+b^2=c^2",
            },
            {
              type: "photo",
              caption: { text: "Chart", credit: "OpenClaw" },
            },
          ],
        },
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as never);

    expect(result?.body).toBe("Run summary\n1.\nCI clean\na^2+b^2=c^2\nChart\nOpenClaw");
    expect(result?.quoteSourceText).toBeUndefined();
  });

  it("drops binary reply captions with no safe fallback", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        caption: "PK\x00\x03\x04binary",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as TelegramMessage);
    expect(result?.id).toBe("1");
    expect(result?.sender).toBe("Alice");
    expect(result?.body).toBeUndefined();
  });

  it("falls back to reply text when quote text is binary", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      quote: {
        text: "\x00\x01\x02binary quote",
      },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        text: "Original message",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as TelegramMessage);
    expect(result?.body).toBe("Original message");
    expect(result?.kind).toBe("reply");
  });

  it("falls back to external reply text when external quote text is binary", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
          quote: {
            text: "PK\x00\x03\x04binary quote",
          },
          from: { id: 123, first_name: "Eve", is_bot: false },
        },
      }),
    );
    expect(result?.body).toBe("Forwarded from elsewhere");
    expect(result?.kind).toBe("reply");
  });

  it("extracts forwarded context from reply_to_message (issue #9619)", () => {
    // When user forwards a message with a comment, the comment message has
    // reply_to_message pointing to the forwarded message. We should extract
    // the forward_origin from the reply target.
    const result = describeReplyTarget({
      message_id: 3,
      date: 1100,
      chat: { id: 1, type: "private" },
      text: "Here is my comment about this forwarded content",
      reply_to_message: {
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private" },
        text: "This is the forwarded content",
        forward_origin: {
          type: "user",
          sender_user: {
            id: 999,
            first_name: "Bob",
            last_name: "Smith",
            username: "bobsmith",
            is_bot: false,
          },
          date: 500,
        },
      },
    } as TelegramMessage);
    expect(result?.body).toBe("This is the forwarded content");
    expect(result?.id).toBe("2");
    expect(result?.forwardedFrom?.from).toBe("Bob Smith (@bobsmith)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("999");
    expect(result?.forwardedFrom?.date).toBe(500);
  });

  it("extracts forwarded context from channel forward in reply_to_message", () => {
    const result = describeReplyTarget({
      message_id: 4,
      date: 1200,
      chat: { id: 1, type: "private" },
      text: "Interesting article!",
      reply_to_message: {
        message_id: 3,
        date: 1100,
        chat: { id: 1, type: "private" },
        text: "Channel post content here",
        forward_origin: {
          type: "channel",
          chat: { id: -1001234567, title: "Tech News", username: "technews", type: "channel" },
          date: 800,
          message_id: 456,
          author_signature: "Editor",
        },
      },
    } as TelegramMessage);
    expect(result?.forwardedFrom?.from).toBe("Tech News (Editor)");
    expect(result?.forwardedFrom?.fromType).toBe("channel");
    expect(result?.forwardedFrom?.fromMessageId).toBe(456);
  });

  it("marks top-level quote metadata on external replies as external targets", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        quote: {
          text: "quoted slice",
          position: 4,
          entities: [{ type: "italic", offset: 0, length: 6 }],
        },
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
          from: { id: 123, first_name: "Eve", is_bot: false },
        },
      }),
    );

    expect(result?.id).toBe("4");
    expect(result?.kind).toBe("quote");
    expect(result?.source).toBe("external_reply");
    expect(result?.quoteText).toBe("quoted slice");
    expect(result?.quotePosition).toBe(4);
    expect(result?.quoteEntities).toEqual([{ type: "italic", offset: 0, length: 6 }]);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
          forward_origin: {
            type: "user",
            sender_user: {
              id: 123,
              first_name: "Eve",
              last_name: "Stone",
              username: "eve",
              is_bot: false,
            },
            date: 700,
          },
        },
      }),
    );
    expect(result?.id).toBe("4");
    expect(result?.forwardedFrom?.from).toBe("Eve Stone (@eve)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("123");
    expect(result?.forwardedFrom?.date).toBe(700);
  });
});

describe("isBinaryContent", () => {
  it("returns false for normal user text", () => {
    expect(isBinaryContent("Hello, world!")).toBe(false);
  });

  it("returns false for text with common whitespace (tabs, newlines)", () => {
    expect(isBinaryContent("line one\nline two\ttab")).toBe(false);
  });

  it("returns true for string containing null bytes", () => {
    expect(isBinaryContent("PK\x00\x03\x04")).toBe(true);
  });

  it("returns true for typical binary file header bytes", () => {
    const mobiBinarySnippet = "\x00\x00\x00\x01BOOKMOBI\x00\x00\x02\x0E";
    expect(isBinaryContent(mobiBinarySnippet)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isBinaryContent("")).toBe(false);
  });
});

describe("getTelegramTextParts — binary caption filtering (#66647)", () => {
  it("keeps rich-message-only updates out of canonical text", () => {
    const result = getTelegramTextParts({
      rich_message: { blocks: [{ type: "paragraph" }] },
    });

    expect(result).toEqual({ text: "", entities: [] });
  });

  it("keeps normal text when Telegram also supplies a rich message", () => {
    const result = getTelegramTextParts({
      text: "normal text",
      rich_message: { blocks: [{ type: "paragraph" }] },
    });

    expect(result).toEqual({ text: "normal text", entities: [] });
  });

  it("strips binary caption content to prevent token explosion", () => {
    const binaryCaption = "PK\x03\x04\x14\x00\x08binary-ebook-data";
    const result = getTelegramTextParts({
      caption: binaryCaption,
      caption_entities: [{ type: "mention", offset: 0, length: 5 }],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as TelegramMessage);
    expect(result.text).toBe("");
    expect(result.entities).toStrictEqual([]);
  });

  it("preserves normal caption text", () => {
    const result = getTelegramTextParts(
      asMalformedTelegramMessage({
        caption: "Here is my document",
        caption_entities: [],
        chat: { id: 1, type: "private" },
        date: 1,
        message_id: 1,
      }),
    );
    expect(result.text).toBe("Here is my document");
  });

  it("strips binary content in msg.text as well", () => {
    const result = getTelegramTextParts({
      text: "\x00\x01\x02 binary junk",
      entities: [{ type: "bold", offset: 0, length: 3 }],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as TelegramMessage);
    expect(result.text).toBe("");
    expect(result.entities).toStrictEqual([]);
  });
});

describe("hasBotMention", () => {
  it("prefers caption text and caption entities when message text is absent", () => {
    expect(
      getTelegramTextParts({
        caption: "@gaian hello",
        caption_entities: [{ type: "mention", offset: 0, length: 6 }],
        chat: { id: 1, type: "private" },
        date: 1,
        message_id: 1,
      } as TelegramMessage),
    ).toEqual({
      text: "@gaian hello",
      entities: [{ type: "mention", offset: 0, length: 6 }],
    });
  });

  it("matches exact username mentions from plain text", () => {
    expect(
      hasBotMention(
        {
          text: "@gaian what is the group id?",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
  });

  it("does not match mention prefixes from longer bot usernames", () => {
    expect(
      hasBotMention(
        {
          text: "@GaianChat_Bot what is the group id?",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(false);
  });

  it("still matches exact mention entities", () => {
    expect(
      hasBotMention(
        {
          text: "@GaianChat_Bot hi @gaian",
          entities: [{ type: "mention", offset: 18, length: 6 }],
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
  });

  it("matches bot command entities addressed to this bot", () => {
    const text = "/deploy@gaian check status";

    expect(
      hasBotMention(
        {
          text,
          entities: [{ type: "bot_command", offset: 0, length: "/deploy@gaian".length }],
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
  });

  it("does not match bot command entities addressed to another bot", () => {
    const text = "/deploy@other_bot check status";

    expect(
      hasBotMention(
        {
          text,
          entities: [{ type: "bot_command", offset: 0, length: "/deploy@other_bot".length }],
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(false);
  });

  it("matches mention followed by punctuation", () => {
    expect(
      hasBotMention(
        {
          text: "@gaian, what's up?",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
  });

  it("matches mention followed by space", () => {
    expect(
      hasBotMention(
        {
          text: "@gaian how are you",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
  });

  it("does not match substring of a longer username", () => {
    expect(
      hasBotMention(
        {
          text: "@gaianchat_bot hello",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(false);
  });

  it("does not match when mention is a prefix of another word", () => {
    expect(
      hasBotMention(
        {
          text: "@gaianbot do something",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(false);
  });
});

describe("renderTelegramTextEntities", () => {
  it("renders Telegram formatting entities as markdown", () => {
    const text = "bold italic code strike underline spoiler";
    const entities = [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 5, length: 6 },
      { type: "code", offset: 12, length: 4 },
      { type: "strikethrough", offset: 17, length: 6 },
      { type: "underline", offset: 24, length: 9 },
      { type: "spoiler", offset: 34, length: 7 },
    ];

    expect(renderTelegramTextEntities(text, entities)).toBe(
      "**bold** _italic_ `code` ~~strike~~ __underline__ ||spoiler||",
    );
  });

  it("renders pre entities with language fences", () => {
    const text = "const value = 1;";
    const entities = [{ type: "pre", offset: 0, length: text.length, language: "ts" }];

    expect(renderTelegramTextEntities(text, entities)).toBe("```ts\nconst value = 1;\n```");
  });

  it("uses a pre fence that cannot close inside content", () => {
    const text = "before\n```\ninside";
    const entities = [{ type: "pre", offset: 0, length: text.length, language: "md" }];

    expect(renderTelegramTextEntities(text, entities)).toBe("````md\nbefore\n```\ninside\n````");
  });

  it("renders links and formatting from original offsets", () => {
    const text = "Read docs now";
    const entities = [
      { type: "bold", offset: 5, length: 4 },
      { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
      { type: "italic", offset: 10, length: 3 },
    ];

    expect(renderTelegramTextEntities(text, entities)).toBe(
      "Read **[docs](https://docs.example)** _now_",
    );
  });

  it("uses UTF-16 Telegram offsets", () => {
    const text = "Hi 😀 bold";
    const entities = [{ type: "bold", offset: 6, length: 4 }];

    expect(renderTelegramTextEntities(text, entities)).toBe("Hi 😀 **bold**");
  });
});
