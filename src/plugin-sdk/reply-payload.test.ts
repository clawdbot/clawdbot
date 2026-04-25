import { describe, expect, it, vi } from "vitest";
import {
  countOutboundMedia,
  createNormalizedOutboundDeliverer,
  deliverFormattedTextWithAttachments,
  deliverTextOrMediaReply,
  hasOutboundMedia,
  hasOutboundReplyContent,
  hasOutboundText,
  isReasoningReplyPayload,
  isNumericTargetId,
  normalizeOutboundReplyPayload,
  resolveOutboundMediaUrls,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendTextMediaPayload,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";

describe("isReasoningReplyPayload", () => {
  it.each([
    { name: "flagged", payload: { text: "Visible", isReasoning: true }, expected: true },
    { name: "prefix", payload: { text: "  \n Reasoning:\n_hidden_" }, expected: true },
    { name: "blockquote", payload: { text: "> Reasoning:\n> _hidden_" }, expected: true },
    {
      name: "mid-message mention",
      payload: { text: "Intro\nReasoning: visible discussion" },
      expected: false,
    },
    { name: "missing text", payload: {}, expected: false },
  ])("$name", ({ payload, expected }) => {
    expect(isReasoningReplyPayload(payload)).toBe(expected);
  });
});

describe("sendPayloadWithChunkedTextAndMedia", () => {
  it("returns empty result when payload has no text and no media", async () => {
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: {} },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(result).toEqual({ channel: "test", messageId: "" });
  });

  it("sends first media with text and remaining media without text", async () => {
    const calls: Array<{ text: string; mediaUrl: string }> = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: {
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
      },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async (ctx) => {
        calls.push({ text: ctx.text, mediaUrl: ctx.mediaUrl });
        return { channel: "test", messageId: ctx.mediaUrl };
      },
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(calls).toEqual([
      { text: "hello", mediaUrl: "https://a" },
      { text: "", mediaUrl: "https://b" },
    ]);
    expect(result).toEqual({ channel: "test", messageId: "https://b" });
  });

  it("chunks text and sends each chunk", async () => {
    const chunks: string[] = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: "alpha beta gamma" } },
      textChunkLimit: 5,
      chunker: () => ["alpha", "beta", "gamma"],
      sendText: async (ctx) => {
        chunks.push(ctx.text);
        return { channel: "test", messageId: ctx.text };
      },
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
    expect(result).toEqual({ channel: "test", messageId: "gamma" });
  });

  it("detects numeric target IDs", () => {
    expect(isNumericTargetId("12345")).toBe(true);
    expect(isNumericTargetId("  987  ")).toBe(true);
    expect(isNumericTargetId("ab12")).toBe(false);
    expect(isNumericTargetId("")).toBe(false);
  });
});

describe("sendTextMediaPayload", () => {
  it("uses an implicit single-use reply only for the first text chunk", async () => {
    const sendText = vi.fn(async ({ text }) => ({ channel: "test", messageId: text }));

    await sendTextMediaPayload({
      channel: "test",
      ctx: {
        cfg: {},
        to: "target",
        text: "",
        payload: { text: "abcdef" },
        replyToId: "reply-1",
        replyToIdSource: "implicit",
        replyToMode: "first",
      },
      adapter: {
        textChunkLimit: 2,
        chunker: (text) => ["ab", "cd", text.slice(4)],
        sendText,
      },
    });

    expect(sendText.mock.calls.map((call) => call[0].replyToId)).toEqual([
      "reply-1",
      undefined,
      undefined,
    ]);
  });

  it("uses an implicit single-use reply only for the first media fallback send", async () => {
    const sendMedia = vi.fn(async ({ mediaUrl }) => ({ channel: "test", messageId: mediaUrl }));

    await sendTextMediaPayload({
      channel: "test",
      ctx: {
        cfg: {},
        to: "target",
        text: "",
        payload: { text: "caption", mediaUrls: ["https://example.com/1", "https://example.com/2"] },
        replyToId: "reply-1",
        replyToIdSource: "implicit",
        replyToMode: "batched",
      },
      adapter: { sendMedia },
    });

    expect(sendMedia.mock.calls.map((call) => call[0].replyToId)).toEqual(["reply-1", undefined]);
  });

  it("preserves audioAsVoice on media fallback sends", async () => {
    const sendMedia = vi.fn(async ({ mediaUrl }) => ({ channel: "test", messageId: mediaUrl }));

    await sendTextMediaPayload({
      channel: "test",
      ctx: {
        cfg: {},
        to: "target",
        text: "",
        payload: {
          text: "caption",
          mediaUrls: ["https://example.com/voice.ogg", "https://example.com/next.ogg"],
          audioAsVoice: true,
        },
      },
      adapter: { sendMedia },
    });

    expect(sendMedia.mock.calls.map((call) => call[0].audioAsVoice)).toEqual([true, true]);
  });

  it("keeps explicit reply tags independent from single-use implicit reply modes", async () => {
    const sendText = vi.fn(async ({ text }) => ({ channel: "test", messageId: text }));

    await sendTextMediaPayload({
      channel: "test",
      ctx: {
        cfg: {},
        to: "target",
        text: "",
        payload: { text: "abcd" },
        replyToId: "explicit-reply",
        replyToIdSource: "explicit",
        replyToMode: "first",
      },
      adapter: {
        textChunkLimit: 2,
        chunker: () => ["ab", "cd"],
        sendText,
      },
    });

    expect(sendText.mock.calls.map((call) => call[0].replyToId)).toEqual([
      "explicit-reply",
      "explicit-reply",
    ]);
  });
});

describe("normalizeOutboundReplyPayload", () => {
  it("strips internal-only local media trust flags from loose payload objects", () => {
    expect(
      normalizeOutboundReplyPayload({
        text: "hello",
        mediaUrl: "/tmp/reply.opus",
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "abc123",
      }),
    ).toEqual({
      text: "hello",
      mediaUrl: "/tmp/reply.opus",
      sensitiveMedia: true,
      replyToId: "abc123",
    });
  });

  it("keeps the normalized deliverer from forwarding trustedLocalMedia", async () => {
    const handler = vi.fn(async () => {});
    const deliver = createNormalizedOutboundDeliverer(handler);

    await deliver({
      text: "hello",
      mediaUrl: "/tmp/reply.opus",
      trustedLocalMedia: true,
      sensitiveMedia: true,
    });

    expect(handler).toHaveBeenCalledWith({
      text: "hello",
      mediaUrl: "/tmp/reply.opus",
      sensitiveMedia: true,
      replyToId: undefined,
      mediaUrls: undefined,
    });
  });
});

describe("resolveOutboundMediaUrls", () => {
  it.each([
    {
      name: "prefers mediaUrls over the legacy single-media field",
      payload: {
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        mediaUrl: "https://example.com/legacy.png",
      },
      expected: ["https://example.com/a.png", "https://example.com/b.png"],
    },
    {
      name: "falls back to the legacy single-media field",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
      },
      expected: ["https://example.com/legacy.png"],
    },
  ])("$name", ({ payload, expected }) => {
    expect(resolveOutboundMediaUrls(payload)).toEqual(expected);
  });
});

describe("countOutboundMedia", () => {
  it.each([
    {
      name: "counts normalized media entries",
      payload: {
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
      expected: 2,
    },
    {
      name: "counts legacy single-media payloads",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
      },
      expected: 1,
    },
  ])("$name", ({ payload, expected }) => {
    expect(countOutboundMedia(payload)).toBe(expected);
  });
});

describe("hasOutboundMedia", () => {
  it("reports whether normalized payloads include media", () => {
    expect(hasOutboundMedia({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasOutboundMedia({ mediaUrl: "https://example.com/legacy.png" })).toBe(true);
    expect(hasOutboundMedia({})).toBe(false);
  });
});

describe("hasOutboundText", () => {
  it.each([
    {
      name: "checks raw text presence by default",
      payload: { text: "hello" },
      options: undefined,
      expected: true,
    },
    {
      name: "treats whitespace-only text as present by default",
      payload: { text: "   " },
      options: undefined,
      expected: true,
    },
    {
      name: "returns false when text is missing",
      payload: {},
      options: undefined,
      expected: false,
    },
    {
      name: "can trim whitespace-only text",
      payload: { text: "   " },
      options: { trim: true },
      expected: false,
    },
    {
      name: "keeps non-empty trimmed text",
      payload: { text: " hi " },
      options: { trim: true },
      expected: true,
    },
  ])("$name", ({ payload, options, expected }) => {
    expect(hasOutboundText(payload, options)).toBe(expected);
  });
});

describe("hasOutboundReplyContent", () => {
  it.each([
    {
      name: "detects text content",
      payload: { text: "hello" },
      options: undefined,
      expected: true,
    },
    {
      name: "detects media content",
      payload: { mediaUrl: "https://example.com/a.png" },
      options: undefined,
      expected: true,
    },
    {
      name: "returns false when text and media are both missing",
      payload: {},
      options: undefined,
      expected: false,
    },
    {
      name: "can ignore whitespace-only text",
      payload: { text: "   " },
      options: { trimText: true },
      expected: false,
    },
    {
      name: "still reports content when trimmed text is blank but media exists",
      payload: { text: "   ", mediaUrls: ["https://example.com/a.png"] },
      options: { trimText: true },
      expected: true,
    },
  ])("$name", ({ payload, options, expected }) => {
    expect(hasOutboundReplyContent(payload, options)).toBe(expected);
  });
});

describe("resolveSendableOutboundReplyParts", () => {
  it("normalizes missing text and trims media urls", () => {
    expect(
      resolveSendableOutboundReplyParts({
        mediaUrls: [" https://example.com/a.png ", "   "],
      }),
    ).toEqual({
      text: "",
      trimmedText: "",
      mediaUrls: ["https://example.com/a.png"],
      mediaCount: 1,
      hasText: false,
      hasMedia: true,
      hasContent: true,
    });
  });

  it("accepts transformed text overrides", () => {
    expect(
      resolveSendableOutboundReplyParts(
        {
          text: "ignored",
        },
        {
          text: "  hello  ",
        },
      ),
    ).toEqual({
      text: "  hello  ",
      trimmedText: "hello",
      mediaUrls: [],
      mediaCount: 0,
      hasText: true,
      hasMedia: false,
      hasContent: true,
    });
  });
});

describe("resolveTextChunksWithFallback", () => {
  it.each([
    {
      name: "returns existing chunks unchanged",
      text: "hello",
      chunks: ["a", "b"],
      expected: ["a", "b"],
    },
    {
      name: "falls back to the full text when chunkers return nothing",
      text: "hello",
      chunks: [],
      expected: ["hello"],
    },
    {
      name: "returns empty for empty text with no chunks",
      text: "",
      chunks: [],
      expected: [],
    },
  ])("$name", ({ text, chunks, expected }) => {
    expect(resolveTextChunksWithFallback(text, chunks)).toEqual(expected);
  });
});

describe("deliverTextOrMediaReply", () => {
  it("sends media first with caption only on the first attachment", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenNthCalledWith(1, {
      mediaUrl: "https://a",
      caption: "hello",
    });
    expect(sendMedia).toHaveBeenNthCalledWith(2, {
      mediaUrl: "https://b",
      caption: undefined,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falls back to chunked text delivery when there is no media", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "alpha beta gamma" },
        text: "alpha beta gamma",
        chunkText: () => ["alpha", "beta", "gamma"],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText).toHaveBeenNthCalledWith(1, "alpha");
    expect(sendText).toHaveBeenNthCalledWith(2, "beta");
    expect(sendText).toHaveBeenNthCalledWith(3, "gamma");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("returns empty when chunking produces no sendable text", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "   " },
        text: "   ",
        chunkText: () => [],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("empty");

    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("ignores blank media urls before sending", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["   ", " https://a "] },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith({
      mediaUrl: "https://a",
      caption: "hello",
    });
  });
});

describe("sendMediaWithLeadingCaption", () => {
  it("passes leading-caption metadata to async error handlers", async () => {
    const send = vi
      .fn<({ mediaUrl, caption }: { mediaUrl: string; caption?: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn(async () => undefined);

    await expect(
      sendMediaWithLeadingCaption({
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        caption: "hello",
        send,
        onError,
      }),
    ).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
        caption: "hello",
        index: 0,
        isFirst: true,
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, {
      mediaUrl: "https://example.com/b.png",
      caption: undefined,
    });
  });
});

describe("deliverFormattedTextWithAttachments", () => {
  it("combines attachment links and forwards replyToId", async () => {
    const send = vi.fn(async () => undefined);

    await expect(
      deliverFormattedTextWithAttachments({
        payload: {
          text: "hello",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          replyToId: "r1",
        },
        send,
      }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith({
      text: "hello\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
      replyToId: "r1",
    });
  });
});
