// Whatsapp tests cover deliver reply plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { withWhatsAppSocketOperationTimeout } from "../socket-timing.js";

const hoisted = vi.hoisted(() => ({
  transcodeAudioBufferToOpus: vi.fn(),
}));

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

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

let deliverWebReply: typeof import("./deliver-reply.js").deliverWebReply;
let whatsappOutbound: typeof import("../outbound-adapter.js").whatsappOutbound;

function unacceptedSendResult(kind: "media" | "text") {
  return {
    kind,
    messageId: "unknown",
    receipt: createMessageReceiptFromOutboundResults({
      kind,
      results: [],
    }),
    keys: [],
    providerAccepted: false,
  };
}

function makeMsg(): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
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

function mockLoadedImageMedia() {
  (
    loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
  ).mockResolvedValueOnce({
    buffer: Buffer.from("img"),
    contentType: "image/jpeg",
    kind: "image",
  });
}

function mockFirstSendMediaFailure(msg: AdmittedWebInboundMessage, message: string) {
  (
    msg.platform.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce(new Error(message));
}

function mockFirstReplyFailure(msg: AdmittedWebInboundMessage, message: string) {
  (
    msg.platform.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce(new Error(message));
}

function mockFirstReplyFailureWithWrappedError(msg: AdmittedWebInboundMessage, message: string) {
  (
    msg.platform.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce({
    error: { message },
  });
}

function expectFirstSendMediaPayload(msg: AdmittedWebInboundMessage) {
  const payload = mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia");
  if (!payload) {
    throw new Error("expected first WhatsApp sendMedia payload");
  }
  return payload;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`expected ${label} mock calls`);
  }
  const call = calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function replyText(msg: AdmittedWebInboundMessage, callIndex = 0): string {
  return String(mockCallArg(msg.platform.reply, callIndex, 0, "reply"));
}

function findLoggerContext(mock: unknown, message: string, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`expected ${label} mock calls`);
  }
  const call = calls.find((entry) => entry[1] === message);
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

function mockSecondReplySuccess(msg: AdmittedWebInboundMessage) {
  (
    msg.platform.reply as unknown as { mockResolvedValueOnce: (v: unknown) => void }
  ).mockResolvedValueOnce(createAcceptedWhatsAppSendResult("text", "reply-retry-2"));
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

async function expectReplySuppressed(replyResult: { text: string; isReasoning?: boolean }) {
  const msg = makeMsg();
  await deliverWebReply({
    replyResult,
    msg,
    maxMediaBytes: 1024 * 1024,
    textLimit: 200,
    replyLogger,
    skipLog: true,
  });
  expect(msg.platform.reply).not.toHaveBeenCalled();
  expect(msg.platform.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  beforeAll(async () => {
    ({ deliverWebReply } = await import("./deliver-reply.js"));
    ({ whatsappOutbound } = await import("../outbound-adapter.js"));
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
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "Intro line\nReasoning: appears in content but is not a prefix" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalledWith(
      "Intro line\nReasoning: appears in content but is not a prefix",
      undefined,
    );
  });

  it("sends chunked text replies and logs a summary", async () => {
    const msg = makeMsg();

    const delivery = await deliverWebReply({
      replyResult: { text: "aaaaaa" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

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
  });

  it("reports text replies that Baileys did not accept", async () => {
    const msg = makeMsg();
    vi.mocked(msg.platform.reply).mockResolvedValueOnce(unacceptedSendResult("text"));

    const delivery = await deliverWebReply({
      replyResult: { text: "hello" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(delivery.receipt.platformMessageIds).toEqual([]);
    expect(delivery.receipt.parts).toEqual([]);
    expect(delivery.providerAccepted).toBe(false);
    expect(typeof mockCallArg(replyLogger.warn, 0, 0, "replyLogger.warn")).toBe("object");
    expect(mockCallArg(replyLogger.warn, 0, 1, "replyLogger.warn")).toBe(
      "auto-reply text was not accepted by WhatsApp provider",
    );
  });

  it("strips raw XML tool-call blocks before WhatsApp text delivery", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: {
        text: 'Before\n<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>\nAfter',
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 4000,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    const sentText = replyText(msg);
    expect(sentText).not.toContain("function_calls");
    expect(sentText).not.toContain("invoke");
    expect(sentText).toContain("Before");
    expect(sentText).toContain("After");
  });

  it("uses the same final sanitizer stack for auto-reply text delivery", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: {
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
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 4000,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toBe("Before\n\nAfter\n");
  });

  it("strips legacy uppercase TOOL_CALL text before WhatsApp text delivery", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: {
        text: [
          "Before",
          '[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}}[/TOOL_CALL]',
          "After",
        ].join("\n"),
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 4000,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toBe("Before\n\nAfter");
  });

  it("keeps quote threading on every text chunk for a threaded reply", async () => {
    const msg = makeMsg();
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-1", {
      participant: "111@s.whatsapp.net",
      body: "quoted body",
      fromMe: true,
    });

    await deliverWebReply({
      replyResult: { text: "aaaaaa", replyToId: "reply-1" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

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
      const msg = makeMsg();
      mockFirstReplyFailure(msg, errorMessage);
      mockSecondReplySuccess(msg);

      await runWithFakeTimers(() =>
        deliverWebReply({
          replyResult: { text: "hi" },
          msg,
          maxMediaBytes: 1024 * 1024,
          textLimit: 200,
          replyLogger,
          skipLog: true,
        }),
      );

      expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    },
  );

  it("retries text send on wrapped transient failure", async () => {
    const msg = makeMsg();
    mockFirstReplyFailureWithWrappedError(msg, "connection closed");
    mockSecondReplySuccess(msg);

    await runWithFakeTimers(() =>
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    );

    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
  });

  it("does not retry terminal socket operation timeouts", async () => {
    const msg = makeMsg();
    const timeout = await createSocketOperationTimeoutError();
    (
      msg.platform.reply as unknown as { mockRejectedValueOnce: (error: unknown) => void }
    ).mockRejectedValueOnce(timeout);

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toBe(timeout);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
  });

  it("sends image media with caption and then remaining text", async () => {
    const msg = makeMsg();
    const mediaLocalRoots = ["/tmp/workspace-work"];
    mockLoadedImageMedia();

    await deliverWebReply({
      replyResult: { text: "aaaaaa", mediaUrl: "http://example.com/img.jpg" },
      msg,
      mediaLocalRoots,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("http://example.com/img.jpg", {
      maxBytes: 1024 * 1024,
      localRoots: mediaLocalRoots,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.image, "sendMedia image");
    expect(mediaPayload.caption).toBe("aaa");
    expect(mediaPayload.mimetype).toBe("image/jpeg");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(msg.platform.reply).toHaveBeenCalledWith("aaa", undefined);
    findLoggerContext(replyLogger.info, "auto-reply sent (media)", "replyLogger.info");
    expect(logVerbose).toHaveBeenCalled();
  });

  it("marks errors visible after accepted media delivery", async () => {
    const msg = makeMsg();
    const error = new Error("tail send failed");
    mockLoadedImageMedia();
    vi.mocked(msg.platform.reply).mockRejectedValue(error);

    await expect(
      deliverWebReply({
        replyResult: { text: "captiontail", mediaUrl: "http://example.com/img.jpg" },
        msg,
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
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "\n \n    indented block" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalledWith("    indented block", undefined);
  });

  it("keeps quote threading on media and trailing text chunks for a threaded reply", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-2", {
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
      fromMe: true,
    });

    await deliverWebReply({
      replyResult: {
        text: "captiontrail",
        mediaUrl: "http://example.com/img.jpg",
        replyToId: "reply-2",
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 7,
      replyLogger,
      skipLog: true,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
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
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "socket reset");
    (
      msg.platform.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "media-retry-2"));

    await runWithFakeTimers(() =>
      deliverWebReply({
        replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    );

    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(2);
  });

  it("falls back to text-only when the first media send fails", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "boom");

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 20,
      replyLogger,
      skipLog: true,
    });

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
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "boom");

    await deliverWebReply({
      replyResult: { text: "ALPHALINEBRAVOLINE", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 9,
      replyLogger,
      skipLog: true,
    });

    expect(replyText(msg, 0)).toContain("ALPHALINE");
    expect(replyText(msg, 0)).toContain("⚠️ Media failed");
    const allReplies = (
      msg.platform.reply as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(allReplies).toContain("ALPHALINE");
    expect(allReplies).toContain("BRAVOLINE");
    expect(allReplies).not.toContain("boom");
  });

  it("still attempts later media after the first media fails", async () => {
    vi.clearAllMocks();
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("bad"),
      contentType: "image/jpeg",
      kind: "image",
    });
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("good"),
      contentType: "application/pdf",
      kind: "file",
      fileName: "good.pdf",
    });
    mockFirstSendMediaFailure(msg, "boom");
    (
      msg.platform.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "media-second-1"));

    await deliverWebReply({
      replyResult: {
        text: "caption",
        mediaUrls: ["http://example.com/bad.jpg", "http://example.com/good.pdf"],
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

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
    const msg = makeMsg();
    mockLoadedImageMedia();

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl, mediaUrls },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(loadWebMedia).toHaveBeenCalledTimes(1);
    expect(loadWebMedia).toHaveBeenCalledWith(expectedMediaUrl, {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(1);
  });

  it("notifies user when a non-first media send fails instead of dropping silently", async () => {
    vi.clearAllMocks();
    const msg = makeMsg();
    // Two media items: first load succeeds and sends, second load succeeds but send fails.
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("img1"),
      contentType: "image/jpeg",
      kind: "image",
    });
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("img2"),
      contentType: "image/jpeg",
      kind: "image",
    });
    // First sendMedia resolves; second sendMedia rejects.
    (
      msg.platform.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "media-first-ok"));
    (
      msg.platform.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
    ).mockRejectedValueOnce(new Error("upload failed"));

    await deliverWebReply({
      replyResult: {
        text: "caption",
        mediaUrls: ["http://example.com/img1.jpg", "http://example.com/img2.jpg"],
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    // First media succeeded — no text reply for it.
    // Second media failed — user must be notified, not silently dropped.
    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toContain("⚠️ Media unavailable");
    expect(replyText(msg)).not.toContain("upload failed");
  });

  it("sanitizes XML tool-call blocks for outbound sendPayload delivery", async () => {
    const sendWhatsApp = vi.fn(async (_to: string, _text: string) => ({
      messageId: "wa-1",
      toJid: "jid",
    }));

    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: {
        text: 'Before\n<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>\nAfter',
      },
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const sentText = mockCallArg(sendWhatsApp, 0, 1, "sendWhatsApp");
    expect(sentText).not.toContain("function_calls");
    expect(sentText).not.toContain("invoke");
    expect(sentText).toContain("Before");
    expect(sentText).toContain("After");
  });

  it("keeps payload and auto-reply media normalization in parity", async () => {
    const payload = {
      text: "\n\ncaption",
      mediaUrls: ["   ", " /tmp/voice.ogg "],
    };
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload,
      deps: { sendWhatsApp },
    });

    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("aud"),
      contentType: "audio/ogg",
      kind: "audio",
    });

    await deliverWebReply({
      replyResult: payload,
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenCalledWith(
      "5511999999999@c.us",
      "caption",
      expect.objectContaining({
        verbose: false,
        cfg: {},
        mediaUrl: "/tmp/voice.ogg",
        mediaLocalRoots: undefined,
        accountId: undefined,
        gifPlayback: undefined,
        onDeliveryResult: expect.any(Function),
      }),
    );
    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/voice.ogg", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(1);
    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.audio, "sendMedia audio");
    expect(mediaPayload.ptt).toBe(true);
    expect(mediaPayload.mimetype).toBe("audio/ogg; codecs=opus");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.platform.reply).toHaveBeenCalledWith("caption", undefined);
  });

  it("sends audio media as ptt voice note with visible text separately", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("aud"),
      contentType: "audio/ogg",
      kind: "audio",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/a.ogg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.audio, "sendMedia audio");
    expect(mediaPayload.ptt).toBe(true);
    expect(mediaPayload.mimetype).toBe("audio/ogg; codecs=opus");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.platform.reply).toHaveBeenCalledWith("cap", undefined);
  });

  it("transcodes mp3 audio media before sending a ptt voice note", async () => {
    vi.clearAllMocks();
    hoisted.transcodeAudioBufferToOpus.mockResolvedValue(Buffer.from("opus-output"));
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("mp3"),
      contentType: "audio/mpeg",
      kind: "audio",
      fileName: "voice.mp3",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/a.mp3" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

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
    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expect(mediaPayload.audio).toEqual(Buffer.from("opus-output"));
    expect(mediaPayload.ptt).toBe(true);
    expect(mediaPayload.mimetype).toBe("audio/ogg; codecs=opus");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.platform.reply).toHaveBeenCalledWith("cap", undefined);
  });

  it("sends video media", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("vid"),
      contentType: "video/mp4",
      kind: "video",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/v.mp4" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.video, "sendMedia video");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("video/mp4");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });

  it("sends non-audio/image/video media as document", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("bin"),
      contentType: undefined,
      kind: "file",
      fileName: "x.bin",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/x.bin" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.document, "sendMedia document");
    expect(mediaPayload.fileName).toBe("x.bin");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("application/octet-stream");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });

  it("strips URL query and fragment data from derived document file names", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("pdf"),
      contentType: "application/pdf",
      kind: "file",
    });

    await deliverWebReply({
      replyResult: {
        text: "cap",
        mediaUrl: "https://example.com/report.pdf?X-Amz-Signature=secret#frag",
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    const mediaPayload = requireRecord(
      mockCallArg(msg.platform.sendMedia, 0, 0, "sendMedia"),
      "sendMedia payload",
    );
    expectBuffer(mediaPayload.document, "sendMedia document");
    expect(mediaPayload.fileName).toBe("report.pdf");
    expect(mediaPayload.caption).toBe("cap");
    expect(mediaPayload.mimetype).toBe("application/pdf");
    expect(mockCallArg(msg.platform.sendMedia, 0, 1, "sendMedia")).toBeUndefined();
  });
});
