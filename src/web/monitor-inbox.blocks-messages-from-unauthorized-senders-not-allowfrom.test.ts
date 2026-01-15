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
    authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "clawdbot-auth-"));
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    fsSync.rmSync(authDir, { recursive: true, force: true });
  });

  it("blocks messages from unauthorized senders not in allowFrom", async () => {
    // Test for auto-recovery fix: early allowFrom filtering prevents Bad MAC errors
    // from unauthorized senders corrupting sessions
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Only allow +111
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
      text: expect.stringContaining("Your WhatsApp phone number: +999"),
    });
    expect(sock.sendMessage).toHaveBeenCalledWith("999@s.whatsapp.net", {
      text: expect.stringContaining("Pairing code: PAIRCODE"),
    });

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

  it("skips read receipts in self-chat mode", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // Self-chat heuristic: allowFrom includes selfE164 (+123).
          allowFrom: ["+123"],
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
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    await listener.close();
  });

  it("skips read receipts when disabled", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      sendReadReceipts: false,
    });
    const sock = await createWaSocket();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "rr-off-1", fromMe: false, remoteJid: "222@s.whatsapp.net" },
          message: { conversation: "read receipts off" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("lets group messages through even when sender not in allowFrom", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "open" } },
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
      channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "disabled" } },
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
      channels: {
        whatsapp: {
          groupAllowFrom: ["+1234"], // Does not include +999
          groupPolicy: "allowlist",
        },
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
      channels: {
        whatsapp: {
          groupAllowFrom: ["+15551234567"], // Includes the sender
          groupPolicy: "allowlist",
        },
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
      channels: {
        whatsapp: {
          groupAllowFrom: ["*"], // Wildcard allows everyone
          groupPolicy: "allowlist",
        },
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
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
        },
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
});
