import { describe, expect, it, vi } from "vitest";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { createWhatsAppPollFixture } from "./outbound-test-support.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

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

  it("forwards audioAsVoice to sendMessageWhatsApp", async () => {
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-voice",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendMedia!({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "voice",
      mediaUrl: "/tmp/workspace/voice.ogg",
      audioAsVoice: true,
      accountId: "default",
      deps: { sendWhatsApp: sendMessageWhatsApp },
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "voice",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/voice.ogg",
        audioAsVoice: true,
        accountId: "default",
      }),
    );
  });

  it("uses the configured default account for quote metadata lookup when accountId is omitted", async () => {
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-1", {
      participant: "111@s.whatsapp.net",
      body: "quoted body",
    });
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

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              work: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+15551234567",
      text: "reply",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-1",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-1",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
          participant: "111@s.whatsapp.net",
          messageText: "quoted body",
        },
      }),
    );
  });

  it("normalizes mixed-case defaultAccount before quote metadata lookup", async () => {
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-case", {
      participant: "333@s.whatsapp.net",
      body: "case-normalized body",
    });
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-case",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "Work",
            accounts: {
              work: {},
              other: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+15551234567",
      text: "reply",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-case",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-case",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
          participant: "333@s.whatsapp.net",
          messageText: "case-normalized body",
        },
      }),
    );
  });

  it("matches sorted default-account fallback for quote metadata lookup when defaultAccount is unset", async () => {
    cacheInboundMessageMeta("alpha", "15551234567@s.whatsapp.net", "reply-2", {
      participant: "222@s.whatsapp.net",
      body: "sorted default body",
    });
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-2",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              zeta: {},
              alpha: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+15551234567",
      text: "reply",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-2",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-2",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
          participant: "222@s.whatsapp.net",
          messageText: "sorted default body",
        },
      }),
    );
  });

  it("reuses the cached inbound remoteJid when the outbound target normalizes differently", async () => {
    cacheInboundMessageMeta("default", "277038292303944@lid", "reply-lid", {
      participant: "5511976136970@s.whatsapp.net",
      body: "quoted from lid chat",
      fromMe: true,
    });
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-lid",
      toJid: "5511976136970@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+5511976136970",
      text: "reply",
      accountId: "default",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-lid",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+5511976136970",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-lid",
          remoteJid: "277038292303944@lid",
          fromMe: true,
          participant: "5511976136970@s.whatsapp.net",
          messageText: "quoted from lid chat",
        },
      }),
    );
  });

  it("normalizes explicit accountId before quote metadata lookup", async () => {
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-explicit", {
      participant: "333@s.whatsapp.net",
      body: "explicit account body",
    });
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-explicit",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+15551234567",
      text: "reply",
      accountId: "Work",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-explicit",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-explicit",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
          participant: "333@s.whatsapp.net",
          messageText: "explicit account body",
        },
      }),
    );
  });

  it("falls back to the target JID when quote metadata only exists in a different conversation", async () => {
    cacheInboundMessageMeta("default", "120363400000000000@g.us", "reply-group", {
      participant: "5511976136970@s.whatsapp.net",
      body: "group-only body",
    });
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-group-miss",
      toJid: "5511976136970@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
    });

    await outbound.sendText!({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {},
            },
          },
        },
      } as never,
      to: "whatsapp:+5511976136970",
      text: "reply",
      accountId: "default",
      deps: { sendWhatsApp: sendMessageWhatsApp },
      replyToId: "reply-group",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+5511976136970",
      "reply",
      expect.objectContaining({
        quotedMessageKey: {
          id: "reply-group",
          remoteJid: "5511976136970@s.whatsapp.net",
          fromMe: false,
          participant: undefined,
          messageText: undefined,
        },
      }),
    );
  });

  it("normalizes mediaUrls before payload delivery", async () => {
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

    await outbound.sendPayload!({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "",
      payload: {
        text: "\n\ncaption",
        mediaUrls: ["   ", " /tmp/voice.ogg "],
      },
      deps: { sendWhatsApp: sendMessageWhatsApp },
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "caption",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/voice.ogg",
      }),
    );
  });

  it("keeps explicit mediaUrl first when payload also includes mediaUrls", async () => {
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

    await outbound.sendPayload!({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "",
      payload: {
        text: "\n\ncaption",
        mediaUrl: "/tmp/primary.ogg",
        mediaUrls: [" /tmp/secondary.ogg "],
      },
      deps: { sendWhatsApp: sendMessageWhatsApp },
    });

    expect(sendMessageWhatsApp).toHaveBeenNthCalledWith(
      1,
      "whatsapp:+15551234567",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/primary.ogg",
      }),
    );
    expect(sendMessageWhatsApp).toHaveBeenNthCalledWith(
      2,
      "whatsapp:+15551234567",
      "",
      expect.objectContaining({
        mediaUrl: "/tmp/secondary.ogg",
      }),
    );
  });

  it("uses the caller-provided text normalization for payload delivery", async () => {
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
      normalizeText: (text) => (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, ""),
    });

    await outbound.sendPayload!({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "",
      payload: {
        text: "\n \n    indented",
      },
      deps: { sendWhatsApp: sendMessageWhatsApp },
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "    indented",
      expect.objectContaining({
        verbose: false,
      }),
    );
  });

  it("rejects structured-only payloads instead of reporting an empty successful send", async () => {
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

    await expect(
      outbound.sendPayload!({
        cfg: {} as never,
        to: "whatsapp:+15551234567",
        text: "",
        payload: {
          channelData: { kind: "structured-only" },
        },
        deps: { sendWhatsApp: sendMessageWhatsApp },
      }),
    ).rejects.toThrow(
      "WhatsApp sendPayload does not support structured-only payloads without text or media.",
    );
    expect(sendMessageWhatsApp).not.toHaveBeenCalled();
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
