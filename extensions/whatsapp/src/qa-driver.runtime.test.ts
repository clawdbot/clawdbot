// Whatsapp tests cover qa driver plugin behavior.
import { EventEmitter } from "node:events";
import type { proto, WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWhatsAppQaDriverSession, type WhatsAppQaDriverSession } from "./qa-driver.runtime.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

const AUTH_DIR = "/tmp/openclaw-whatsapp-auth";
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
vi.mock("./text-runtime.js", () => ({ jidToE164: mocks.jidToE164 }));
vi.mock("./inbound/send-api.js", () => ({ createWebSendApi: mocks.createWebSendApi }));

function createMockSocket() {
  return {
    end: vi.fn(),
    ev: new EventEmitter(),
    sendMessage: mocks.socketSendMessage,
  };
}

type MockSocket = ReturnType<typeof createMockSocket>;
type MessageKey = {
  fromMe?: boolean;
  id?: string;
  participant?: string;
  remoteJid?: string;
};

let sock: MockSocket;
const sessions = new Set<WhatsAppQaDriverSession>();

function incoming(message: proto.IMessage, key: MessageKey = {}): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "message-1",
      remoteJid: "12345@lid",
      ...key,
    },
    message,
  } as WAMessage;
}

function emitMessages(...messages: WAMessage[]) {
  sock.ev.emit("messages.upsert", { messages });
}

function expectCalled(mock: ReturnType<typeof vi.fn>, ...args: unknown[]) {
  expect(mock).toHaveBeenCalledWith(...args);
}

async function startSession(
  options: { connectionTimeoutMs?: number; waitForPendingNotifications?: boolean } = {},
) {
  const session = await startWhatsAppQaDriverSession({ authDir: AUTH_DIR, ...options });
  sessions.add(session);
  return session;
}

async function observe(message: proto.IMessage, key?: MessageKey) {
  const session = await startSession();
  emitMessages(incoming(message, key));
  return session.getObservedMessages()[0];
}

const pollExpected = {
  kind: "poll",
  poll: { question: "Choose a time", options: ["Morning", "Afternoon"] },
};
const pollMessage = (pollKey: string) => ({
  [pollKey]: {
    name: "Choose a time",
    options: [{ optionName: "Morning" }, { optionName: "Afternoon" }],
  },
});
const ingressCases = [
  ...[
    ["captionless video note", { ptvMessage: {} }],
    ["ephemeral captionless video note", { ephemeralMessage: { message: { ptvMessage: {} } } }],
    ["edited captionless video note", { editedMessage: { message: { ptvMessage: {} } } }],
  ].map(([name, message]) => ({
    name,
    message,
    expected: { kind: "media", mediaType: "video/mp4", text: "" },
  })),
  ...[
    "pollCreationMessage",
    "pollCreationMessageV2",
    "pollCreationMessageV3",
    "pollCreationMessageV5",
  ].flatMap((pollKey) => {
    const message = pollMessage(pollKey);
    return [
      { name: pollKey, message, expected: pollExpected },
      {
        name: `ephemeral ${pollKey}`,
        message: { ephemeralMessage: { message } },
        expected: pollExpected,
      },
    ];
  }),
  ...["pollCreationMessageV3", "pollCreationMessageV5"].flatMap((pollKey) => {
    const message = pollMessage(pollKey);
    const wrapped = { pollCreationMessageV4: { message } };
    return [
      { name: `future-proof version-4 ${pollKey}`, message: wrapped, expected: pollExpected },
      {
        name: `ephemeral future-proof version-4 ${pollKey}`,
        message: { ephemeralMessage: { message: wrapped } },
        expected: pollExpected,
      },
      {
        name: `edited ${pollKey}`,
        message: { editedMessage: { message } },
        expected: pollExpected,
      },
    ];
  }),
];

describe("startWhatsAppQaDriverSession", () => {
  beforeEach(() => {
    sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);
    mocks.jidToE164.mockReturnValue("+15551234567");
    mocks.createWebSendApi.mockImplementation(() => ({
      sendContact: mocks.sendContact,
      sendLocation: mocks.sendLocation,
      sendMessage: mocks.sendMessage,
      sendPoll: mocks.sendPoll,
      sendReaction: mocks.sendReaction,
      sendSticker: mocks.sendSticker,
    }));
  });

  afterEach(async () => {
    await Promise.all([...sessions].map((session) => session.close()));
    sessions.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "LID-backed senders",
      key: { remoteJid: "12345@lid" },
      normalizedJid: "12345@lid",
    },
    {
      name: "group participants separately from the conversation JID",
      key: {
        id: "group-message-1",
        participant: "15551234567@s.whatsapp.net",
        remoteJid: "120363000000000000@g.us",
      },
      normalizedJid: "15551234567@s.whatsapp.net",
    },
    {
      name: "DM senders from the conversation JID when a participant is present",
      key: {
        id: "dm-message-1",
        participant: "99999@lid",
        remoteJid: "15551234567@s.whatsapp.net",
      },
      normalizedJid: "15551234567@s.whatsapp.net",
    },
  ])("normalizes $name", async ({ key, normalizedJid }) => {
    mocks.jidToE164.mockImplementation((jid: string) =>
      jid === normalizedJid ? "+15551234567" : null,
    );
    const session = await startSession();
    emitMessages(incoming({ conversation: "hello" }, key));

    expect(mocks.jidToE164).toHaveBeenCalledWith(normalizedJid, { authDir: AUTH_DIR });
    const observed = session.getObservedMessages()[0];
    expect(observed?.observedAt).toBe(new Date(observed?.observedAt ?? "").toISOString());
    expect(observed).toEqual({
      fromJid: key.remoteJid,
      fromPhoneE164: "+15551234567",
      kind: "text",
      messageId: key.id ?? "message-1",
      observedAt: observed?.observedAt,
      ...(key.participant ? { participantJid: key.participant } : {}),
      text: "hello",
    });
  });

  it("does not satisfy a wait with messages observed before the lower bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T23:42:32.036Z"));
    const session = await startSession();
    emitMessages(incoming({ conversation: "OpenClaw status stale" }, { id: "stale-message" }));

    const observedAfter = new Date("2026-06-04T23:46:59.166Z");
    vi.setSystemTime(observedAfter);
    const waited = session.waitForMessage({
      observedAfter,
      timeoutMs: 1_000,
      match: (message) => message.text.includes("OpenClaw status"),
    });
    vi.setSystemTime(new Date("2026-06-04T23:47:00.000Z"));
    emitMessages(incoming({ conversation: "OpenClaw status fresh" }, { id: "fresh-message" }));

    await expect(waited).resolves.toMatchObject({
      messageId: "fresh-message",
      text: "OpenClaw status fresh",
    });
  });

  it.each([
    {
      name: "captioned media",
      message: { imageMessage: { caption: "image caption", mimetype: "image/png" } },
      expected: { hasMedia: true, kind: "media", mediaType: "image/png", text: "image caption" },
    },
    {
      name: "bodyless audio",
      message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } },
      expected: { hasMedia: true, kind: "media", mediaType: "audio/ogg; codecs=opus", text: "" },
    },
    {
      name: "future-proof wrapped media",
      message: {
        editedMessage: { message: { imageMessage: { caption: "edited image caption" } } },
      },
      expected: {
        hasMedia: true,
        kind: "media",
        mediaType: "image/jpeg",
        text: "edited image caption",
      },
    },
    {
      name: "top-level locations",
      message: {
        locationMessage: { degreesLatitude: 37.7749, degreesLongitude: -122.4194 },
      },
      expected: { kind: "location", text: "📍 37.774900, -122.419400" },
    },
    {
      name: "bodyless reactions",
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
      expected: {
        kind: "reaction",
        reaction: {
          emoji: "👍",
          fromMe: true,
          messageId: "driver-message-1",
          participant: "15551234567@s.whatsapp.net",
        },
        text: "",
      },
    },
    {
      name: "quoted replies",
      message: {
        extendedTextMessage: {
          text: "reply body",
          contextInfo: {
            participant: "15551234567@s.whatsapp.net",
            quotedMessage: { conversation: "original body" },
            stanzaId: "driver-message-1",
          },
        },
      },
      expected: {
        kind: "text",
        quoted: {
          messageId: "driver-message-1",
          participant: "15551234567@s.whatsapp.net",
          text: "original body",
        },
        text: "reply body",
      },
    },
    {
      name: "quoted locations",
      message: {
        extendedTextMessage: {
          text: "reply body",
          contextInfo: {
            participant: "15551234567@s.whatsapp.net",
            quotedMessage: {
              locationMessage: { degreesLatitude: 37.7749, degreesLongitude: -122.4194 },
            },
            stanzaId: "driver-location-1",
          },
        },
      },
      expected: {
        kind: "text",
        quoted: {
          messageId: "driver-location-1",
          participant: "15551234567@s.whatsapp.net",
          text: "📍 37.774900, -122.419400",
        },
        text: "reply body",
      },
    },
  ])("observes $name", async ({ message, expected }) => {
    expect(await observe(message as proto.IMessage)).toMatchObject(expected);
  });

  it("uses canonical media MIME defaults", async () => {
    const session = await startSession();
    emitMessages(
      incoming({ imageMessage: {} }, { id: "image-no-mime-1" }),
      incoming({ stickerMessage: {} }, { id: "sticker-no-mime-1" }),
    );
    expect(session.getObservedMessages()).toMatchObject([
      { hasMedia: true, kind: "media", mediaType: "image/jpeg" },
      { hasMedia: true, kind: "media", mediaType: "image/webp" },
    ]);
  });

  it.each(ingressCases)(
    "resolves live ingress waiters for $name",
    async ({ message, expected }) => {
      const session = await startSession();
      const observed = session.waitForMessage({
        timeoutMs: 150,
        match: (candidate) => candidate.kind === expected.kind,
      });
      emitMessages(incoming(message as proto.IMessage, { id: "observed-message" }));

      await expect(observed).resolves.toMatchObject(expected);
      expect(session.getObservedMessages()).toHaveLength(1);
    },
  );

  it("adapts all QA sends to the web send API", async () => {
    mocks.sendMessage.mockResolvedValue({ messageId: "send-1" });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    mocks.sendReaction.mockResolvedValue({ messageId: "reaction-send-1" });
    mocks.sendContact.mockResolvedValue({ messageId: "contact-1" });
    mocks.sendLocation.mockResolvedValue({ messageId: "location-1" });
    mocks.sendSticker.mockResolvedValue({ messageId: "sticker-1" });
    const session = await startSession();
    const media = Buffer.from("png");
    const sticker = Buffer.from("webp");

    await expect(
      Promise.all([
        session.sendMedia("15551234567", "caption", media, "image/png", {
          fileName: "qa.png",
        }),
        session.sendPoll("15551234567", { question: "Pick one", options: ["A", "B"] }),
        session.sendReaction("15551234567@s.whatsapp.net", "driver-message-1", "👍", {
          fromMe: true,
        }),
        session.sendContact("15551234567", {
          displayName: "QA Contact",
          vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
        }),
        session.sendLocation("15551234567", {
          degreesLatitude: 37.7749,
          degreesLongitude: -122.4194,
          name: "QA Location",
        }),
        session.sendSticker("15551234567", sticker, { mimetype: "image/webp" }),
      ]),
    ).resolves.toEqual([
      { messageId: "send-1" },
      { messageId: "poll-1" },
      { messageId: "reaction-send-1" },
      { messageId: "contact-1" },
      { messageId: "location-1" },
      { messageId: "sticker-1" },
    ]);
    expectCalled(mocks.sendMessage, "15551234567", "caption", media, "image/png", {
      fileName: "qa.png",
    });
    expectCalled(mocks.sendPoll, "15551234567", {
      question: "Pick one",
      options: ["A", "B"],
    });
    expectCalled(
      mocks.sendReaction,
      "15551234567@s.whatsapp.net",
      "driver-message-1",
      "👍",
      true,
      undefined,
    );
    expectCalled(mocks.sendContact, "15551234567", {
      displayName: "QA Contact",
      vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
    });
    expectCalled(mocks.sendLocation, "15551234567", {
      degreesLatitude: 37.7749,
      degreesLongitude: -122.4194,
      name: "QA Location",
    });
    expectCalled(mocks.sendSticker, "15551234567", sticker, {
      mimetype: "image/webp",
    });
    expect(mocks.socketSendMessage).not.toHaveBeenCalled();
  });

  it("passes the connection timeout to the shared connection waiter", async () => {
    await startSession({ connectionTimeoutMs: 45_000 });
    expect(mocks.waitForWaConnection).toHaveBeenCalledWith(sock, { timeoutMs: 45_000 });
  });

  it("passes a bounded socket adapter to the send API", async () => {
    await startSession();
    const sendApiParams = mocks.createWebSendApi.mock.calls[0]?.[0] as {
      sock: { sendMessage: (jid: string, content: { text: string }) => Promise<unknown> };
    };
    vi.useFakeTimers();
    sock.sendMessage.mockImplementationOnce(async () => await new Promise(() => {}));
    const sendPromise = sendApiParams.sock.sendMessage("1555@s.whatsapp.net", { text: "hi" });
    const rejection = expect(sendPromise).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "sendMessage",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    await rejection;
    vi.useRealTimers();
  });

  it("can wait for pending notifications before returning", async () => {
    const pending = startSession({
      connectionTimeoutMs: 10_000,
      waitForPendingNotifications: true,
    });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    sock.ev.emit("connection.update", { receivedPendingNotifications: true });
    await pending;
    expect(settled).toBe(true);
  });

  it("rejects pending and future waits when the connection closes", async () => {
    const session = await startSession();
    const pending = session.waitForMessage({
      match: (message) => message.text.includes("approval required"),
      timeoutMs: 60_000,
    });
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        date: new Date("2026-06-05T17:54:52.000Z"),
        error: { output: { statusCode: 428 } },
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

  it("closes resources when connection setup times out", async () => {
    mocks.waitForWaConnection.mockRejectedValue(
      new Error("timed out waiting for WhatsApp QA driver session"),
    );
    await expect(startSession({ connectionTimeoutMs: 10 })).rejects.toThrow(
      "timed out waiting for WhatsApp QA driver session",
    );
    expect(mocks.waitForWaConnection).toHaveBeenCalledWith(sock, { timeoutMs: 10 });
    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.end).toHaveBeenCalledOnce();
  });
});
