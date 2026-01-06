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
  whatsapp: {
    allowFrom: ["*"], // Allow all in tests by default
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
});

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi
  .fn()
  .mockResolvedValue({ code: "PAIRCODE", created: true });

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readProviderAllowFromStore: (...args: unknown[]) =>
    readAllowFromStoreMock(...args),
  upsertProviderPairingRequest: (...args: unknown[]) =>
    upsertPairingRequestMock(...args),
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
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
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

  it("does not block follow-up messages when handler is pending", async () => {
    let resolveFirst: (() => void) | null = null;
    const onMessage = vi.fn(async () => {
      if (!resolveFirst) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
        {
          key: { id: "abc2", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(2);

    resolveFirst?.();
    await listener.close();
  });

  it("captures reply context from quoted messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("pong");
    });

    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: {
            extendedTextMessage: {
              text: "reply",
              contextInfo: {
                stanzaId: "q1",
                participant: "111@s.whatsapp.net",
                quotedMessage: { conversation: "original" },
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+111",
      }),
    );
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: "pong",
    });

    await listener.close();
  });

  it("captures reply context from wrapped quoted messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.reply("pong");
    });

    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: {
            extendedTextMessage: {
              text: "reply",
              contextInfo: {
                stanzaId: "q1",
                participant: "111@s.whatsapp.net",
                quotedMessage: {
                  viewOnceMessageV2Extension: {
                    message: { conversation: "original" },
                  },
                },
              },
            },
          },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+111",
      }),
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
    const logPath = path.join(
      os.tmpdir(),
      `clawdbot-log-test-${crypto.randomUUID()}.log`,
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
      whatsapp: {
        allowFrom: ["+111"], // does not include +777
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

  it("blocks messages from unauthorized senders not in allowFrom", async () => {
    // Test for auto-recovery fix: early allowFrom filtering prevents Bad MAC errors
    // from unauthorized senders corrupting sessions
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["+111"], // Only allow +111
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
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
          key: {
            id: "unauth1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized message" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage for unauthorized senders
    expect(onMessage).not.toHaveBeenCalled();
    // Should NOT send read receipts for blocked senders (privacy + avoids Baileys Bad MAC churn).
    expect(sock.readMessages).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Pairing code: PAIRCODE"),
    });

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("skips read receipts in self-chat mode", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        // Self-chat heuristic: allowFrom includes selfE164 (+123).
        allowFrom: ["+123"],
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
          key: { id: "self1", fromMe: false, remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "self ping" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+123", to: "+123", body: "self ping" }),
    );
    expect(sock.readMessages).not.toHaveBeenCalled();

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("lets group messages through even when sender not in allowFrom", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["+1234"],
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
            id: "grp3",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized group message" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+999");

    await listener.close();
  });

  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["+1234"],
        groupPolicy: "disabled",
      },
      messages: {
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
          key: {
            id: "grp-disabled",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "group message should be blocked" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage because groupPolicy is disabled
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("blocks group messages from senders not in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        groupAllowFrom: ["+1234"], // Does not include +999
        groupPolicy: "allowlist",
      },
      messages: {
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
          key: {
            id: "grp-allowlist-blocked",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "unauthorized group sender" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should NOT call onMessage because sender +999 not in groupAllowFrom
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("allows group messages from senders in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        groupAllowFrom: ["+15551234567"], // Includes the sender
        groupPolicy: "allowlist",
      },
      messages: {
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
          key: {
            id: "grp-allowlist-allowed",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "15551234567@s.whatsapp.net",
          },
          message: { conversation: "authorized group sender" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage because sender is in groupAllowFrom
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+15551234567");

    await listener.close();
  });

  it("allows all group senders with wildcard in groupPolicy allowlist", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        groupAllowFrom: ["*"], // Wildcard allows everyone
        groupPolicy: "allowlist",
      },
      messages: {
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
          key: {
            id: "grp-wildcard-test",
            fromMe: false,
            remoteJid: "22222@g.us",
            participant: "9999999999@s.whatsapp.net", // Random sender
          },
          message: { conversation: "wildcard group sender" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Should call onMessage because wildcard allows all senders
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");

    await listener.close();
  });

  it("blocks group messages when groupPolicy allowlist has no groupAllowFrom", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        groupPolicy: "allowlist",
      },
      messages: {
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
          key: {
            id: "grp-allowlist-empty",
            fromMe: false,
            remoteJid: "11111@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: { conversation: "blocked by empty allowlist" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["+111", "+999"], // Allow +999
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
      expect.objectContaining({
        body: "authorized message",
        from: "+999",
        senderE164: "+999",
      }),
    );

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("allows same-phone messages even if not in allowFrom", async () => {
    // Same-phone mode: when from === selfJid, should always be allowed
    // This allows users to message themselves even with restrictive allowFrom
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["+111"], // Only allow +111, but self is +123
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
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
      routing: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("locks down when no config is present (pairing for unknown senders)", async () => {
    // No config file => locked-down defaults apply (pairing for unknown senders)
    mockLoadConfig.mockReturnValue({});

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    // Message from someone else should be blocked
    const upsertBlocked = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertBlocked);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Pairing code: PAIRCODE"),
    });

    // Message from self should be allowed
    const upsertSelf = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-2",
            fromMe: false,
            remoteJid: "123@s.whatsapp.net",
          },
          message: { conversation: "self ping" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertSelf);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "self ping",
        from: "+123",
        to: "+123",
      }),
    );

    // Reset mock for other tests
    mockLoadConfig.mockReturnValue({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("handles append messages by marking them read but skipping auto-reply", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    const upsert = {
      type: "append",
      messages: [
        {
          key: {
            id: "history1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "old message" },
          messageTimestamp: 1_700_000_000,
          pushName: "History Sender",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    // Verify it WAS marked as read
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: "history1",
        participant: undefined,
        fromMe: false,
      },
    ]);

    // Verify it WAS NOT passed to onMessage
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });
});
