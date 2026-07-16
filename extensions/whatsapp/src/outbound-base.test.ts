import { describe, expect, it, vi } from "vitest";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { createWhatsAppPollFixture } from "./outbound-test-support.js";

describe("createWhatsAppOutboundBase", () => {
  it("exposes the provided chunker", () => {
    const outbound = createWhatsAppOutboundBase({
      chunker: (text, limit) => [text.slice(0, limit)],
      sendMessageWhatsApp: vi.fn(),
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    expect(outbound.chunker?.("alpha beta", 5)).toEqual(["alpha"]);
  });

  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await outbound.sendMedia!({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      gifPlayback: false,
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
        gifPlayback: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });

  it("threads cfg into sendPollWhatsApp call", async () => {
    const sendPollWhatsApp = vi.fn(async () => ({
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp: vi.fn(),
      sendPollWhatsApp,
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await outbound.sendPoll!({
      cfg,
      to,
      poll,
      accountId,
    });

    expect(sendPollWhatsApp).toHaveBeenCalledWith(to, poll, {
      verbose: false,
      accountId,
      cfg,
    });
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});
