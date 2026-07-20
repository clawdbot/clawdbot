// Whatsapp tests cover inbound.media plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockIsJidGroup,
  mockNormalizeMessageContent,
} from "../../../test/mocks/baileys.js";
import { lookupInboundMessageMeta } from "./quoted-message.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];
type InMemoryKeyedStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

function createInMemoryKeyedStore<T>() {
  const entries = new Map<string, InMemoryKeyedStoreEntry<T>>();
  return {
    async register(key: string, value: T, opts?: { ttlMs?: number }) {
      const createdAt = Date.now();
      entries.set(key, {
        key,
        value,
        createdAt,
        ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
      });
    },
    async registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }) {
      if (entries.has(key)) {
        return false;
      }
      const createdAt = Date.now();
      entries.set(key, {
        key,
        value,
        createdAt,
        ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
      });
      return true;
    },
    async lookup(key: string) {
      return entries.get(key)?.value;
    },
    async consume(key: string) {
      const value = entries.get(key)?.value;
      entries.delete(key);
      return value;
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return Array.from(entries.values());
    },
    async clear() {
      entries.clear();
    },
  };
}

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });
const saveMediaStreamSpy = vi.fn();
const downloadMediaMessageMock = vi.hoisted(() => vi.fn());
let currentMockSocket:
  | {
      ev: import("node:events").EventEmitter;
      ws: { close: ReturnType<typeof vi.fn> };
      sendPresenceUpdate: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
      readMessages: ReturnType<typeof vi.fn>;
      groupFetchAllParticipating: ReturnType<typeof vi.fn>;
      updateMediaMessage: ReturnType<typeof vi.fn>;
      logger: Record<string, never>;
      user: { id: string };
    }
  | undefined;

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: vi.fn().mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["*"], // Allow all in tests
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    }),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore(...args: unknown[]) {
      return readAllowFromStoreMock(...args);
    },
    upsertChannelPairingRequest(...args: unknown[]) {
      return upsertPairingRequestMock(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/channel-pairing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-pairing")>(
    "openclaw/plugin-sdk/channel-pairing",
  );
  return {
    ...actual,
    readChannelAllowFromStore(...args: unknown[]) {
      return readAllowFromStoreMock(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/media-store", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-store")>(
    "openclaw/plugin-sdk/media-store",
  );
  return {
    ...actual,
    saveMediaStream: vi.fn(async (...args: Parameters<typeof actual.saveMediaStream>) => {
      saveMediaStreamSpy(...args);
      return actual.saveMediaStream(...args);
    }),
  };
});

vi.mock("./runtime.js", async () => {
  const { createChannelIngressQueueForTests: createChannelIngressQueue } = await Promise.resolve(
    vi.importActual<typeof import("openclaw/plugin-sdk/plugin-state-test-runtime")>(
      "openclaw/plugin-sdk/plugin-state-test-runtime",
    ),
  );
  const stateDir = `/tmp/openclaw-whatsapp-inbound-media-${Date.now()}-${Math.random()}`;
  return {
    getOptionalWhatsAppRuntime: () => undefined,
    getWhatsAppRuntime: () => ({
      state: {
        resolveStateDir: () => stateDir,
        openKeyedStore: () => createInMemoryKeyedStore(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => createChannelIngressQueue({ ...options, channelId: "whatsapp" }),
      },
    }),
    setWhatsAppRuntime: vi.fn(),
  };
});

const HOME = path.join(os.tmpdir(), `openclaw-inbound-media-${crypto.randomUUID()}`);
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = HOME;

vi.mock("baileys", async () => {
  const actual = await vi.importActual<typeof import("baileys")>("baileys");
  const { Readable } = require("node:stream") as typeof import("node:stream");
  const jpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02,
    0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06, 0x06, 0x05,
    0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a, 0x0c, 0x0f, 0x0c, 0x0a, 0x0b, 0x0e,
    0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d, 0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c, 0x12, 0x13,
    0x12, 0x10, 0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
    0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
  return {
    ...actual,
    DisconnectReason: actual.DisconnectReason ?? { loggedOut: 401 },
    downloadMediaMessage: downloadMediaMessageMock.mockImplementation(() =>
      Readable.from([jpegBuffer]),
    ),
    extractMessageContent: vi.fn((message: MockMessageInput) => mockExtractMessageContent(message)),
    getContentType: vi.fn((message: MockMessageInput) => mockGetContentType(message)),
    isJidGroup: vi.fn((jid: string | undefined | null) => mockIsJidGroup(jid)),
    normalizeMessageContent: vi.fn((message: MockMessageInput) =>
      mockNormalizeMessageContent(message),
    ),
  };
});

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const { EventEmitter } = require("node:events");
  return {
    ...actual,
    createWaSocket: vi.fn().mockImplementation(async () => {
      currentMockSocket ??= {
        ev: new EventEmitter(),
        ws: { close: vi.fn() },
        sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        readMessages: vi.fn().mockResolvedValue(undefined),
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
        updateMediaMessage: vi.fn(),
        logger: {},
        user: { id: "me@s.whatsapp.net" },
      };
      return currentMockSocket;
    }),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 200),
  };
});

let monitorWebInbox: typeof import("./inbound.js").monitorWebInbox;
let resetWebInboundDedupe: typeof import("./inbound.js").resetWebInboundDedupe;
let createWaSocket: typeof import("./session.js").createWaSocket;

async function waitForMessage(onMessage: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1), {
    interval: 1,
    timeout: 2_000,
  });
  return onMessage.mock.calls[0]?.[0];
}

function latestSaveMediaStreamCall() {
  const call = saveMediaStreamSpy.mock.calls[saveMediaStreamSpy.mock.calls.length - 1];
  if (!call) {
    throw new Error("expected saveMediaStream call");
  }
  return call;
}

function requireMediaPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("expected inbound media path");
  }
  return value;
}

describe("web inbound media saves with extension", () => {
  async function getMockSocket() {
    return (await createWaSocket(false, false)) as unknown as {
      ev: import("node:events").EventEmitter;
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    currentMockSocket = undefined;
    downloadMediaMessageMock.mockClear();
    saveMediaStreamSpy.mockClear();
    resetWebInboundDedupe();
  });

  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    ({ monitorWebInbox, resetWebInboundDedupe } = await import("./inbound.js"));
    ({ createWaSocket } = await import("./session.js"));
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("stores image extension and keeps document filename", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
        messages: { responsePrefix: undefined },
      } as never,
      verbose: false,
      onMessage,
      accountId: "default",
      authDir: path.join(HOME, "wa-auth"),
    });
    const realSock = await getMockSocket();

    realSock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "img1", fromMe: false, remoteJid: "111@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_001,
        },
      ],
    });

    const first = await waitForMessage(onMessage);
    const mediaPath = requireMediaPath(first.payload.media?.path);
    expect(path.extname(mediaPath)).toBe(".jpg");
    const stat = await fs.stat(mediaPath);
    expect(stat.size).toBeGreaterThan(0);

    onMessage.mockClear();
    const fileName = "invoice.pdf";
    realSock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "doc1", fromMe: false, remoteJid: "333@s.whatsapp.net" },
          message: { documentMessage: { mimetype: "application/pdf", fileName } },
          messageTimestamp: 1_700_000_004,
        },
      ],
    });

    const second = await waitForMessage(onMessage);
    expect(second.payload.media?.fileName).toBe(fileName);
    expect(saveMediaStreamSpy).toHaveBeenCalled();
    const lastCall = latestSaveMediaStreamCall();
    expect(lastCall[4]).toBe(fileName);

    await listener.close();
  });

  it("stores quoted image media from reply context", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
        messages: { responsePrefix: undefined },
      } as never,
      verbose: false,
      onMessage,
      accountId: "default",
      authDir: path.join(HOME, "wa-auth"),
    });
    const realSock = await getMockSocket();

    realSock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "quote-img-reply", fromMe: false, remoteJid: "111@g.us" },
          message: {
            extendedTextMessage: {
              text: "@bot what is this?",
              contextInfo: {
                stanzaId: "quoted-image",
                participant: "222@s.whatsapp.net",
                mentionedJid: ["me@s.whatsapp.net"],
                quotedMessage: {
                  imageMessage: { mimetype: "image/jpeg" },
                },
              },
            },
          },
          messageTimestamp: 1_700_000_005,
        },
      ],
    });

    const inbound = await waitForMessage(onMessage);
    expect(inbound.quote?.body).toBe("");
    expect(inbound.quote?.media).toEqual({ contentType: "image/jpeg", kind: "image" });
    const mediaPath = requireMediaPath(inbound.payload.media?.path);
    expect(path.extname(mediaPath)).toBe(".jpg");
    expect(saveMediaStreamSpy).toHaveBeenCalled();
    const lastCall = latestSaveMediaStreamCall();
    expect(lastCall[1]).toBe("image/jpeg");
    expect(
      lookupInboundMessageMeta("default", "111@g.us", "quote-img-reply")?.media,
    ).toBeUndefined();

    await listener.close();
  });

  it("passes mediaMaxMb to saveMediaStream", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
        messages: { responsePrefix: undefined },
      } as never,
      verbose: false,
      onMessage,
      mediaMaxMb: 1,
      accountId: "default",
      authDir: path.join(HOME, "wa-auth"),
    });
    const realSock = await getMockSocket();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "img3", fromMe: false, remoteJid: "222@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_003,
        },
      ],
    };

    realSock.ev.emit("messages.upsert", upsert);

    await waitForMessage(onMessage);
    expect(saveMediaStreamSpy).toHaveBeenCalled();
    const lastCall = latestSaveMediaStreamCall();
    expect(lastCall[3]).toBe(1 * 1024 * 1024);

    await listener.close();
  });

  it("keeps a failed image fact with an unavailable notice", async () => {
    downloadMediaMessageMock.mockRejectedValueOnce(new Error("expired media reference"));
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
        messages: { responsePrefix: undefined },
      } as never,
      verbose: false,
      onMessage,
      accountId: "default",
      authDir: path.join(HOME, "wa-auth"),
    });
    const realSock = await getMockSocket();

    realSock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "img-failed", fromMe: false, remoteJid: "111@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_006,
        },
      ],
    });

    const inbound = await waitForMessage(onMessage);
    expect(inbound.payload.body).toBe("[whatsapp attachment unavailable]");
    expect(inbound.payload.commandBody).toBe("");
    expect(inbound.payload.media).toEqual({
      path: undefined,
      type: "image/jpeg",
      fileName: undefined,
      kind: "image",
    });
    expect(inbound.payload.untrustedStructuredContext).toContainEqual({
      label: "WhatsApp media",
      source: "whatsapp",
      type: "media",
      payload: { contentType: "image/jpeg", kind: "image" },
    });

    await listener.close();
  });
});
