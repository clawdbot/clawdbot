// LINE auto-reply tests cover HTTP rejection recovery and replay safety.
import { HTTPFetchError, type messagingApi } from "@line/bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createFlexMessage,
  LINE_TEST_CFG,
  type LineAutoReplyDeps,
} from "./auto-reply-delivery.test-helpers.js";

describe("deliverLineAutoReply HTTP recovery", () => {
  it("retries push-only quick-reply text after a mixed batch is rejected", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.length > 1) {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "Choose one", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      visibleReplySent: true,
      error: { message: "400 - Bad Request" },
    });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [
        createFlexMessage("Card", { type: "bubble" }),
        { type: "text", text: "Choose one", quickReply: { items: ["A"] } },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "Choose one", quickReply: { items: ["A"] } }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("does not retry a mixed push after a quota failure", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const quotaError = new HTTPFetchError("429 - Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      body: "quota exceeded",
    });
    const pushMessagesLine = vi.fn(async () => {
      throw quotaError;
    });
    const { deps } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        replyToken: undefined,
        payload: { text: "Choose one", channelData: { line: lineData } },
        lineData,
        deps,
      }),
    ).rejects.toBe(quotaError);
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
  });

  it("recovers quick replies from a rejected rich-only push", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages[0]?.type === "flex") {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "Options:\n- A", quickReply: { items: ["A"] } }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("retries only text from the failed mixed overflow batch", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps } = createDeps({
      chunkMarkdownText: () => chunks,
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      chunks.slice(0, 5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "c6" }, createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      3,
      "line:user:1",
      [{ type: "text", text: "c6" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("retries text from a rejected reply-token overflow batch", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps, replyMessageLine } = createDeps({
      chunkMarkdownText: () => chunks,
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({ status: "partial", replyTokenUsed: true });
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [{ type: "text", text: "c6" }, createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "c6" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("does not recover text after an ambiguous reply failure", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const replyMessageLine = vi.fn(async () => {
      throw new Error("reply transport failed");
    });
    const pushError = new HTTPFetchError("400 - Bad Request", {
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      body: "invalid rich message",
    });
    const pushMessagesLine = vi.fn(async () => {
      throw pushError;
    });
    const { deps } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "hello", channelData: { line: lineData } },
        lineData,
        deps,
      }),
    ).rejects.toBe(pushError);
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
  });

  it("recovers text after definitive reply and push rejections", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const rejection = () =>
      new HTTPFetchError("400 - Bad Request", {
        status: 400,
        statusText: "Bad Request",
        headers: new Headers(),
        body: "invalid rich message",
      });
    const replyMessageLine = vi.fn(async () => {
      throw rejection();
    });
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw rejection();
      }
      return {};
    });
    const { deps } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "hello" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("recovers only unattempted overflow after an ambiguous reply failure", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const replyMessageLine = vi.fn(async () => {
      throw new Error("reply transport failed");
    });
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps } = createDeps({
      chunkMarkdownText: () => chunks,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [
        createFlexMessage("Card", { type: "bubble" }),
        ...chunks.slice(0, 4).map((text) => ({ type: "text", text })),
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [
        { type: "text", text: "c5" },
        { type: "text", text: "c6", quickReply: { items: ["A"] } },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("retries text and quick replies from the unattempted push tail", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw new HTTPFetchError("400 - Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: new Headers(),
          body: "invalid rich message",
        });
      }
      return {};
    });
    const { deps } = createDeps({
      chunkMarkdownText: () => chunks,
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [
        createFlexMessage("Card", { type: "bubble" }),
        ...chunks.slice(0, 4).map((text) => ({ type: "text", text })),
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      chunks.slice(0, 5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      3,
      "line:user:1",
      [{ type: "text", text: "c6", quickReply: { items: ["A"] } }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });
});
