import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";

const sendTextMock = vi.hoisted(() => vi.fn());
const sendMediaMock = vi.hoisted(() => vi.fn());

type SentTextParams = {
  to?: string;
  text?: string;
  replyToId?: string | null;
};

type SentMediaParams = {
  to?: string;
  text?: string;
  mediaUrl?: string;
};

function latestMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

vi.mock("./bridge/gateway.js", () => ({}));
vi.mock("./engine/messaging/outbound.js", () => ({
  sendText: sendTextMock,
  sendMedia: sendMediaMock,
}));

const cfg = {
  channels: {
    qqbot: {
      appId: "app",
      clientSecret: "secret",
    },
  },
} as OpenClawConfig;

describe("qqbot message adapter", () => {
  it("declares durable text, media, and reply target capabilities with receipt proofs", async () => {
    sendTextMock.mockResolvedValue({ messageId: "qq-text-1" });
    sendMediaMock.mockResolvedValue({ messageId: "qq-media-1" });

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "qqbot",
      adapter: qqbotPlugin.message!,
      proofs: {
        text: async () => {
          const result = await qqbotPlugin.message?.send?.text?.({
            cfg,
            to: "qqbot:c2c:user-1",
            text: "hello",
          });
          const sent = latestMockArg(sendTextMock, "sendText") as SentTextParams;
          expect(sent.to).toBe("qqbot:c2c:user-1");
          expect(sent.text).toBe("hello");
          expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
        },
        media: async () => {
          const result = await qqbotPlugin.message?.send?.media?.({
            cfg,
            to: "qqbot:c2c:user-1",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          const sent = latestMockArg(sendMediaMock, "sendMedia") as SentMediaParams;
          expect(sent.to).toBe("qqbot:c2c:user-1");
          expect(sent.text).toBe("image");
          expect(sent.mediaUrl).toBe("https://example.com/image.png");
          expect(result?.receipt.platformMessageIds).toEqual(["qq-media-1"]);
        },
        replyTo: async () => {
          const result = await qqbotPlugin.message?.send?.text?.({
            cfg,
            to: "qqbot:group:group-1",
            text: "reply",
            replyToId: "msg-1",
          });
          const sent = latestMockArg(sendTextMock, "sendText") as SentTextParams;
          expect(sent.to).toBe("qqbot:group:group-1");
          expect(sent.text).toBe("reply");
          expect(sent.replyToId).toBe("msg-1");
          expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });
});
