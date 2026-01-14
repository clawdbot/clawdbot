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
  readChannelAllowFromStore: (...args: unknown[]) =>
    readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) =>
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
const _getSock = () =>
  (createWaSocket as unknown as () => Promise<ReturnType<typeof mockSock>>)();

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebInbox, resetWebInboundDedupe } from "./inbound.js";

const ACCOUNT_ID = "default";
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
    authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    fsSync.rmSync(authDir, { recursive: true, force: true });
  });

  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Allow +999
          allowFrom: ["+111", "+999"],
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
      channels: { whatsapp: { allowFrom: ["*"] } },
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
      channels: {
        whatsapp: {
          // Only allow +111, but self is +123
          allowFrom: ["+111"],
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
      channels: { whatsapp: { allowFrom: ["*"] } },
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
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

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
      text: expect.stringContaining("Your WhatsApp phone number: +999"),
    });
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Pairing code: PAIRCODE"),
    });

    const upsertBlockedAgain = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1b",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "ping again" },
          messageTimestamp: 1_700_000_002,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsertBlockedAgain);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);

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
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("skips pairing replies for outbound DMs in same-phone mode", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          selfChatMode: true,
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
            id: "fromme-1",
            fromMe: true,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "hello" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();

    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("skips pairing replies for outbound DMs when same-phone mode is disabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          selfChatMode: false,
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
            id: "fromme-2",
            fromMe: true,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "hello again" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();

    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
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

  it("normalizes participant phone numbers to JIDs in sendReaction", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
      accountId: ACCOUNT_ID,
      authDir,
    });
    const sock = await createWaSocket();

    await listener.sendReaction(
      "12345@g.us",
      "msg123",
      "👍",
      false,
      "+6421000000",
    );

    expect(sock.sendMessage).toHaveBeenCalledWith("12345@g.us", {
      react: {
        text: "👍",
        key: {
          remoteJid: "12345@g.us",
          id: "msg123",
          fromMe: false,
          participant: "6421000000@s.whatsapp.net",
        },
      },
    });

    await listener.close();
  });
});
