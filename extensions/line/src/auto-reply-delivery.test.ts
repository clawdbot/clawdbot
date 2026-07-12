// Line tests cover auto reply delivery plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { LineAutoReplyDeps } from "./auto-reply-delivery.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import { createLineSendReceipt } from "./send-receipt.js";

const createFlexMessage = (altText: string, contents: unknown) => ({
  type: "flex" as const,
  altText,
  contents,
});

const createImageMessage = (url: string) => ({
  type: "image" as const,
  originalContentUrl: url,
  previewImageUrl: url,
});

const createLocationMessage = (location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}) => ({
  type: "location" as const,
  ...location,
});

describe("deliverLineAutoReply", () => {
  const LINE_TEST_CFG = { channels: { line: { accounts: { acc: {} } } } };
  const baseDeliveryParams = {
    cfg: LINE_TEST_CFG,
    to: "line:user:1",
    replyToken: "token",
    replyTokenUsed: false,
    accountId: "acc",
    textLimit: 5000,
  };

  function createDeps(overrides?: Partial<LineAutoReplyDeps>) {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string) => ({
      type: "text" as const,
      text,
    }));
    const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
    const pushMessagesLine = vi.fn(async () => ({
      messageId: "push",
      chatId: "u1",
      receipt: createLineSendReceipt({ messageId: "push", chatId: "u1", kind: "text" }),
    }));

    const deps: LineAutoReplyDeps = {
      buildTemplateMessageFromPayload: () => null,
      processLineMessage: (text) => ({ text, flexMessages: [] }),
      chunkMarkdownText: (text) => [text],
      sendLineReplyChunks,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
      createQuickReplyItems: createQuickReplyItems as LineAutoReplyDeps["createQuickReplyItems"],
      pushMessagesLine,
      createFlexMessage: createFlexMessage as LineAutoReplyDeps["createFlexMessage"],
      createImageMessage,
      createLocationMessage,
      ...overrides,
    };

    return {
      deps,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
      createQuickReplyItems,
      pushMessagesLine,
    };
  }

  it("uses reply token for text before sending rich messages", async () => {
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
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "hello" }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(createQuickReplyItems).not.toHaveBeenCalled();
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
      sendLineReplyChunks: vi.fn(async () => ({ replyTokenUsed: false })),
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
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
    expect(createQuickReplyItems).toHaveBeenCalledWith(["A"]);
  });

  it("uses fallback text for quick-reply-only payloads", async () => {
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: ["A", "B"] },
    }));
    const lineData = {
      quickReplies: ["A", "B"],
    };
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
    });

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
  });

  it("sends rich messages before quick-reply text so quick replies remain visible", async () => {
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: ["A"] },
    }));

    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, pushMessagesLine, replyMessageLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "text",
          text: "hello",
          quickReply: { items: ["A"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    const pushOrder = pushMessagesLine.mock.invocationCallOrder[0];
    const replyOrder = replyMessageLine.mock.invocationCallOrder[0];
    expect(expectDefined(pushOrder, "LINE push invocation")).toBeLessThan(
      expectDefined(replyOrder, "LINE reply invocation"),
    );
  });

  it("surfaces a visible partial delivery when a rich bubble fails alongside quick-reply text", async () => {
    // Quick replies attach to the trailing text bubble, so the flex/media send
    // (pushMessagesLine) runs first. If it fails, the text still reaches the
    // user, but the loss must be reported instead of a silent full success.
    const createTextMessageWithQuickReplies = vi.fn((text: string) => ({
      type: "text" as const,
      text,
      quickReply: { items: ["A"] },
    }));
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const failingPush = vi.fn(async () => {
      throw new Error("push failed");
    });
    const { deps, replyMessageLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
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
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    expect(result.replyTokenUsed).toBe(true);
    // Text still reached the user over the reply token despite the rich failure.
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(failingPush).toHaveBeenCalledTimes(1);
  });

  it("surfaces a visible partial delivery when a rich bubble fails after text without quick replies", async () => {
    // Without quick replies the text goes first and the rich bubble follows; a
    // failed rich push must surface the same visible partial delivery so the
    // sibling path stays consistent with the quick-reply branch.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingPush = vi.fn(async () => {
      throw new Error("push failed");
    });
    const { deps, replyMessageLine } = createDeps({
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
});
