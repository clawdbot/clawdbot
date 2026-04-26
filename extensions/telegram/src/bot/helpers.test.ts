import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  expandTextLinks,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  normalizeForwardedContext,
  resolveTelegramDirectPeerId,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
  resetTelegramForumFlagCacheForTest,
} from "./helpers.js";

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
    // id=0 should be included for forum and none scopes (not falsy)
    { input: { id: 0, scope: "forum" as const }, expected: { message_thread_id: 0 } },
    { input: { id: 0, scope: "none" as const }, expected: { message_thread_id: 0 } },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
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
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("News");
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.fromChatType).toBe("channel");
  });
});

describe("describeReplyTarget", () => {
  it("returns null when no reply_to_message", () => {
    const result = describeReplyTarget({
      message_id: 1,
      date: 1000,
      chat: { id: 1, type: "private" },
    } as any);
    expect(result).toBeNull();
  });

  it("extracts basic reply info", () => {
    const result = describeReplyTarget({
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
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("Original message");
    expect(result?.sender).toBe("Alice");
    expect(result?.id).toBe("1");
    expect(result?.kind).toBe("reply");
    expect(result?.source).toBe("reply_to_message");
  });

  it("handles non-string reply text gracefully (issue #27201)", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        // Simulate edge case where text is an unexpected non-string value
        text: { some: "object" },
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as any);
    expect(result).toBeNull();
  });

  it("falls back to caption when reply text is malformed", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        text: { some: "object" },
        caption: "Caption body",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as any);
    expect(result?.body).toBe("Caption body");
    expect(result?.kind).toBe("reply");
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
    } as any);
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
    } as any);
    expect(result?.body).toBe("Original message");
    expect(result?.kind).toBe("reply");
  });

  it("falls back to external reply text when external quote text is binary", () => {
    const result = describeReplyTarget({
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
    } as any);
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
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("This is the forwarded content");
    expect(result?.id).toBe("2");
    // The reply target's forwarded context should be included
    expect(result?.forwardedFrom).toBeDefined();
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
    } as any);
    expect(result).not.toBeNull();
    expect(result?.forwardedFrom).toBeDefined();
    expect(result?.forwardedFrom?.from).toBe("Tech News (Editor)");
    expect(result?.forwardedFrom?.fromType).toBe("channel");
    expect(result?.forwardedFrom?.fromMessageId).toBe(456);
  });

  it("marks top-level quote metadata on external replies as external targets", () => {
    const result = describeReplyTarget({
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
    } as any);

    expect(result?.id).toBe("4");
    expect(result?.kind).toBe("quote");
    expect(result?.source).toBe("external_reply");
    expect(result?.quoteText).toBe("quoted slice");
    expect(result?.quotePosition).toBe(4);
    expect(result?.quoteEntities).toEqual([{ type: "italic", offset: 0, length: 6 }]);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = describeReplyTarget({
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
    } as any);
    expect(result).not.toBeNull();
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
  it("strips binary caption content to prevent token explosion", () => {
    const binaryCaption = "PK\x03\x04\x14\x00\x08binary-ebook-data";
    const result = getTelegramTextParts({
      caption: binaryCaption,
      caption_entities: [{ type: "mention", offset: 0, length: 5 }],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as any);
    expect(result.text).toBe("");
    expect(result.entities).toEqual([]);
  });

  it("preserves normal caption text", () => {
    const result = getTelegramTextParts({
      caption: "Here is my document",
      caption_entities: [],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as any);
    expect(result.text).toBe("Here is my document");
  });

  it("strips binary content in msg.text as well", () => {
    const result = getTelegramTextParts({
      text: "\x00\x01\x02 binary junk",
      entities: [{ type: "bold", offset: 0, length: 3 }],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as any);
    expect(result.text).toBe("");
    expect(result.entities).toEqual([]);
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
      } as any),
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
        } as any,
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
        } as any,
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
        } as any,
        "gaian",
      ),
    ).toBe(true);
  });

  it("matches mention followed by punctuation", () => {
    expect(
      hasBotMention(
        {
          text: "@gaian, what's up?",
          chat: { id: 1, type: "supergroup" },
        } as any,
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
        } as any,
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
        } as any,
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
        } as any,
        "gaian",
      ),
    ).toBe(false);
  });
});
describe("expandTextLinks", () => {
  it("returns text unchanged when no entities are provided", () => {
    expect(expandTextLinks("Hello world")).toBe("Hello world");
    expect(expandTextLinks("Hello world", null)).toBe("Hello world");
    expect(expandTextLinks("Hello world", [])).toBe("Hello world");
  });

  it("returns text unchanged when there are no text_link entities", () => {
    const entities = [
      { type: "mention", offset: 0, length: 5 },
      { type: "bold", offset: 6, length: 5 },
    ];
    expect(expandTextLinks("@user hello", entities)).toBe("@user hello");
  });

  it("expands a single text_link entity", () => {
    const text = "Check this link for details";
    const entities = [{ type: "text_link", offset: 11, length: 4, url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(
      "Check this [link](https://example.com) for details",
    );
  });

  it("expands multiple text_link entities", () => {
    const text = "Visit Google or GitHub for more";
    const entities = [
      { type: "text_link", offset: 6, length: 6, url: "https://google.com" },
      { type: "text_link", offset: 16, length: 6, url: "https://github.com" },
    ];
    expect(expandTextLinks(text, entities)).toBe(
      "Visit [Google](https://google.com) or [GitHub](https://github.com) for more",
    );
  });

  it("handles adjacent text_link entities", () => {
    const text = "AB";
    const entities = [
      { type: "text_link", offset: 0, length: 1, url: "https://a.example" },
      { type: "text_link", offset: 1, length: 1, url: "https://b.example" },
    ];
    expect(expandTextLinks(text, entities)).toBe("[A](https://a.example)[B](https://b.example)");
  });

  it("preserves offsets from the original string", () => {
    const text = " Hello world";
    const entities = [{ type: "text_link", offset: 1, length: 5, url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(" [Hello](https://example.com) world");
  });
});
