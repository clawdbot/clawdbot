import fsSync from "node:fs";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sleep } from "openclaw/plugin-sdk/text-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadWebMedia } from "../media.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import type { WebInboundMsg } from "./types.js";

const hoisted = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    runFfmpeg: hoisted.runFfmpeg,
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

vi.mock("openclaw/plugin-sdk/text-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/text-runtime")>(
    "openclaw/plugin-sdk/text-runtime",
  );
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

let deliverWebReply: typeof import("./deliver-reply.js").deliverWebReply;
let whatsappOutbound: typeof import("../outbound-adapter.js").whatsappOutbound;

function acceptedSendResult(kind: "media" | "text", id: string) {
  return {
    kind,
    messageId: id,
    messageIds: [id],
    keys: [{ id }],
    providerAccepted: true,
  };
}

function unacceptedSendResult(kind: "media" | "text") {
  return {
    kind,
    messageId: "unknown",
    messageIds: [],
    keys: [],
    providerAccepted: false,
  };
}

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    to: "+20000000000",
    accountId: "work",
    chatId: "15551234567@s.whatsapp.net",
    chatType: "group",
    id: "msg-1",
    body: "latest batch body",
    senderJid: "222@s.whatsapp.net",
    reply: vi.fn(async () => acceptedSendResult("text", "reply-sent-1")),
    sendMedia: vi.fn(async () => acceptedSendResult("media", "media-sent-1")),
  } as unknown as WebInboundMsg;
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

function mockFirstSendMediaFailure(msg: WebInboundMsg, message: string) {
  (
    msg.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce(new Error(message));
}

function mockFirstReplyFailure(msg: WebInboundMsg, message: string) {
  (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
    new Error(message),
  );
}

function mockFirstReplyFailureWithWrappedError(msg: WebInboundMsg, message: string) {
  (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce({
    error: { message },
  });
}

function expectFirstSendMediaPayload(msg: WebInboundMsg) {
  const payload = vi.mocked(msg.sendMedia).mock.calls[0]?.[0];
  expect(payload).toBeDefined();
  return payload;
}

function mockSecondReplySuccess(msg: WebInboundMsg) {
  (msg.reply as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
    acceptedSendResult("text", "reply-retry-2"),
  );
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
  expect(msg.reply).not.toHaveBeenCalled();
  expect(msg.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  beforeAll(async () => {
    ({ deliverWebReply } = await import("./deliver-reply.js"));
    ({ whatsappOutbound } = await import("../outbound-adapter.js"));
  });

  it("suppresses payloads flagged as reasoning", async () => {
    await expectReplySuppressed({ text: "Reasoning:\n_hidden_", isReasoning: true });
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

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith(
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

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "aaa", undefined);
    expect(msg.reply).toHaveBeenNthCalledWith(2, "aaa", undefined);
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (text)");
    expect(delivery.providerAccepted).toBe(true);
    expect(delivery.messageIds).toEqual(["reply-sent-1"]);
  });

  it("reports text replies that Baileys did not accept", async () => {
    const msg = makeMsg();
    vi.mocked(msg.reply).mockResolvedValueOnce(unacceptedSendResult("text"));

    const delivery = await deliverWebReply({
      replyResult: { text: "hello" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(delivery).toMatchObject({
      messageIds: [],
      providerAccepted: false,
    });
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.any(Object),
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

    expect(msg.reply).toHaveBeenCalledTimes(1);
    const sentText = vi.mocked(msg.reply).mock.calls[0]?.[0];
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

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(msg.reply).mock.calls[0]?.[0]).toBe("Before\n\nAfter\n");
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

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(
      1,
      "aaa",
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({
            id: "reply-1",
            fromMe: true,
            participant: "111@s.whatsapp.net",
          }),
          message: { conversation: "quoted body" },
        }),
      }),
    );
    expect(msg.reply).toHaveBeenNthCalledWith(
      2,
      "aaa",
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({
            id: "reply-1",
            fromMe: true,
            participant: "111@s.whatsapp.net",
          }),
          message: { conversation: "quoted body" },
        }),
      }),
    );
  });

  it.each(["connection closed", "operation timed out"])(
    "retries text send on transient failure: %s",
    async (errorMessage) => {
      const msg = makeMsg();
      mockFirstReplyFailure(msg, errorMessage);
      mockSecondReplySuccess(msg);

      await deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      });

      expect(msg.reply).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(500);
    },
  );

  it("retries text send on wrapped transient failure", async () => {
    const msg = makeMsg();
    mockFirstReplyFailureWithWrappedError(msg, "connection closed");
    mockSecondReplySuccess(msg);

    await deliverWebReply({
      replyResult: { text: "hi" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: "aaa",
        mimetype: "image/jpeg",
      }),
      undefined,
    );
    expect(msg.reply).toHaveBeenCalledWith("aaa", undefined);
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (media)");
    expect(logVerbose).toHaveBeenCalled();
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

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("    indented block", undefined);
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: "caption",
        mimetype: "image/jpeg",
      }),
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({
            id: "reply-2",
            fromMe: true,
            participant: "111@s.whatsapp.net",
          }),
          message: { conversation: "quoted media body" },
        }),
      }),
    );
    expect(msg.reply).toHaveBeenCalledWith(
      "trail",
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({
            id: "reply-2",
            fromMe: true,
            participant: "111@s.whatsapp.net",
          }),
          message: { conversation: "quoted media body" },
        }),
      }),
    );
  });

  it("retries media send on transient failure", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "socket reset");
    (
      msg.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(acceptedSendResult("media", "media-retry-2"));

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
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

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toContain("⚠️ Media failed");
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).not.toContain("boom");
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "http://example.com/img.jpg" }),
      "failed to send web media reply",
    );
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
      msg.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(acceptedSendResult("media", "media-second-1"));

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
    expect(msg.sendMedia).toHaveBeenCalledTimes(2);
    expect(msg.sendMedia).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "good.pdf",
        caption: undefined,
        mimetype: "application/pdf",
      }),
      undefined,
    );
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toContain("⚠️ Media failed");
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).not.toContain("boom");
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
    const sentText = sendWhatsApp.mock.calls[0]?.[1];
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
    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "caption", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/voice.ogg",
      mediaLocalRoots: undefined,
      accountId: undefined,
      gifPlayback: undefined,
    });
    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/voice.ogg", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.sendMedia).toHaveBeenCalledTimes(1);
    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(Buffer),
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      }),
      undefined,
    );
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.reply).toHaveBeenCalledWith("caption", undefined);
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(Buffer),
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      }),
      undefined,
    );
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.reply).toHaveBeenCalledWith("cap", undefined);
  });

  it("transcodes mp3 audio media before sending a ptt voice note", async () => {
    vi.clearAllMocks();
    hoisted.runFfmpeg.mockImplementation(async (args: string[]) => {
      fsSync.writeFileSync(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
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

    expect(hoisted.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining(["-c:a", "libopus", "-ar", "48000", "-b:a", "64k"]),
    );
    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: Buffer.from("opus-output"),
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      }),
      undefined,
    );
    expect(expectFirstSendMediaPayload(msg)).not.toHaveProperty("caption");
    expect(msg.reply).toHaveBeenCalledWith("cap", undefined);
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.any(Buffer),
        caption: "cap",
        mimetype: "video/mp4",
      }),
      undefined,
    );
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "x.bin",
        caption: "cap",
        mimetype: "application/octet-stream",
      }),
      undefined,
    );
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

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "report.pdf",
        caption: "cap",
        mimetype: "application/pdf",
      }),
      undefined,
    );
  });
});
