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
  channels: {
    whatsapp: {
      // Allow all in tests by default
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
});

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
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
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
  };
});

const { createWaSocket } = await import("./session.js");
const _getSock = () => (createWaSocket as unknown as () => Promise<ReturnType<typeof mockSock>>)();

import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebInbox, resetWebInboundDedupe } from "./inbound.js";

const _ACCOUNT_ID = "default";
let authDir: string;

describe("web monitor inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
    resetWebInboundDedupe();
    authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "moltbot-auth-"));
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    fsSync.rmSync(authDir, { recursive: true, force: true });
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

  it("sets gifPlayback on outbound video payloads when requested", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const buf = Buffer.from("gifvid");

    await listener.sendMessage("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });

    expect(sock.sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      video: buf,
      caption: "gif",
      mimetype: "video/mp4",
      gifPlayback: true,
    });

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
    const logPath = path.join(os.tmpdir(), `moltbot-log-test-${crypto.randomUUID()}.log`);
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
    expect(content).toMatch(/web-inbound/);
    expect(content).toMatch(/ping/);
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

  it("passes through group messages with participant metadata", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp2",
            fromMe: false,
            remoteJid: "99999@g.us",
            participant: "777@s.whatsapp.net",
          },
          pushName: "Alice",
          message: {
            extendedTextMessage: {
              text: "@bot ping",
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
            },
          },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        conversationId: "99999@g.us",
        senderE164: "+777",
        mentionedJids: ["123@s.whatsapp.net"],
      }),
    );
    await listener.close();
  });

  it("unwraps ephemeral messages, preserves mentions, and still delivers group pings", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-ephem",
            fromMe: false,
            remoteJid: "424242@g.us",
            participant: "888@s.whatsapp.net",
          },
          message: {
            ephemeralMessage: {
              message: {
                extendedTextMessage: {
                  text: "oh hey @Clawd UK !",
                  contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
                },
              },
            },
          },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        conversationId: "424242@g.us",
        body: "oh hey @Clawd UK !",
        mentionedJids: ["123@s.whatsapp.net"],
        senderE164: "+888",
      }),
    );

    await listener.close();
  });

  it("still forwards group messages (with sender info) even when allowFrom is restrictive", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // does not include +777
          allowFrom: ["+111"],
          groupPolicy: "open",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allow",
            fromMe: false,
            remoteJid: "55555@g.us",
            participant: "777@s.whatsapp.net",
          },
          message: {
            extendedTextMessage: {
              text: "@bot hi",
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
            },
          },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        from: "55555@g.us",
        senderE164: "+777",
        senderJid: "777@s.whatsapp.net",
        mentionedJids: ["123@s.whatsapp.net"],
        selfE164: "+123",
        selfJid: "123@s.whatsapp.net",
      }),
    );

    await listener.close();
  });
});
