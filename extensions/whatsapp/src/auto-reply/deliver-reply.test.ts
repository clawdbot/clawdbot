import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
// Whatsapp tests cover deliver reply plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "../inbound/send-api.js";
import { normalizeWhatsAppSendResult } from "../inbound/send-result.js";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { withWhatsAppSocketOperationTimeout } from "../socket-timing.js";

const hoisted = vi.hoisted(() => ({
  recordChannelActivity: vi.fn(),
  transcodeAudioBufferToOpus: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => hoisted.recordChannelActivity(...args),
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    shouldLogVerbose: vi.fn(() => true),
    logVerbose: vi.fn(),
  };
});

vi.mock("../media.js", () => ({ loadWebMedia: vi.fn() }));

let deliverWebReply: typeof import("./deliver-reply.js").deliverWebReply;
let createWhatsAppReplyTransportContext: typeof import("./deliver-reply.js").createWhatsAppReplyTransportContext;

type DeliveryParams = Parameters<typeof deliverWebReply>[0];
type DeliveryOverrides = Partial<Omit<DeliveryParams, "replyResult" | "transport">>;
type LoadedWebMedia = Awaited<ReturnType<typeof loadWebMedia>>;
type LoadedMediaKind = LoadedWebMedia["kind"] | "file";
type MockWithCalls = { mock: { calls: unknown[][] } };

function makeMsg(): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    payload: { body: "latest batch body" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "+20000000000",
      senderJid: "222@s.whatsapp.net",
      reply: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-sent-1")),
      sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-sent-1")),
    },
    admission: {
      accountId: "work",
      conversation: {
        kind: "group",
        id: "+10000000000",
      },
      sender: {
        id: "222@s.whatsapp.net",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
  });
}

function mockLoadedMedia(
  bytes: string,
  contentType: string | undefined,
  kind: LoadedMediaKind,
  fileName?: string,
) {
  vi.mocked(loadWebMedia).mockResolvedValueOnce({
    buffer: Buffer.from(bytes),
    contentType,
    kind,
    ...(fileName ? { fileName } : {}),
  } as LoadedWebMedia);
}

function expectFirstSendMediaPayload(msg: AdmittedWebInboundMessage) {
  return requireRecord(mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"), "sendMedia payload");
}

const requireRecord = createRequireRecord("record", "expected-label");

function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const call = (mock as MockWithCalls).mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function replyText(msg: AdmittedWebInboundMessage, callIndex = 0): string {
  return String(mockCallArg(msg.platform.reply, callIndex, 0, "reply"));
}

function findLoggerContext(mock: unknown, message: string, label: string) {
  const call = (mock as MockWithCalls).mock.calls.find((entry) => entry[1] === message);
  if (!call) {
    throw new Error(`expected ${label} message ${message}`);
  }
  return requireRecord(call[0], `${label} context`);
}

function expectBuffer(value: unknown, label: string) {
  expect(Buffer.isBuffer(value), label).toBe(true);
}

function expectQuotedOptions(
  options: unknown,
  expected: { id: string; fromMe: boolean; participant: string; body: string },
) {
  const quoted = requireRecord(requireRecord(options, "reply options").quoted, "quoted message");
  const key = requireRecord(quoted.key, "quoted key");
  expect(key.id).toBe(expected.id);
  expect(key.fromMe).toBe(expected.fromMe);
  expect(key.participant).toBe(expected.participant);
  expect(quoted.message).toEqual({ conversation: expected.body });
}

async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = run();
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

async function createSocketOperationTimeoutError(): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const failurePromise = withWhatsAppSocketOperationTimeout(
      "sendMessage",
      new Promise<never>(() => {}),
      1_000,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    return await failurePromise;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function createDelivery(
  replyResult: DeliveryParams["replyResult"],
  overrides: DeliveryOverrides = {},
): { msg: AdmittedWebInboundMessage; params: DeliveryParams } {
  const msg = makeMsg();
  return {
    msg,
    params: {
      replyResult,
      transport: createWhatsAppReplyTransportContext(msg),
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
      ...overrides,
    },
  };
}

function createImageDelivery(text: string, overrides: DeliveryOverrides = {}, replyToId?: string) {
  const delivery = createDelivery(
    { text, mediaUrl: "http://example.com/img.jpg", ...(replyToId ? { replyToId } : {}) },
    overrides,
  );
  mockLoadedMedia("img", "image/jpeg", "image");
  return delivery;
}

async function expectReplySuppressed(replyResult: { text: string; isReasoning?: boolean }) {
  const { msg, params } = createDelivery(replyResult);
  await deliverWebReply(params);
  expect(msg.platform.reply).not.toHaveBeenCalled();
  expect(msg.platform.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  beforeAll(async () => {
    ({ createWhatsAppReplyTransportContext, deliverWebReply } = await import("./deliver-reply.js"));
  });

  it("does not resend an accepted reply when its transport reports a disconnect afterward", async () => {
    const { msg, params } = createDelivery({ text: "already delivered" });
    const disconnect = new Error("connection closed");
    const acceptedFailure = createChannelPartialDeliveryError(disconnect, {
      messageIds: ["reply-already-accepted"],
      visibleReplySent: true,
    });
    vi.mocked(msg.platform.reply).mockRejectedValue(acceptedFailure);

    const failure = await runWithFakeTimers(() =>
      deliverWebReply(params).catch((caught: unknown) => caught),
    );

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted reply was not promoted to a receipt-backed partial delivery");
    }
    expect(failure).not.toBe(acceptedFailure);
    expect(failure.deliveryResult.messageIds).toEqual(["reply-already-accepted"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["reply-already-accepted"]);
    expect(failure).toHaveProperty("cause", disconnect);
    expect(failure).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
    expect(msg.platform.reply).toHaveBeenCalledOnce();
  });

  it("suppresses payloads flagged as reasoning", async () => {
    await expectReplySuppressed({ text: "hidden", isReasoning: true });
  });

  it("suppresses payloads that start with reasoning prefix text", async () => {
    await expectReplySuppressed({ text: "   \n Reasoning:\n_hidden_" });
  });

  it("suppresses payloads that start with a quoted reasoning prefix", async () => {
    await expectReplySuppressed({ text: " > Reasoning:\n> _hidden_" });
  });

  it("does not suppress messages that mention Reasoning: mid-text", async () => {
    const { msg, params } = createDelivery({
      text: "Intro line\nReasoning: appears in content but is not a prefix",
    });

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalledWith(
      "Intro line\nReasoning: appears in content but is not a prefix",
      undefined,
    );
  });

  it("sends chunked text replies and logs a summary", async () => {
    hoisted.recordChannelActivity.mockClear();
    const { msg, params } = createDelivery({ text: "aaaaaa" }, { textLimit: 3 });

    const delivery = await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    expect(msg.platform.reply).toHaveBeenNthCalledWith(1, "aaa", undefined);
    expect(msg.platform.reply).toHaveBeenNthCalledWith(2, "aaa", undefined);
    expect(typeof mockCallArg(replyLogger.info, 0, 0, "replyLogger.info")).toBe("object");
    expect(mockCallArg(replyLogger.info, 0, 1, "replyLogger.info")).toBe("auto-reply sent (text)");
    expect(delivery.providerAccepted).toBe(true);
    expect(listMessageReceiptPlatformIds(delivery.receipt)).toEqual(["reply-sent-1"]);
    expect(delivery.receipt.primaryPlatformMessageId).toBe("reply-sent-1");
    expect(delivery.receipt.platformMessageIds).toEqual(["reply-sent-1"]);
    expect(delivery.receipt.parts[0]?.platformMessageId).toBe("reply-sent-1");
    expect(delivery.receipt.parts[0]?.kind).toBe("text");
    expect(hoisted.recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "work",
      direction: "outbound",
    });
  });

  it.each([
    {
      name: "an image without alt text",
      text: "![](https://example.com/diagram.png)",
      expected: "![](https://example.com/diagram.png)",
    },
    {
      name: "an image with visible alt text",
      text: "![Diagram](https://example.com/diagram.png)",
      expected: "Diagram",
    },
  ])("delivers $name instead of silently dropping the auto-reply", async ({ text, expected }) => {
    const { msg, params } = createDelivery({ text });

    const delivery = await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(delivery).toMatchObject({
      providerAccepted: true,
      results: [{ messageId: "reply-sent-1" }],
    });
  });

  it("retains an accepted auto-reply receipt when outbound activity bookkeeping fails", async () => {
    hoisted.recordChannelActivity.mockClear();
    const activityError = new Error("auto-reply activity bookkeeping disconnected");
    hoisted.recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });
    const { msg, params } = createDelivery({ text: "already accepted" });

    const failure = await deliverWebReply(params).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted auto-reply receipt was discarded during activity bookkeeping");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["reply-sent-1"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["reply-sent-1"]);
    expect(failure).toHaveProperty("cause", activityError);
    expect(msg.platform.reply).toHaveBeenCalledOnce();
    expect(hoisted.recordChannelActivity).toHaveBeenCalledOnce();
  });

  it("merges earlier accepted chunks with a nested accepted-chunk bookkeeping failure", async () => {
    hoisted.recordChannelActivity.mockClear();
    const bookkeepingError = new Error("second accepted chunk bookkeeping failed");
    const firstChunk = normalizeWhatsAppSendResult(
      { key: { id: "auto-reply-first-chunk" } } as WAMessage,
      "text",
    );
    const secondChunk = normalizeWhatsAppSendResult(
      { key: { id: "auto-reply-second-chunk" } } as WAMessage,
      "text",
    );
    const { msg, params } = createDelivery({ text: "aaaaaa" }, { textLimit: 3 });
    vi.mocked(msg.platform.reply)
      .mockResolvedValueOnce(firstChunk)
      .mockRejectedValueOnce(
        createChannelPartialDeliveryError(bookkeepingError, {
          messageIds: [secondChunk.messageId],
          receipt: secondChunk.receipt,
          visibleReplySent: true,
        }),
      );

    const failure = await deliverWebReply(params).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error(
        "accepted auto-reply chunks were not composed after nested bookkeeping failed",
      );
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "auto-reply-first-chunk",
      "auto-reply-second-chunk",
    ]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "auto-reply-first-chunk",
      "auto-reply-second-chunk",
    ]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    expect(hoisted.recordChannelActivity).toHaveBeenCalledOnce();
  });

  it("rejects text replies that Baileys did not accept without recording outbound activity", async () => {
    hoisted.recordChannelActivity.mockClear();
    const { msg, params } = createDelivery({ text: "hello" });
    vi.mocked(msg.platform.reply).mockResolvedValueOnce({
      ...createAcceptedWhatsAppSendResult("text", "unknown"),
      receipt: undefined,
      keys: [],
      providerAccepted: false,
    });

    await expect(deliverWebReply(params)).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(msg.platform.reply).toHaveBeenCalledOnce();
    expect(hoisted.recordChannelActivity).not.toHaveBeenCalled();
  });

  it("strips raw XML tool-call blocks before WhatsApp text delivery", async () => {
    const { msg, params } = createDelivery(
      {
        text: 'Before\n<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>\nAfter',
      },
      { textLimit: 4000 },
    );

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    const sentText = replyText(msg);
    expect(sentText).not.toContain("function_calls");
    expect(sentText).not.toContain("invoke");
    expect(sentText).toContain("Before");
    expect(sentText).toContain("After");
  });

  it("uses the same final sanitizer stack for auto-reply text delivery", async () => {
    const { msg, params } = createDelivery(
      {
        text: [
          "Before",
          "<function_calls>",
          '  <invoke name="send_message">',
          '    <parameter name="text"><b>hidden</b></parameter>',
          "  </invoke>",
          "</function_calls>",
          "<div>After</div>",
        ].join("\n"),
      },
      { textLimit: 4000 },
    );

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toBe("Before\n\nAfter\n");
  });

  it("strips legacy uppercase TOOL_CALL text before WhatsApp text delivery", async () => {
    const { msg, params } = createDelivery(
      {
        text: [
          "Before",
          '[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}}[/TOOL_CALL]',
          "After",
        ].join("\n"),
      },
      { textLimit: 4000 },
    );

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toBe("Before\n\nAfter");
  });

  it("keeps quote threading on every text chunk for a threaded reply", async () => {
    const { msg, params } = createDelivery(
      { text: "aaaaaa", replyToId: "reply-1" },
      { textLimit: 3 },
    );
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-1", {
      participant: "111@s.whatsapp.net",
      body: "quoted body",
      fromMe: true,
    });

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    expect(mockCallArg(msg.platform.reply, 0, 0, "reply")).toBe("aaa");
    expectQuotedOptions(mockCallArg(msg.platform.reply, 0, 1, "reply"), {
      id: "reply-1",
      fromMe: true,
      participant: "111@s.whatsapp.net",
      body: "quoted body",
    });
    expect(mockCallArg(msg.platform.reply, 1, 0, "reply")).toBe("aaa");
    expectQuotedOptions(mockCallArg(msg.platform.reply, 1, 1, "reply"), {
      id: "reply-1",
      fromMe: true,
      participant: "111@s.whatsapp.net",
      body: "quoted body",
    });
  });

  it.each(["connection closed", "operation timed out"])(
    "retries text send on transient failure: %s",
    async (errorMessage) => {
      const { msg, params } = createDelivery({ text: "hi" });
      vi.mocked(msg.platform.reply)
        .mockRejectedValueOnce(new Error(errorMessage))
        .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("text", "reply-retry-2"));

      await runWithFakeTimers(() => deliverWebReply(params));

      expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    },
  );

  it("retries text send on wrapped transient failure", async () => {
    const { msg, params } = createDelivery({ text: "hi" });
    vi.mocked(msg.platform.reply)
      .mockRejectedValueOnce({ error: { message: "connection closed" } })
      .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("text", "reply-retry-2"));

    await runWithFakeTimers(() => deliverWebReply(params));

    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
  });

  it("does not retry terminal socket operation timeouts", async () => {
    const msg = makeMsg();
    const timeout = await createSocketOperationTimeoutError();
    vi.mocked(msg.platform.reply).mockRejectedValueOnce(timeout);

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        transport: createWhatsAppReplyTransportContext(msg),
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toBe(timeout);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
  });

  it("sends image media with caption and then remaining text", async () => {
    const mediaLocalRoots = ["/tmp/workspace-work"];
    const { msg, params } = createImageDelivery("aaaaaa", { mediaLocalRoots, textLimit: 3 });

    await deliverWebReply(params);

    expect(loadWebMedia).toHaveBeenCalledWith("http://example.com/img.jpg", {
      maxBytes: 1024 * 1024,
      localRoots: mediaLocalRoots,
    });

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.image, "sendMedia image");
    expect(mediaPayload.caption).toBe("aaa");
    expect(mediaPayload.mimetype).toBe("image/jpeg");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(msg.platform.reply).toHaveBeenCalledWith("aaa", undefined);
    findLoggerContext(replyLogger.info, "auto-reply sent (media)", "replyLogger.info");
    expect(logVerbose).toHaveBeenCalled();
  });

  it("marks errors visible after accepted media delivery", async () => {
    const { msg } = createImageDelivery("captiontail", { textLimit: 7 });
    const error = new Error("tail send failed");
    vi.mocked(msg.platform.reply).mockRejectedValue(error);

    await expect(
      deliverWebReply({
        replyResult: { text: "captiontail", mediaUrl: "http://example.com/img.jpg" },
        transport: createWhatsAppReplyTransportContext(msg),
        maxMediaBytes: 1024 * 1024,
        textLimit: 7,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });

    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalled();
  });

  it("preserves leading indentation after trimming only leading blank lines", async () => {
    const { msg, params } = createDelivery({ text: "\n \n    indented block" });

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalledWith("    indented block", undefined);
  });

  it("keeps quote threading on media and trailing text chunks for a threaded reply", async () => {
    const { msg, params } = createImageDelivery("captiontrail", { textLimit: 7 }, "reply-2");
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-2", {
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
      fromMe: true,
    });

    await deliverWebReply(params);

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.image, "sendMedia image");
    expect(mediaPayload.caption).toBe("caption");
    expect(mediaPayload.mimetype).toBe("image/jpeg");
    expectQuotedOptions(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia"), {
      id: "reply-2",
      fromMe: true,
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
    });
    expect(mockCallArg(msg.platform.reply, 0, 0, "reply")).toBe("trail");
    expectQuotedOptions(mockCallArg(msg.platform.reply, 0, 1, "reply"), {
      id: "reply-2",
      fromMe: true,
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
    });
  });

  it("retries media send on transient failure", async () => {
    const { msg, params } = createImageDelivery("caption");
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error("socket reset"));
    vi.mocked(msg.platform.sendMedia).mockResolvedValueOnce(
      createAcceptedWhatsAppSendResult("media", "media-retry-2"),
    );

    await runWithFakeTimers(() => deliverWebReply(params));

    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(2);
  });

  it("falls back to text-only when the first media send fails", async () => {
    const { msg, params } = createImageDelivery("caption", { textLimit: 20 });
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error("boom"));

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toContain("⚠️ Media failed");
    expect(replyText(msg)).not.toContain("boom");
    const warnContext = findLoggerContext(
      replyLogger.warn,
      "failed to send web media reply",
      "replyLogger.warn",
    );
    expect(warnContext.mediaUrl).toBe("http://example.com/img.jpg");
  });

  it("delivers the opening text chunk when the first media fails on a multi-chunk reply", async () => {
    const { msg, params } = createImageDelivery("ALPHALINEBRAVOLINE", { textLimit: 9 });
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error("boom"));

    await deliverWebReply(params);

    expect(replyText(msg, 0)).toContain("ALPHALINE");
    expect(replyText(msg, 0)).toContain("⚠️ Media failed");
    const replies = vi.mocked(msg.platform.reply).mock.calls;
    const allReplies = replies.map(([text]) => text).join("\n");
    expect(allReplies).toContain("ALPHALINE");
    expect(allReplies).toContain("BRAVOLINE");
    expect(allReplies).not.toContain("boom");
  });

  it("still attempts later media after the first media fails", async () => {
    vi.clearAllMocks();
    const { msg, params } = createDelivery({
      text: "caption",
      mediaUrls: ["http://example.com/bad.jpg", "http://example.com/good.pdf"],
    });
    mockLoadedMedia("bad", "image/jpeg", "image");
    mockLoadedMedia("good", "application/pdf", "file", "good.pdf");
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(msg.platform.sendMedia).mockResolvedValueOnce(
      createAcceptedWhatsAppSendResult("media", "media-second-1"),
    );

    await deliverWebReply(params);

    expect(loadWebMedia).toHaveBeenNthCalledWith(1, "http://example.com/bad.jpg", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(loadWebMedia).toHaveBeenNthCalledWith(2, "http://example.com/good.pdf", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(2);
    const secondPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 1, 0, "sendMedia"),
      "second sendMedia payload",
    );
    expectBuffer(secondPayload.document, "second sendMedia document");
    expect(secondPayload.fileName).toBe("good.pdf");
    expect(secondPayload.caption).toBeUndefined();
    expect(secondPayload.mimetype).toBe("application/pdf");
    expect(mockCallArg(msg.platform.sendMedia, 1, 1, "sendMedia")).toBeUndefined();
    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toContain("⚠️ Media failed");
    expect(replyText(msg)).not.toContain("boom");
  });

  it.each([
    {
      name: "prefers trimmed, deduplicated mediaUrls over legacy mediaUrl",
      mediaUrl: " http://example.com/legacy.jpg ",
      mediaUrls: [" http://example.com/preferred.jpg ", "http://example.com/preferred.jpg", "   "],
      expectedMediaUrl: "http://example.com/preferred.jpg",
    },
    {
      name: "falls back to trimmed legacy mediaUrl when mediaUrls are whitespace-only",
      mediaUrl: " http://example.com/legacy.jpg ",
      mediaUrls: ["   ", "\t"],
      expectedMediaUrl: "http://example.com/legacy.jpg",
    },
  ])("$name during auto-reply delivery", async ({ mediaUrl, mediaUrls, expectedMediaUrl }) => {
    vi.clearAllMocks();
    const { msg, params } = createDelivery({ text: "caption", mediaUrl, mediaUrls });
    mockLoadedMedia("img", "image/jpeg", "image");

    await deliverWebReply(params);

    expect(loadWebMedia).toHaveBeenCalledTimes(1);
    expect(loadWebMedia).toHaveBeenCalledWith(expectedMediaUrl, {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(1);
  });

  it("notifies user when a non-first media send fails instead of dropping silently", async () => {
    vi.clearAllMocks();
    const { msg, params } = createDelivery({
      text: "caption",
      mediaUrls: ["http://example.com/img1.jpg", "http://example.com/img2.jpg"],
    });
    // Two media items: first load succeeds and sends, second load succeeds but send fails.
    mockLoadedMedia("img1", "image/jpeg", "image");
    mockLoadedMedia("img2", "image/jpeg", "image");
    // First sendMedia resolves; second sendMedia rejects.
    vi.mocked(msg.platform.sendMedia).mockResolvedValueOnce(
      createAcceptedWhatsAppSendResult("media", "media-first-ok"),
    );
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error("upload failed"));

    const delivery = await deliverWebReply(params);

    // First media succeeded — no text reply for it.
    // Second media failed — user must be notified, not silently dropped.
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(2);
    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toContain("⚠️ Media unavailable");
    expect(replyText(msg)).not.toContain("upload failed");
    expect(delivery.receipt.platformMessageIds).toEqual(["media-first-ok", "reply-sent-1"]);
    expect(hoisted.recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "work",
      direction: "outbound",
    });
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "http://example.com/img2.jpg" }),
      "failed to send web media reply",
    );
  });

  it("sends audio media as ptt voice note with visible text separately", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/a.ogg",
    });
    mockLoadedMedia("aud", "audio/ogg", "audio");

    await deliverWebReply(params);

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.audio, "sendMedia audio");
    expect(mediaPayload.ptt).toBe(true);
    expect(mediaPayload.mimetype).toBe("audio/ogg; codecs=opus");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.platform.reply).toHaveBeenCalledWith("cap", undefined);
  });

  it("preserves accepted voice receipts without false media fallback after caption rejection", async () => {
    hoisted.recordChannelActivity.mockClear();
    const { msg, params } = createDelivery({
      text: "caption",
      mediaUrl: "http://example.com/accepted-voice.ogg",
    });
    mockLoadedMedia("aud", "audio/ogg", "audio");
    vi.mocked(msg.platform.sendMedia).mockImplementationOnce(async () =>
      normalizeWhatsAppSendResult(
        { key: { id: "auto-reply-voice-accepted" } } as WAMessage,
        "media",
      ),
    );
    vi.mocked(msg.platform.reply).mockImplementationOnce(async () =>
      normalizeWhatsAppSendResult(undefined, "text"),
    );

    const failure = await deliverWebReply(params).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted auto-reply voice receipt was discarded after caption rejection");
    }
    expect(failure.deliveryResult.visibleReplySent).toBe(true);
    expect(failure.deliveryResult.messageIds).toEqual(["auto-reply-voice-accepted"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "auto-reply-voice-accepted",
    ]);
    expect(failure).toHaveProperty("cause", expect.any(PlatformMessageNotDispatchedError));
    expect(msg.platform.sendMedia).toHaveBeenCalledOnce();
    expect(msg.platform.reply).toHaveBeenCalledOnce();
    expect(msg.platform.reply).toHaveBeenCalledWith("caption", undefined);
    expect(hoisted.recordChannelActivity).toHaveBeenCalledOnce();
    expect(hoisted.recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "work",
      direction: "outbound",
    });
  });

  it("keeps accepted media receipts when the inner sender throws during activity bookkeeping", async () => {
    hoisted.recordChannelActivity.mockClear();
    replyLogger.warn.mockClear();
    const bookkeepingError = new Error("accepted media bookkeeping failed");
    hoisted.recordChannelActivity.mockImplementationOnce(() => {
      throw bookkeepingError;
    });
    const sendMessage = vi.fn(
      async () => ({ key: { id: "auto-reply-nested-media" } }) as WAMessage,
    );
    const sendApi = createWebSendApi({
      sock: {
        sendMessage,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: "work",
    });
    const { msg, params } = createDelivery({
      text: "caption",
      mediaUrl: "http://example.com/nested-voice.ogg",
    });
    mockLoadedMedia("aud", "audio/ogg", "audio");
    vi.mocked(msg.platform.sendMedia).mockImplementationOnce(async () =>
      sendApi.sendMessage("+1555", "", Buffer.from("aud"), "audio/ogg"),
    );

    const failure = await deliverWebReply(params).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("nested accepted media delivery was treated as a failed upload");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["auto-reply-nested-media"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["auto-reply-nested-media"]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    expect(msg.platform.sendMedia).toHaveBeenCalledOnce();
    expect(msg.platform.reply).not.toHaveBeenCalled();
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expect(hoisted.recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "work",
      direction: "outbound",
    });
  });

  it("transcodes mp3 audio media before sending a ptt voice note", async () => {
    vi.clearAllMocks();
    hoisted.transcodeAudioBufferToOpus.mockResolvedValue(Buffer.from("opus-output"));
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/a.mp3",
    });
    mockLoadedMedia("mp3", "audio/mpeg", "audio", "voice.mp3");

    await deliverWebReply(params);

    expect(hoisted.transcodeAudioBufferToOpus).toHaveBeenCalledWith({
      audioBuffer: Buffer.from("mp3"),
      inputFileName: "voice.mp3",
      tempPrefix: "whatsapp-voice-",
      outputFileName: "voice.ogg",
      maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
      sampleRateHz: 48000,
      channels: 1,
      bitrate: "64k",
    });
    const mediaPayload = expectFirstSendMediaPayload(msg);
    expect(mediaPayload.audio).toEqual(Buffer.from("opus-output"));
    expect(mediaPayload.ptt).toBe(true);
    expect(mediaPayload.mimetype).toBe("audio/ogg; codecs=opus");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.platform.reply).toHaveBeenCalledWith("cap", undefined);
  });

  it("sends video media", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/v.mp4",
    });
    mockLoadedMedia("vid", "video/mp4", "video");

    await deliverWebReply(params);

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.video, "sendMedia video");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("video/mp4");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });

  it("sends non-audio/image/video media as document", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/x.bin",
    });
    mockLoadedMedia("bin", undefined, "file", "x.bin");

    await deliverWebReply(params);

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.document, "sendMedia document");
    expect(mediaPayload.fileName).toBe("x.bin");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("application/octet-stream");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });

  it("strips URL query and fragment data from derived document file names", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "https://example.com/report.pdf?X-Amz-Signature=secret#frag",
    });
    mockLoadedMedia("pdf", "application/pdf", "file");

    await deliverWebReply(params);

    const mediaPayload = expectFirstSendMediaPayload(msg);
    expectBuffer(mediaPayload.document, "sendMedia document");
    expect(mediaPayload.fileName).toBe("report.pdf");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("application/pdf");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });
});
