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

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });
const saveMediaBufferSpy = vi.fn();
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

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
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

vi.mock("../../../src/pairing/pairing-store.js", () => {
  return {
    readChannelAllowFromStore(...args: unknown[]) {
      return readAllowFromStoreMock(...args);
    },
    upsertChannelPairingRequest(...args: unknown[]) {
      return upsertPairingRequestMock(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    saveMediaBuffer: vi.fn(async (...args: Parameters<typeof actual.saveMediaBuffer>) => {
      saveMediaBufferSpy(...args);
      return actual.saveMediaBuffer(...args);
    }),
  };
});

const HOME = path.join(os.tmpdir(), `openclaw-inbound-media-${crypto.randomUUID()}`);
process.env.HOME = HOME;

vi.mock("@whiskeysockets/baileys", async () => {
  const actual =
    await vi.importActual<typeof import("@whiskeysockets/baileys")>("@whiskeysockets/baileys");
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
    downloadMediaMessage: vi.fn().mockResolvedValue(jpegBuffer),
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
    timeout: 250,
  });
  return onMessage.mock.calls[0][0];
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
    saveMediaBufferSpy.mockClear();
    resetWebInboundDedupe();
  });

  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    ({ monitorWebInbox, resetWebInboundDedupe } = await import("./inbound.js"));
    ({ createWaSocket } = await import("./session.js"));
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  it("stores image extension and keeps document filename", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
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
    const mediaPath = first.mediaPath;
    expect(mediaPath).toBeDefined();
    expect(path.extname(mediaPath as string)).toBe(".jpg");
    const stat = await fs.stat(mediaPath as string);
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
    expect(second.mediaFileName).toBe(fileName);
    expect(saveMediaBufferSpy).toHaveBeenCalled();
    const lastCall = saveMediaBufferSpy.mock.calls.at(-1);
    expect(lastCall?.[4]).toBe(fileName);

    await listener.close();
  });

  it("passes mediaMaxMb to saveMediaBuffer", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
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
    expect(saveMediaBufferSpy).toHaveBeenCalled();
    const lastCall = saveMediaBufferSpy.mock.calls.at(-1);
    expect(lastCall?.[3]).toBe(1 * 1024 * 1024);

    await listener.close();
  });
});
