import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { deliverOutboundPayloads } from "./deliver.js";

describe("deliverOutboundPayloads", () => {
  it("chunks telegram markdown and passes config token", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: ClawdbotConfig = {
      telegram: { botToken: "tok-1", textChunkLimit: 2 },
    };
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const results = await deliverOutboundPayloads({
        cfg,
        provider: "telegram",
        to: "123",
        payloads: [{ text: "abcd" }],
        deps: { sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      for (const call of sendTelegram.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ token: "tok-1", verbose: false }),
        );
      }
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ provider: "telegram", chatId: "c1" });
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("uses signal media maxBytes from config", async () => {
    const sendSignal = vi
      .fn()
      .mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: ClawdbotConfig = { signal: { mediaMaxMb: 2 } };

    const results = await deliverOutboundPayloads({
      cfg,
      provider: "signal",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaUrl: "https://x.test/a.jpg",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(results[0]).toMatchObject({ provider: "signal", messageId: "s1" });
  });

  it("chunks WhatsApp text and returns all results", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const cfg: ClawdbotConfig = {
      whatsapp: { textChunkLimit: 2 },
    };

    const results = await deliverOutboundPayloads({
      cfg,
      provider: "whatsapp",
      to: "+1555",
      payloads: [{ text: "abcd" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["w1", "w2"]);
  });

  it("uses iMessage media maxBytes from agent fallback", async () => {
    const sendIMessage = vi
      .fn()
      .mockResolvedValue({ messageId: "i1" });
    const cfg: ClawdbotConfig = { agent: { mediaMaxMb: 3 } };

    await deliverOutboundPayloads({
      cfg,
      provider: "imessage",
      to: "chat_id:42",
      payloads: [{ text: "hello" }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hello",
      expect.objectContaining({ maxBytes: 3 * 1024 * 1024 }),
    );
  });
});
