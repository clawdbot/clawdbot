import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });
const saveMediaBufferSpy = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
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

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer: vi.fn(async (...args: Parameters<typeof actual.saveMediaBuffer>) => {
      saveMediaBufferSpy(...args);
      return actual.saveMediaBuffer(...args);
    }),
  };
});

const HOME = path.join(os.tmpdir(), `moltbot-inbound-media-${crypto.randomUUID()}`);
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
    downloadMediaMessage: vi.fn().mockResolvedValue(jpegBuffer),
  };
});

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
    user: { id: "me@s.whatsapp.net" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 200),
  };
});

import { monitorWebInbox, resetWebInboundDedupe } from "./inbound.js";

describe("web inbound media saves with extension", () => {
  beforeEach(() => {
    saveMediaBufferSpy.mockClear();
    resetWebInboundDedupe();
  });

  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  it("stores inbound image with jpeg extension", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const { createWaSocket } = await import("./session.js");
    const realSock = await (
      createWaSocket as unknown as () => Promise<{
        ev: import("node:events").EventEmitter;
      }>
    )();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "img1", fromMe: false, remoteJid: "111@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_001,
        },
      ],
    };

    realSock.ev.emit("messages.upsert", upsert);

    // Allow a brief window for the async handler to fire on slower hosts.
    for (let i = 0; i < 50; i++) {
      if (onMessage.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];
    const mediaPath = msg.mediaPath;
    expect(mediaPath).toBeDefined();
    expect(path.extname(mediaPath as string)).toBe(".jpg");
    const stat = await fs.stat(mediaPath as string);
    expect(stat.size).toBeGreaterThan(0);

    await listener.close();
  });

  it("extracts mentions from media captions", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const { createWaSocket } = await import("./session.js");
    const realSock = await (
      createWaSocket as unknown as () => Promise<{
        ev: import("node:events").EventEmitter;
      }>
    )();

    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "img2",
            fromMe: false,
            remoteJid: "123@g.us",
            participant: "999@s.whatsapp.net",
          },
          message: {
            messageContextInfo: {},
            imageMessage: {
              caption: "@bot",
              contextInfo: { mentionedJid: ["999@s.whatsapp.net"] },
              mimetype: "image/jpeg",
            },
          },
          messageTimestamp: 1_700_000_002,
        },
      ],
    };

    realSock.ev.emit("messages.upsert", upsert);

    for (let i = 0; i < 50; i++) {
      if (onMessage.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];
    expect(msg.chatType).toBe("group");
    expect(msg.mentionedJids).toEqual(["999@s.whatsapp.net"]);

    await listener.close();
  });

  it("passes mediaMaxMb to saveMediaBuffer", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage,
      mediaMaxMb: 1,
    });
    const { createWaSocket } = await import("./session.js");
    const realSock = await (
      createWaSocket as unknown as () => Promise<{
        ev: import("node:events").EventEmitter;
      }>
    )();

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

    for (let i = 0; i < 50; i++) {
      if (onMessage.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(saveMediaBufferSpy).toHaveBeenCalled();
    const lastCall = saveMediaBufferSpy.mock.calls.at(-1);
    expect(lastCall?.[3]).toBe(1 * 1024 * 1024);

    await listener.close();
  });
});
