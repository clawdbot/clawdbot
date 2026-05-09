import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ path: "/tmp/image.png", contentType: "image/png" })),
);

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (params: unknown) =>
      resolveOutboundAttachmentFromUrlMock(params),
  };
});

const { sendMessageSignal } = await import("./send.js");

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {
          httpUrl: "http://signal.test",
          account: "+15550001111",
        },
      },
    },
  },
};

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    signalRpcRequestMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockClear();
  });

  it("attaches a text receipt for timestamp results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result).toMatchObject({
      messageId: "1234567890",
      timestamp: 1234567890,
      receipt: {
        primaryPlatformMessageId: "1234567890",
        platformMessageIds: ["1234567890"],
        parts: [
          expect.objectContaining({
            platformMessageId: "1234567890",
            kind: "text",
            raw: expect.objectContaining({
              channel: "signal",
              toJid: "+15551234567",
              timestamp: 1234567890,
            }),
          }),
        ],
      },
    });
  });

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });

    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalled();
    expect(result).toMatchObject({
      messageId: "1234567891",
      receipt: {
        primaryPlatformMessageId: "1234567891",
        platformMessageIds: ["1234567891"],
        parts: [
          expect.objectContaining({
            platformMessageId: "1234567891",
            kind: "media",
            raw: expect.objectContaining({
              channel: "signal",
              chatId: "group-1",
            }),
          }),
        ],
      },
    });
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });
});
