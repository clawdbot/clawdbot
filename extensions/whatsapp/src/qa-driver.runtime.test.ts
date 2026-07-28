// Whatsapp tests cover qa driver plugin behavior.
import { EventEmitter } from "node:events";
import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWhatsAppQaDriverSession } from "./qa-driver.runtime.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

const mocks = vi.hoisted(() => ({
  createWebSendApi: vi.fn(),
  createWaSocket: vi.fn(),
  jidToE164: vi.fn(),
  sendContact: vi.fn(),
  sendLocation: vi.fn(),
  sendPoll: vi.fn(),
  sendReaction: vi.fn(),
  sendSticker: vi.fn(),
  sendMessage: vi.fn(),
  socketSendMessage: vi.fn(),
  waitForWaConnection: vi.fn(),
}));

vi.mock("./session.js", () => ({
  createWaSocket: mocks.createWaSocket,
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  getStatusCode: (error: unknown) =>
    (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode,
  waitForWaConnection: mocks.waitForWaConnection,
}));

vi.mock("./text-runtime.js", () => ({
  jidToE164: mocks.jidToE164,
}));

vi.mock("./inbound/send-api.js", () => ({
  createWebSendApi: mocks.createWebSendApi,
}));

function createMockSocket() {
  return {
    end: vi.fn(),
    ev: new EventEmitter(),
    sendMessage: mocks.socketSendMessage,
    ws: {
      close: vi.fn(),
    },
  };
}

function incomingMessage(remoteJid: string, text: string, id = "message-1"): WAMessage {
  return {
    key: {
      fromMe: false,
      id,
      remoteJid,
    },
    message: {
      conversation: text,
    },
  } as WAMessage;
}

function incomingGroupMessage(params: {
  id?: string;
  participant: string;
  remoteJid: string;
  text: string;
}): WAMessage {
  return {
    key: {
      fromMe: false,
      id: params.id ?? "group-message-1",
      participant: params.participant,
      remoteJid: params.remoteJid,
    },
    message: {
      conversation: params.text,
    },
  } as WAMessage;
}

function incomingImageMessage(remoteJid: string, text: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "image-1",
      remoteJid,
    },
    message: {
      imageMessage: {
        caption: text,
        mimetype: "image/png",
      },
    },
  } as WAMessage;
}

function incomingImageMessageWithoutMime(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "image-no-mime-1",
      remoteJid,
    },
    message: {
      imageMessage: {},
    },
  } as WAMessage;
}

function incomingStickerMessageWithoutMime(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "sticker-no-mime-1",
      remoteJid,
    },
    message: {
      stickerMessage: {},
    },
  } as WAMessage;
}

function incomingAudioMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "audio-1",
      remoteJid,
    },
    message: {
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
      },
    },
  } as WAMessage;
}

function incomingEditedImageMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "edited-image-1",
      remoteJid,
    },
    message: {
      editedMessage: {
        message: {
          imageMessage: {
            caption: "edited image caption",
          },
        },
      },
    },
  } as WAMessage;
}

function incomingLocationMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "location-1",
      remoteJid,
    },
    message: {
      locationMessage: {
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
      },
    },
  } as WAMessage;
}

function incomingReactionMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "reaction-1",
      remoteJid,
    },
    message: {
      reactionMessage: {
        text: "👍",
        key: {
          fromMe: true,
          id: "driver-message-1",
          participant: "15551234567@s.whatsapp.net",
        },
      },
    },
  } as WAMessage;
}

function incomingQuotedMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "quoted-reply-1",
      remoteJid,
    },
    message: {
      extendedTextMessage: {
        text: "reply body",
        contextInfo: {
          participant: "15551234567@s.whatsapp.net",
          quotedMessage: {
            conversation: "original body",
          },
          stanzaId: "driver-message-1",
        },
      },
    },
  } as WAMessage;
}

function incomingQuotedLocationMessage(remoteJid: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "quoted-location-reply-1",
      remoteJid,
    },
    message: {
      extendedTextMessage: {
        text: "reply body",
        contextInfo: {
          participant: "15551234567@s.whatsapp.net",
          quotedMessage: {
            locationMessage: {
              degreesLatitude: 37.7749,
              degreesLongitude: -122.4194,
            },
          },
          stanzaId: "driver-location-1",
        },
      },
    },
  } as WAMessage;
}

describe("startWhatsAppQaDriverSession", () => {
  beforeEach(() => {
    mocks.createWebSendApi.mockImplementation(() => ({
      sendContact: mocks.sendContact,
      sendLocation: mocks.sendLocation,
      sendMessage: mocks.sendMessage,
      sendPoll: mocks.sendPoll,
      sendReaction: mocks.sendReaction,
      sendSticker: mocks.sendSticker,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("normalizes LID-backed senders using the QA auth directory", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingMessage("12345@lid", "hello")],
    });

    expect(mocks.jidToE164).toHaveBeenCalledWith("12345@lid", {
      authDir: "/tmp/openclaw-whatsapp-auth",
    });
    const observedMessages = session.getObservedMessages();
    const observedAt = observedMessages[0]?.observedAt;
    expect(observedAt).toBe(new Date(observedAt ?? "").toISOString());
    expect(observedMessages).toEqual([
      {
        fromJid: "12345@lid",
        fromPhoneE164: "+15551234567",
        kind: "text",
        messageId: "message-1",
        observedAt,
        text: "hello",
      },
    ]);

    await session.close();
  });

  it("normalizes group participants separately from the group conversation JID", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [
        incomingGroupMessage({
          participant: "15551234567@s.whatsapp.net",
          remoteJid: "120363000000000000@g.us",
          text: "hello group",
        }),
      ],
    });

    expect(mocks.jidToE164).toHaveBeenCalledWith("15551234567@s.whatsapp.net", {
      authDir: "/tmp/openclaw-whatsapp-auth",
    });
    const observedMessages = session.getObservedMessages();
    const observedAt = observedMessages[0]?.observedAt;
    expect(observedAt).toBe(new Date(observedAt ?? "").toISOString());
    expect(observedMessages).toEqual([
      {
        fromJid: "120363000000000000@g.us",
        fromPhoneE164: "+15551234567",
        kind: "text",
        messageId: "group-message-1",
        observedAt,
        participantJid: "15551234567@s.whatsapp.net",
        text: "hello group",
      },
    ]);

    await session.close();
  });

  it("normalizes DM senders from the conversation JID when Baileys includes a participant", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockImplementation((jid: string) =>
      jid === "15551234567@s.whatsapp.net" ? "+15551234567" : null,
    );

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [
        {
          key: {
            fromMe: false,
            id: "dm-message-1",
            participant: "99999@lid",
            remoteJid: "15551234567@s.whatsapp.net",
          },
          message: {
            conversation: "hello dm",
          },
        } as WAMessage,
      ],
    });

    expect(mocks.jidToE164).toHaveBeenCalledWith("15551234567@s.whatsapp.net", {
      authDir: "/tmp/openclaw-whatsapp-auth",
    });
    const observedMessages = session.getObservedMessages();
    const observedAt = observedMessages[0]?.observedAt;
    expect(observedMessages).toEqual([
      {
        fromJid: "15551234567@s.whatsapp.net",
        fromPhoneE164: "+15551234567",
        kind: "text",
        messageId: "dm-message-1",
        observedAt,
        participantJid: "99999@lid",
        text: "hello dm",
      },
    ]);

    await session.close();
  });

  it("does not satisfy a wait with messages observed before the lower bound", async () => {
    vi.useFakeTimers();
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    vi.setSystemTime(new Date("2026-06-04T23:42:32.036Z"));
    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingMessage("12345@lid", "OpenClaw status stale", "stale-message")],
    });

    const observedAfter = new Date("2026-06-04T23:46:59.166Z");
    vi.setSystemTime(observedAfter);
    const waited = session.waitForMessage({
      observedAfter,
      timeoutMs: 1_000,
      match: (message) => message.text.includes("OpenClaw status"),
    });

    vi.setSystemTime(new Date("2026-06-04T23:47:00.000Z"));
    sock.ev.emit("messages.upsert", {
      messages: [incomingMessage("12345@lid", "OpenClaw status fresh", "fresh-message")],
    });

    await expect(waited).resolves.toMatchObject({
      messageId: "fresh-message",
      text: "OpenClaw status fresh",
    });

    await session.close();
  });

  it("observes media messages without dropping their caption text", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingImageMessage("12345@lid", "image caption")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      hasMedia: true,
      kind: "media",
      mediaType: "image/png",
      text: "image caption",
    });

    await session.close();
  });

  it("observes audio media messages without requiring a text body", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingAudioMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      hasMedia: true,
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
      text: "",
    });

    await session.close();
  });

  it("uses canonical WhatsApp media MIME defaults when Baileys omits MIME", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [
        incomingImageMessageWithoutMime("12345@lid"),
        incomingStickerMessageWithoutMime("12345@lid"),
      ],
    });

    expect(session.getObservedMessages()).toMatchObject([
      {
        hasMedia: true,
        kind: "media",
        mediaType: "image/jpeg",
      },
      {
        hasMedia: true,
        kind: "media",
        mediaType: "image/webp",
      },
    ]);

    await session.close();
  });

  it("observes media through Baileys future-proof wrappers", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingEditedImageMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      hasMedia: true,
      kind: "media",
      mediaType: "image/jpeg",
      text: "edited image caption",
    });

    await session.close();
  });

  it("observes top-level location messages with canonical location text", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingLocationMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      kind: "location",
      text: "📍 37.774900, -122.419400",
    });

    await session.close();
  });

  it("observes reaction messages that have no text body", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingReactionMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      kind: "reaction",
      reaction: {
        emoji: "👍",
        fromMe: true,
        messageId: "driver-message-1",
        participant: "15551234567@s.whatsapp.net",
      },
      text: "",
    });

    await session.close();
  });

  it("observes quoted reply context", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingQuotedMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      kind: "text",
      quoted: {
        messageId: "driver-message-1",
        participant: "15551234567@s.whatsapp.net",
        text: "original body",
      },
      text: "reply body",
    });

    await session.close();
  });

  it("observes quoted location context with canonical reply body text", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    sock.ev.emit("messages.upsert", {
      messages: [incomingQuotedLocationMessage("12345@lid")],
    });

    expect(session.getObservedMessages()[0]).toMatchObject({
      kind: "text",
      quoted: {
        messageId: "driver-location-1",
        participant: "15551234567@s.whatsapp.net",
        text: "📍 37.774900, -122.419400",
      },
      text: "reply body",
    });

    await session.close();
  });

  it("uses the web send API for existing outbound helpers", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.sendMessage.mockResolvedValue({ messageId: "send-1" });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    mocks.sendReaction.mockResolvedValue({ messageId: "reaction-send-1" });

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    await expect(
      session.sendMedia("15551234567", "caption", Buffer.from("png"), "image/png", {
        fileName: "qa.png",
      }),
    ).resolves.toEqual({ messageId: "send-1" });
    await expect(
      session.sendPoll("15551234567", {
        question: "Pick one",
        options: ["A", "B"],
      }),
    ).resolves.toEqual({ messageId: "poll-1" });
    await expect(
      session.sendReaction("15551234567@s.whatsapp.net", "driver-message-1", "👍", {
        fromMe: true,
      }),
    ).resolves.toEqual({ messageId: "reaction-send-1" });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "15551234567",
      "caption",
      Buffer.from("png"),
      "image/png",
      { fileName: "qa.png" },
    );
    expect(mocks.sendPoll).toHaveBeenCalledWith("15551234567", {
      question: "Pick one",
      options: ["A", "B"],
    });
    expect(mocks.sendReaction).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "driver-message-1",
      "👍",
      true,
      undefined,
    );

    await session.close();
  });

  it("sends structured QA stimuli through the web send API", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.sendContact.mockResolvedValue({ messageId: "contact-1" });
    mocks.sendLocation.mockResolvedValue({ messageId: "location-1" });
    mocks.sendSticker.mockResolvedValue({ messageId: "sticker-1" });

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });

    await expect(
      session.sendContact("15551234567", {
        displayName: "QA Contact",
        vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
      }),
    ).resolves.toEqual({ messageId: "contact-1" });
    await expect(
      session.sendLocation("15551234567", {
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
        name: "QA Location",
      }),
    ).resolves.toEqual({ messageId: "location-1" });
    await expect(
      session.sendSticker("15551234567", Buffer.from("webp"), { mimetype: "image/webp" }),
    ).resolves.toEqual({ messageId: "sticker-1" });

    expect(mocks.sendContact).toHaveBeenCalledWith("15551234567", {
      displayName: "QA Contact",
      vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
    });
    expect(mocks.sendLocation).toHaveBeenCalledWith("15551234567", {
      degreesLatitude: 37.7749,
      degreesLongitude: -122.4194,
      name: "QA Location",
    });
    expect(mocks.sendSticker).toHaveBeenCalledWith("15551234567", Buffer.from("webp"), {
      mimetype: "image/webp",
    });
    expect(mocks.socketSendMessage).not.toHaveBeenCalled();

    await session.close();
  });

  it("passes the connection timeout to the shared connection waiter", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
      connectionTimeoutMs: 45_000,
    });

    expect(mocks.waitForWaConnection).toHaveBeenCalledWith(sock, { timeoutMs: 45_000 });

    await session.close();
  });

  it("passes a bounded socket adapter to the send API", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });
    const sendApiParams = mocks.createWebSendApi.mock.calls[0]?.[0] as {
      sock: {
        sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
      };
    };

    vi.useFakeTimers();
    try {
      sock.sendMessage.mockImplementationOnce(async () => await new Promise(() => {}));

      const sendPromise = sendApiParams.sock.sendMessage("1555@s.whatsapp.net", { text: "hi" });
      const rejection = expect(sendPromise).rejects.toMatchObject({
        name: "WhatsAppSocketOperationTimeoutError",
        operation: "sendMessage",
        timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);

      await rejection;
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  it("can wait for pending notifications before returning the driver session", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);

    const pending = startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
      connectionTimeoutMs: 10_000,
      waitForPendingNotifications: true,
    });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);

    sock.ev.emit("connection.update", { receivedPendingNotifications: true });

    const session = await pending;
    expect(settled).toBe(true);
    await session.close();
  });

  it("rejects pending and future waits when the connected driver session closes", async () => {
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
    });
    const pending = session.waitForMessage({
      match: (message) => message.text.includes("approval required"),
      timeoutMs: 60_000,
    });

    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        date: new Date("2026-06-05T17:54:52.000Z"),
        error: {
          output: {
            statusCode: 428,
          },
        },
      },
    });

    await expect(pending).rejects.toThrow("WhatsApp QA driver connection closed (status 428)");
    await expect(
      session.waitForMessage({
        match: (message) => message.text.includes("approval required"),
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("WhatsApp QA driver connection closed (status 428)");
    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.end).toHaveBeenCalledOnce();
  });

  it("closes the socket and removes listeners when connection setup times out", async () => {
    const sock = createMockSocket();
    const timeoutError = new Error("timed out waiting for WhatsApp QA driver session");
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockRejectedValue(timeoutError);

    await expect(
      startWhatsAppQaDriverSession({
        authDir: "/tmp/openclaw-whatsapp-auth",
        connectionTimeoutMs: 10,
      }),
    ).rejects.toThrow("timed out waiting for WhatsApp QA driver session");

    expect(mocks.waitForWaConnection).toHaveBeenCalledWith(sock, { timeoutMs: 10 });
    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.end).toHaveBeenCalledOnce();
  });
});
