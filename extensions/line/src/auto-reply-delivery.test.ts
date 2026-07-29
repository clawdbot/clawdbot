// Line tests cover auto reply delivery plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createFlexMessage,
  createImageMessage,
  LINE_TEST_CFG,
  type LineAutoReplyDeps,
} from "./auto-reply-delivery.test-helpers.js";
import { buildLineMediaMessage } from "./outbound-media.js";

describe("deliverLineAutoReply", () => {
  it("sends text and rich messages on one reply token instead of pushing the rich bubble", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [{ type: "text", text: "hello" }, createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).not.toHaveBeenCalled();
    expect(result.visibleReplySent).toBe(true);
  });

  it("keeps an extracted markdown table on the reply token alongside text", async () => {
    // Tables are lifted out of the text into their own Flex bubble, which is the
    // shape that used to reach the quota-bound push path and vanish on a 429.
    const processLineMessage: LineAutoReplyDeps["processLineMessage"] = (text) => ({
      text,
      flexMessages: [{ type: "flex", altText: "Table", contents: { type: "bubble" } }],
    });
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({ processLineMessage });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "Here is the comparison" },
      lineData: {},
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [
        { type: "text", text: "Here is the comparison" },
        createFlexMessage("Table", { type: "bubble" }),
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("keeps media on the reply token alongside text", async () => {
    const { deps, replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "here you go", mediaUrls: ["https://example.com/chart.png"] },
      lineData: {},
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [{ type: "text", text: "here you go" }, createImageMessage("https://example.com/chart.png")],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("pushes only the messages that do not fit the reply token batch", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5"];
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      chunkMarkdownText: () => chunks,
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      chunks.map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("pushes the whole bundled batch when the reply token call fails", async () => {
    // A failed reply must not strand the text: both parts fall back to push
    // together so the turn stays a full delivery rather than a partial loss.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingReplyMessageLine = vi.fn(async () => {
      throw new Error("reply failed");
    });
    const { deps, pushMessagesLine } = createDeps({
      replyMessageLine: failingReplyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(result.visibleReplySent).toBe(true);
    expect(failingReplyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      [{ type: "text", text: "hello" }, createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("sanitizes internal traces on the inbound auto-reply path", async () => {
    const processLineMessage = vi.fn((text: string) => ({ text, flexMessages: [] }));
    const { deps, replyMessageLine } = createDeps({ processLineMessage });
    const text = [
      "Done.",
      '<tool_call>{"name":"read","arguments":{"path":"secret"}}</tool_call>',
      "⚠️ 🛠️ `search repos (agent)` failed",
    ].join("\n");

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text },
      lineData: {},
      deps,
    });

    expect(processLineMessage).toHaveBeenCalledWith("Done.");
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "Done." }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
    expect(result).toEqual({
      status: "delivered",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
  });

  it("suppresses an internal-only auto-reply without consuming the reply token", async () => {
    const processLineMessage = vi.fn((text: string) => ({ text, flexMessages: [] }));
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({ processLineMessage });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "⚠️ 🛠️ `search repos (agent)` failed" },
      lineData: {},
      deps,
    });

    expect(processLineMessage).not.toHaveBeenCalled();
    expect(replyMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "delivered",
      replyTokenUsed: false,
      visibleReplySent: false,
    });
  });

  it("preserves literal tool traces in fenced auto-reply text", async () => {
    const text = [
      "Example:",
      "```text",
      "⚠️ 🛠️ `search repos (agent)` failed",
      '<tool_call>{"name":"read"}</tool_call>',
      "```",
    ].join("\n");
    const { deps, replyMessageLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text },
      lineData: {},
      deps,
    });

    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
    expect(result.visibleReplySent).toBe(true);
  });

  it("adopts the reply token after a later batch fails without replaying delivered text", async () => {
    const pushError = new Error("later push failed");
    const pushMessagesLine = vi.fn(async () => {
      throw pushError;
    });
    const { deps, replyMessageLine } = createDeps({
      chunkMarkdownText: () => ["1", "2", "3", "4", "5", "6"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "six chunks" },
      lineData: {},
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      error: {
        message: "later push failed",
        sentBeforeError: true,
        visibleReplySent: true,
      },
    });
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith("line:user:1", [{ type: "text", text: "6" }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
  });

  it("truncates flex altText on a surrogate boundary", async () => {
    // The emoji's surrogate pair straddles LINE's 400-char altText cap; a raw
    // slice used to send a lone high surrogate to the LINE API.
    const lineData = {
      flexMessage: { altText: `${"a".repeat(399)}😀 overflow`, contents: { type: "bubble" } },
    };
    const createFlexMessageSpy = vi.fn(createFlexMessage);
    const { deps } = createDeps({
      createFlexMessage: createFlexMessageSpy as LineAutoReplyDeps["createFlexMessage"],
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    const sentAltText = createFlexMessageSpy.mock.calls[0]?.[0] ?? "";
    expect(sentAltText.length).toBeLessThanOrEqual(400);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sentAltText),
    ).toBe(false);
  });

  it("uses reply token for rich-only payloads", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        text: "⚠️ 🛠️ `search repos (agent)` failed",
        channelData: { line: lineData },
      },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [
        {
          ...createFlexMessage("Card", { type: "bubble" }),
          quickReply: { items: ["A"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).toHaveBeenCalledExactlyOnceWith(["A"]);
    expect(result.visibleReplySent).toBe(true);
  });

  it("keeps quick replies on the trailing bubble when the batch overflows the reply token", async () => {
    // LINE hides quick replies as soon as a newer message arrives, so pinning
    // them to the last reply-token slot loses the buttons behind the overflow
    // push that follows.
    const processLineMessage: LineAutoReplyDeps["processLineMessage"] = () => ({
      text: "",
      flexMessages: [1, 2, 3, 4, 5, 6].map((n) => ({
        type: "flex",
        altText: `B${n}`,
        contents: { type: "bubble" },
      })),
    });
    const lineData = { quickReplies: ["A"] };
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({ processLineMessage });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [1, 2, 3, 4, 5].map((n) => createFlexMessage(`B${n}`, { type: "bubble" })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      [{ ...createFlexMessage("B6", { type: "bubble" }), quickReply: { items: ["A"] } }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("uses fallback text for quick-reply-only payloads", async () => {
    const lineData = {
      quickReplies: ["A", "B"],
    };
    const { deps, replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "text",
          text: "Options:\n- A\n- B",
          quickReply: { items: ["A", "B"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(result.visibleReplySent).toBe(true);
  });

  it("sends rich messages before quick-reply text so quick replies remain visible", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, pushMessagesLine, replyMessageLine, createQuickReplyItems } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    // The bubbles still lead the text, now inside the single reply batch rather
    // than through a separate quota-bound push.
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [
        createFlexMessage("Card", { type: "bubble" }),
        { type: "text", text: "hello", quickReply: { items: ["A"] } },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).toHaveBeenCalledExactlyOnceWith(["A"]);
  });

  it("surfaces a visible partial delivery when an overflow bubble fails alongside quick-reply text", async () => {
    // Quick replies keep the bubbles ahead of the text, so only what overflows
    // the five reply slots still reaches push. If that push fails, the batch the
    // user already saw must stay, yet the loss must be reported instead of a
    // silent full success.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const failingPush = vi.fn(async () => {
      throw new Error("push failed");
    });
    const { deps, replyMessageLine } = createDeps({
      chunkMarkdownText: () => ["c1", "c2", "c3", "c4", "c5"],
      pushMessagesLine: failingPush as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    // The partial failure is returned (not thrown) so the caller can adopt the
    // consumed reply-token state before surfacing it. visibleReplySent is the
    // signal dispatch uses to keep the sent text yet still report the failure.
    expect(result).toMatchObject({
      status: "partial",
      visibleReplySent: true,
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    expect(result.replyTokenUsed).toBe(true);
    // Text still reached the user over the reply token despite the rich failure.
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(failingPush).toHaveBeenCalledTimes(1);
  });

  it("surfaces a visible partial delivery when an overflow bubble fails after text without quick replies", async () => {
    // Without quick replies the text and the rich bubble share the reply token,
    // so the bubble only reaches push once the text fills all five slots. A
    // failed push there must surface the same visible partial delivery so the
    // sibling path stays consistent with the quick-reply branch.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingPush = vi.fn(async () => {
      throw new Error("push failed");
    });
    const { deps, replyMessageLine } = createDeps({
      chunkMarkdownText: () => ["c1", "c2", "c3", "c4", "c5"],
      pushMessagesLine: failingPush as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(failingPush).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-extensible rich failure without losing visible-send evidence", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const frozenError = new Error("push failed");
    Object.freeze(frozenError);
    const { deps } = createDeps({
      chunkMarkdownText: () => ["c1", "c2", "c3", "c4", "c5"],
      pushMessagesLine: vi.fn(async () => {
        throw frozenError;
      }) as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true, cause: frozenError },
    });
  });

  it("falls back to push when reply token delivery fails", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingReplyMessageLine = vi.fn(async () => {
      throw new Error("reply failed");
    });
    const { deps, pushMessagesLine } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
      replyMessageLine: failingReplyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(failingReplyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("honors channelData.line.mediaKind on the reply-token path instead of forcing image", async () => {
    // The push path resolves mediaKind into a video/audio message; the reply path
    // used to hardcode createImageMessage, silently downgrading video to a broken
    // image. LINE-specific media must now resolve to the matching kind.
    const lineData = {
      mediaKind: "video" as const,
      previewImageUrl: "https://example.com/preview.jpg",
    };
    const { deps, replyMessageLine, buildMediaMessage } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        mediaUrls: ["https://example.com/clip.mp4"],
        channelData: { line: lineData },
      },
      lineData,
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(buildMediaMessage).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      expect.objectContaining(lineData),
      "line:user:1",
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "video",
          originalContentUrl: "https://example.com/clip.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("keeps the image route for generic media without LINE-specific options", async () => {
    // A bare media URL stays on the image route, but shares validation with
    // LINE-specific media. A .mp4 proves the explicit image fallback prevents
    // extension-based video inference.
    const { deps, replyMessageLine, buildMediaMessage } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        mediaUrls: ["https://example.com/clip.mp4"],
        channelData: { line: {} },
      },
      lineData: {},
      deps,
    });

    expect(result.status).toBe("delivered");
    expect(buildMediaMessage).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      {
        mediaKind: "image",
        previewImageUrl: undefined,
        durationMs: undefined,
        trackingId: undefined,
      },
      "line:user:1",
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [createImageMessage("https://example.com/clip.mp4")],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("surfaces a visible partial delivery when a media message cannot be built", async () => {
    // A video missing its preview image cannot be built. The text still reaches the
    // user, but the lost media bubble must surface as a partial delivery.
    const lineData = { mediaKind: "video" as const };
    const { deps, replyMessageLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        text: "here is your clip",
        mediaUrls: ["https://example.com/clip.mp4"],
        channelData: { line: lineData },
      },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    // Text still reached the user over the reply token despite the media failure.
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [{ type: "text", text: "here is your clip" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("rejects a media-only build failure instead of reporting an empty delivery", async () => {
    const lineData = { mediaKind: "video" as const };
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {
          mediaUrls: ["https://example.com/clip.mp4"],
          channelData: { line: lineData },
        },
        lineData,
        deps,
      }),
    ).rejects.toThrow(/require previewImageUrl/i);

    expect(replyMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("does not expose credentials from media-only validation failures", async () => {
    const lineData = {};
    const mediaUrl = new URL("http://example.com/image.jpg");
    mediaUrl.username = ["line", "user"].join("-");
    mediaUrl.password = ["line", "fixture"].join("-");
    mediaUrl.searchParams.set("auth", ["line", "query"].join("-"));
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
      buildMediaMessage: buildLineMediaMessage,
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {
          mediaUrls: [mediaUrl.href],
          channelData: { line: lineData },
        },
        lineData,
        deps,
      }),
    ).rejects.toThrow(new Error("LINE outbound media URL must use HTTPS"));

    expect(replyMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("wraps a non-Error media-only build failure", async () => {
    const lineData = { mediaKind: "video" as const };
    const failure = { code: "invalid_media" };
    const { deps } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
      buildMediaMessage: vi.fn(async () => {
        // oxlint-disable-next-line typescript/only-throw-error -- dependency callbacks may reject unknown values; this proves the delivery boundary normalizes them.
        throw failure;
      }) as LineAutoReplyDeps["buildMediaMessage"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {
          mediaUrls: ["https://example.com/clip.mp4"],
          channelData: { line: lineData },
        },
        lineData,
        deps,
      }),
    ).rejects.toMatchObject({
      message: "LINE message send failed",
      cause: failure,
    });
  });
});
