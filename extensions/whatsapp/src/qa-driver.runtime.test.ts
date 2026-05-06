import { EventEmitter } from "node:events";
import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWhatsAppQaDriverSession } from "./qa-driver.runtime.js";

const mocks = vi.hoisted(() => ({
  createWaSocket: vi.fn(),
  jidToE164: vi.fn(),
  sendMessage: vi.fn(),
  waitForWaConnection: vi.fn(),
}));

vi.mock("./session.js", () => ({
  createWaSocket: mocks.createWaSocket,
  waitForWaConnection: mocks.waitForWaConnection,
}));

vi.mock("./text-runtime.js", () => ({
  jidToE164: mocks.jidToE164,
}));

vi.mock("./inbound/send-api.js", () => ({
  createWebSendApi: () => ({
    sendMessage: mocks.sendMessage,
  }),
}));

function createMockSocket() {
  return {
    end: vi.fn(),
    ev: new EventEmitter(),
    ws: {
      close: vi.fn(),
    },
  };
}

function incomingMessage(remoteJid: string, text: string): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "message-1",
      remoteJid,
    },
    message: {
      conversation: text,
    },
  } as WAMessage;
}

describe("startWhatsAppQaDriverSession", () => {
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
    expect(session.getObservedMessages()).toMatchObject([
      {
        fromJid: "12345@lid",
        fromPhoneE164: "+15551234567",
        messageId: "message-1",
        text: "hello",
      },
    ]);

    await session.close();
  });

  it("clears the connection timeout after a successful connection", async () => {
    vi.useFakeTimers();
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockResolvedValue(undefined);

    const session = await startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
      connectionTimeoutMs: 45_000,
    });

    expect(vi.getTimerCount()).toBe(0);

    await session.close();
  });

  it("closes the socket and removes listeners when connection setup times out", async () => {
    vi.useFakeTimers();
    const sock = createMockSocket();
    mocks.createWaSocket.mockResolvedValue(sock);
    mocks.waitForWaConnection.mockReturnValue(new Promise(() => {}));

    const started = startWhatsAppQaDriverSession({
      authDir: "/tmp/openclaw-whatsapp-auth",
      connectionTimeoutMs: 10,
    });
    const rejection = started.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out waiting for WhatsApp QA driver session");
    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
