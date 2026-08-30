// LINE auto-reply tests cover HTTP rejection recovery and replay safety.
import { HTTPFetchError, type messagingApi } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createFlexMessage,
  createQuickReply,
  LINE_TEST_CFG,
  type LineAutoReplyDeps,
} from "./auto-reply-delivery.test-helpers.js";
import { runLinePushWithRetries } from "./send-retry.js";

describe("deliverLineAutoReply HTTP recovery", () => {
  const createHttpError = (status: number) =>
    new HTTPFetchError(`${status} - provider rejected the request`, {
      status,
      statusText: "provider rejected the request",
      headers: new Headers(),
      body: "provider error",
    });

  it.each([
    { label: "an actual LINE HTTP timeout", error: createHttpError(408) },
    { label: "an actual LINE upstream failure", error: createHttpError(503) },
    {
      label: "a wrapped actual LINE upstream failure",
      error: new Error("reply failed", { cause: createHttpError(502) }),
    },
    {
      label: "an actual LINE upstream failure behind two SDK wrappers",
      error: new Error("reply failed", {
        cause: new Error("provider request failed", { cause: createHttpError(503) }),
      }),
    },
    {
      label: "an actual LINE upstream failure behind an SDK error property",
      error: Object.assign(new Error("reply failed"), { error: createHttpError(503) }),
    },
    {
      label: "an authoritative LINE upstream failure wrapping a pre-connect error",
      error: Object.assign(createHttpError(503), {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      }),
    },
    {
      label: "a connection reset after dispatch",
      error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    },
    {
      label: "a request timeout after dispatch",
      error: Object.assign(new Error("reply request timed out"), { code: "ETIMEDOUT" }),
    },
    {
      label: "an undici response-body timeout",
      error: Object.assign(new Error("response body timed out"), {
        code: "UND_ERR_BODY_TIMEOUT",
      }),
    },
    {
      label: "an aborted request",
      error: Object.assign(new Error("reply was aborted"), { name: "AbortError" }),
    },
    { label: "the actual undici fetch error", error: new TypeError("fetch failed") },
    {
      label: "a wrapped undici fetch error",
      error: new Error("reply failed", { cause: new TypeError("fetch failed") }),
    },
  ])("does not replay a possibly accepted reply after $label", async ({ error }) => {
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw error;
    });
    const { deps, pushMessagesLine } = createDeps({
      onReplyError,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "do not duplicate this reply" },
        lineData: {},
        deps,
      }),
    ).rejects.toBe(error);
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an actual rejected LINE reply", error: createHttpError(400) },
    {
      label: "an actual rejected LINE reply behind two SDK wrappers",
      error: new Error("reply failed", {
        cause: new Error("provider request failed", { cause: createHttpError(400) }),
      }),
    },
    { label: "an actual LINE reply rate-limit rejection", error: createHttpError(429) },
    {
      label: "a refused connection before request dispatch",
      error: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
    },
    {
      label: "a wrapped DNS failure before request dispatch",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
      }),
    },
    { label: "a known local pre-dispatch failure", error: new Error("reply failed") },
    { label: "a raw pre-dispatch parsing failure", error: new SyntaxError("invalid request") },
  ])("keeps the push fallback after $label", async ({ error }) => {
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw error;
    });
    const { deps, pushMessagesLine } = createDeps({
      onReplyError,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "preserve the reply" },
        lineData: {},
        deps,
      }),
    ).resolves.toMatchObject({
      status: "delivered",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      [{ type: "text", text: "preserve the reply" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("does not replay an accepted reply after local bookkeeping fails", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new Error("activity store unavailable"),
      { messageIds: ["line-reply-final"], visibleReplySent: true },
    );
    const replyMessageLine = vi.fn(async () => {
      throw acceptedError;
    });
    const onReplyError = vi.fn();
    const { deps, pushMessagesLine } = createDeps({
      onReplyError,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "already delivered" },
      lineData: {},
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("does not replay a successful reply when its provider response cannot be parsed", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new SyntaxError("Unexpected end of JSON input"),
      { messageIds: [], visibleReplySent: true },
    );
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw acceptedError;
    });
    const { deps, pushMessagesLine } = createDeps({
      onReplyError,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "accepted despite its malformed receipt" },
        lineData: {},
        deps,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("preserves a provider-accepted push when local bookkeeping fails", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new Error("activity store unavailable"),
      { messageIds: ["line-push-final"], visibleReplySent: true },
    );
    const pushMessagesLine = vi.fn(async () => {
      throw acceptedError;
    });
    const { deps, replyMessageLine } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "already delivered" },
      lineData: {},
      deps,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: false,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(pushMessagesLine).toHaveBeenCalledOnce();
    expect(replyMessageLine).not.toHaveBeenCalled();
  });

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
        { type: "text", text: "Choose one", quickReply: createQuickReply("A") },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "Choose one", quickReply: createQuickReply("A") }],
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

  it("does not recover text after an ambiguous push ends in a rejection", async () => {
    vi.useFakeTimers();
    let ambiguousFailure: unknown;
    try {
      let attempt = 0;
      const failurePromise = runLinePushWithRetries(async () => {
        attempt += 1;
        throw attempt === 1
          ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
          : createHttpError(400);
      }, "line:push").catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      ambiguousFailure = await failurePromise;
    } finally {
      vi.useRealTimers();
    }

    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const pushMessagesLine = vi.fn(async () => {
      throw ambiguousFailure;
    });
    const { deps } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        replyToken: undefined,
        payload: { text: "do not duplicate", channelData: { line: lineData } },
        lineData,
        deps,
      }),
    ).rejects.toBe(ambiguousFailure);
    expect(pushMessagesLine).toHaveBeenCalledOnce();
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
      [{ type: "text", text: "Options:\n- A", quickReply: createQuickReply("A") }],
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
        { type: "text", text: "c6", quickReply: createQuickReply("A") },
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
      [{ type: "text", text: "c6", quickReply: createQuickReply("A") }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });
});
