import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { markdownToSignalTextChunks } from "../../signal/format.js";
import { deliverOutboundPayloads, normalizeOutboundPayloads } from "./deliver.js";

describe("deliverOutboundPayloads", () => {
  it("chunks telegram markdown and passes through accountId", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: ClawdbotConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const results = await deliverOutboundPayloads({
        cfg,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "abcd" }],
        deps: { sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      for (const call of sendTelegram.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ accountId: undefined, verbose: false, textMode: "html" }),
        );
      }
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ channel: "telegram", chatId: "c1" });
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("passes explicit accountId to sendTelegram", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: ClawdbotConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "telegram",
      to: "123",
      accountId: "default",
      payloads: [{ text: "hi" }],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: "default", verbose: false, textMode: "html" }),
    );
  });

  it("uses signal media maxBytes from config", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: ClawdbotConfig = { channels: { signal: { mediaMaxMb: 2 } } };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "signal",
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
        textMode: "plain",
        textStyles: [],
      }),
    );
    expect(results[0]).toMatchObject({ channel: "signal", messageId: "s1" });
  });

  it("chunks Signal markdown using the format-first chunker", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: ClawdbotConfig = {
      channels: { signal: { textChunkLimit: 20 } },
    };
    const text = `Intro\\n\\n\`\`\`\`md\\n${"y".repeat(60)}\\n\`\`\`\\n\\nOutro`;
    const expectedChunks = markdownToSignalTextChunks(text, 20);

    await deliverOutboundPayloads({
      cfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(expectedChunks.length);
    expectedChunks.forEach((chunk, index) => {
      expect(sendSignal).toHaveBeenNthCalledWith(
        index + 1,
        "+1555",
        chunk.text,
        expect.objectContaining({
          accountId: undefined,
          textMode: "plain",
          textStyles: chunk.styles,
        }),
      );
    });
  });

  it("chunks WhatsApp text and returns all results", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const cfg: ClawdbotConfig = {
      channels: { whatsapp: { textChunkLimit: 2 } },
    };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "abcd" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["w1", "w2"]);
  });

  it("uses iMessage media maxBytes from agent fallback", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1" });
    const cfg: ClawdbotConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "imessage",
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

  it("normalizes payloads and drops empty entries", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "hi" },
      { mediaUrl: "https://x.test/a.jpg" },
      { text: " ", mediaUrls: [] },
    ]);
    expect(normalized).toEqual([
      { text: "hi", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/a.jpg"] },
      { text: " ", mediaUrls: [] },
    ]);
  });

  it("continues on errors when bestEffort is enabled", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const onError = vi.fn();
    const cfg: ClawdbotConfig = {};

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "a" }, { text: "b" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "whatsapp", messageId: "w2", toJid: "jid" }]);
  });
});
