import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";

const sendTextMock = vi.hoisted(() => vi.fn());
const sendMediaMock = vi.hoisted(() => vi.fn());

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

    await expect(
      verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "qqbot",
        adapter: qqbotPlugin.message!,
        proofs: {
          text: async () => {
            const result = await qqbotPlugin.message?.send?.text?.({
              cfg,
              to: "qqbot:c2c:user-1",
              text: "hello",
            });
            expect(sendTextMock).toHaveBeenCalledWith(
              expect.objectContaining({
                to: "qqbot:c2c:user-1",
                text: "hello",
              }),
            );
            expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
          },
          media: async () => {
            const result = await qqbotPlugin.message?.send?.media?.({
              cfg,
              to: "qqbot:c2c:user-1",
              text: "image",
              mediaUrl: "https://example.com/image.png",
            });
            expect(sendMediaMock).toHaveBeenCalledWith(
              expect.objectContaining({
                to: "qqbot:c2c:user-1",
                text: "image",
                mediaUrl: "https://example.com/image.png",
              }),
            );
            expect(result?.receipt.platformMessageIds).toEqual(["qq-media-1"]);
          },
          replyTo: async () => {
            const result = await qqbotPlugin.message?.send?.text?.({
              cfg,
              to: "qqbot:group:group-1",
              text: "reply",
              replyToId: "msg-1",
            });
            expect(sendTextMock).toHaveBeenCalledWith(
              expect.objectContaining({
                to: "qqbot:group:group-1",
                replyToId: "msg-1",
              }),
            );
            expect(result?.receipt.platformMessageIds).toEqual(["qq-text-1"]);
          },
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "verified" },
        { capability: "replyTo", status: "verified" },
      ]),
    );
  });
});
