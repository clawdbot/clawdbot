import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendC2CMessage: vi.fn(),
  sendDmMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendC2CImageMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
}));

const outboundMocks = vi.hoisted(() => ({
  sendPhoto: vi.fn(async () => ({})),
  sendVoice: vi.fn(async () => ({})),
  sendVideoMsg: vi.fn(async () => ({})),
  sendDocument: vi.fn(async () => ({})),
  sendMedia: vi.fn(async () => ({})),
}));

const runtimeMocks = vi.hoisted(() => ({
  chunkMarkdownText: vi.fn((text: string) => [text]),
}));

vi.mock("./api.js", () => ({
  sendC2CMessage: apiMocks.sendC2CMessage,
  sendDmMessage: apiMocks.sendDmMessage,
  sendGroupMessage: apiMocks.sendGroupMessage,
  sendChannelMessage: apiMocks.sendChannelMessage,
  sendC2CImageMessage: apiMocks.sendC2CImageMessage,
  sendGroupImageMessage: apiMocks.sendGroupImageMessage,
}));

vi.mock("./outbound.js", () => ({
  sendPhoto: outboundMocks.sendPhoto,
  sendVoice: outboundMocks.sendVoice,
  sendVideoMsg: outboundMocks.sendVideoMsg,
  sendDocument: outboundMocks.sendDocument,
  sendMedia: outboundMocks.sendMedia,
}));

vi.mock("./runtime.js", () => ({
  getQQBotRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: runtimeMocks.chunkMarkdownText,
      },
    },
  }),
}));

const imageSizeMocks = vi.hoisted(() => ({
  getImageSize: vi.fn(),
  formatQQBotMarkdownImage: vi.fn(),
  hasQQBotImageSize: vi.fn(),
}));

vi.mock("./utils/image-size.js", () => ({
  getImageSize: (...args: unknown[]) => imageSizeMocks.getImageSize(...args),
  formatQQBotMarkdownImage: (...args: unknown[]) =>
    imageSizeMocks.formatQQBotMarkdownImage(...args),
  hasQQBotImageSize: (...args: unknown[]) => imageSizeMocks.hasQQBotImageSize(...args),
}));

import {
  parseAndSendMediaTags,
  sendPlainReply,
  type ConsumeQuoteRefFn,
  type DeliverAccountContext,
  type DeliverEventContext,
  type SendWithRetryFn,
} from "./outbound-deliver.js";

function buildEvent(): DeliverEventContext {
  return {
    type: "c2c",
    senderId: "user-1",
    messageId: "msg-1",
  };
}

function buildAccountContext(markdownSupport: boolean): DeliverAccountContext {
  return {
    qualifiedTarget: "qqbot:c2c:user-1",
    account: {
      accountId: "default",
      appId: "app-id",
      clientSecret: "secret",
      markdownSupport,
      config: {},
    } as DeliverAccountContext["account"],
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

const sendWithRetry: SendWithRetryFn = async (sendFn) => await sendFn("token");
const consumeQuoteRef: ConsumeQuoteRefFn = () => undefined;

describe("qqbot outbound deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.chunkMarkdownText.mockImplementation((text: string) => [text]);
    imageSizeMocks.getImageSize.mockResolvedValue(null);
    imageSizeMocks.formatQQBotMarkdownImage.mockImplementation((url: string) => `![img](${url})`);
    imageSizeMocks.hasQQBotImageSize.mockReturnValue(false);
  });

  it("sends plain replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello plain world",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello plain world",
      "msg-1",
      undefined,
    );
  });

  it("sends markdown replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello markdown world",
      buildEvent(),
      buildAccountContext(true),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello markdown world",
      "msg-1",
      undefined,
    );
  });

  it("routes media-tag text segments through the shared chunk sender", async () => {
    await parseAndSendMediaTags(
      "before<qqimg>https://example.com/a.png</qqimg>after",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      1,
      "app-id",
      "token",
      "user-1",
      "before",
      "msg-1",
      undefined,
    );
    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "app-id",
      "token",
      "user-1",
      "after",
      "msg-1",
      undefined,
    );
    expect(outboundMocks.sendPhoto).toHaveBeenCalledTimes(1);
  });

  describe("private-network image URL degradation", () => {
    it("sends markdown reply with fallback dimensions when getImageSize returns null", async () => {
      imageSizeMocks.getImageSize.mockResolvedValue(null);

      await sendPlainReply(
        {},
        "Look at this: ![photo](https://10.0.0.1/internal.png)",
        buildEvent(),
        buildAccountContext(true),
        sendWithRetry,
        consumeQuoteRef,
        [],
      );

      // getImageSize was called with the private-network URL
      expect(imageSizeMocks.getImageSize).toHaveBeenCalledWith("https://10.0.0.1/internal.png");
      // formatQQBotMarkdownImage was called with null size (triggers default dimensions)
      expect(imageSizeMocks.formatQQBotMarkdownImage).toHaveBeenCalledWith(
        "https://10.0.0.1/internal.png",
        null,
      );
      // Message was still sent (not crashed)
      expect(apiMocks.sendC2CMessage).toHaveBeenCalled();
    });

    it("sends markdown reply with fallback when getImageSize throws", async () => {
      imageSizeMocks.getImageSize.mockRejectedValue(new Error("SSRF blocked"));

      await sendPlainReply(
        {},
        "Check ![img](https://169.254.169.254/latest/meta-data/)",
        buildEvent(),
        buildAccountContext(true),
        sendWithRetry,
        consumeQuoteRef,
        [],
      );

      // formatQQBotMarkdownImage still called with null (catch path in outbound-deliver)
      expect(imageSizeMocks.formatQQBotMarkdownImage).toHaveBeenCalledWith(
        "https://169.254.169.254/latest/meta-data/",
        null,
      );
      expect(apiMocks.sendC2CMessage).toHaveBeenCalled();
    });
  });
});
