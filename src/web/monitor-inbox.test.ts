import { vi } from "vitest";

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockResolvedValue({
    id: "mid",
    path: "/tmp/mid",
    size: 1,
    contentType: "image/jpeg",
  }),
}));

const mockLoadConfig = vi.fn().mockReturnValue({
  inbound: {
    allowFrom: ["*"], // Allow all in tests
    messagePrefix: undefined,
    responsePrefix: undefined,
    timestampPrefix: false,
  },
});

vi.mock("../config/config.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    user: { id: "123@s.whatsapp.net" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
  };
});

const { createWaSocket } = await import("./session.js");
const _getSock = () =>
  (createWaSocket as unknown as () => Promise<ReturnType<typeof mockSock>>)();

import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebInbox } from "./inbound.js";

describe("web monitor inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("streams inbound messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.sendComposing();
      await msg.reply("pong");
    });

    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: "abc",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith(
      "composing",
      "999@s.whatsapp.net",
    );
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  });

  it("captures media path for image messages", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "med1", fromMe: false, remoteJid: "888@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_100,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "<media:image>",
      }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "888@s.whatsapp.net",
        id: "med1",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    await listener.close();
  });

  it("resolves onClose when the socket closes", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
    });
    const sock = await createWaSocket();
    const reasonPromise = listener.onClose;
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await expect(reasonPromise).resolves.toEqual(
      expect.objectContaining({ status: 500, isLoggedOut: false }),
    );
    await listener.close();
  });

  it("logs inbound bodies to file", async () => {
    const logPath = path.join(
      os.tmpdir(),
      `warelay-log-test-${crypto.randomUUID()}.log`,
    );
    setLoggerOverride({ level: "trace", file: logPath });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    const content = fsSync.readFileSync(logPath, "utf-8");
    expect(content).toContain('"module":"web-inbound"');
    expect(content).toContain('"body":"ping"');
    await listener.close();
  });

  it("includes participant when marking group messages read", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp1",
            fromMe: false,
            remoteJid: "12345-67890@g.us",
            participant: "111@s.whatsapp.net",
          },
          message: { conversation: "group ping" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "12345-67890@g.us",
        id: "grp1",
        participant: "111@s.whatsapp.net",
        fromMe: false,
      },
    ]);
    await listener.close();
  });

  it("blocks messages from unauthorized senders not in allowFrom", async () => {
    // Test for auto-recovery fix: early allowFrom filtering prevents Bad MAC errors
    // from unauthorized senders corrupting sessions
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["+111"], // Only allow +111
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    // Message from unauthorized sender +999 (not in allowFrom)
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "unauth1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "unauthorized message" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage for unauthorized senders
    expect(onMessage).not.toHaveBeenCalled();

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    await listener.close();
  });

  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["+111", "+999"], // Allow +999
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "auth1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "authorized message" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage for authorized senders
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "authorized message", from: "+999" }),
    );

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    await listener.close();
  });

  it("allows same-phone messages even if not in allowFrom", async () => {
    // Same-phone mode: when from === selfJid, should always be allowed
    // This allows users to message themselves even with restrictive allowFrom
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["+111"], // Only allow +111, but self is +123
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    // Message from self (sock.user.id is "123@s.whatsapp.net" in mock)
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "self1", fromMe: false, remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "self message" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should allow self-messages even if not in allowFrom
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "self message", from: "+123" }),
    );

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: undefined,
        timestampPrefix: false,
      },
    });

    await listener.close();
  });
});
