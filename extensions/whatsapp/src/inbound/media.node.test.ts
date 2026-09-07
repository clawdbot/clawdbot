// Whatsapp tests cover media plugin behavior.
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockNormalizeMessageContent,
} from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const {
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
  downloadMediaMessage,
  saveMediaStream,
} = vi.hoisted(() => ({
  extractMessageContent: vi.fn((msg: MockMessageInput) => mockExtractMessageContent(msg)),
  getContentType: vi.fn((msg: MockMessageInput) => mockGetContentType(msg)),
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("fake-media-data")),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", async () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    extractMessageContent,
    getContentType,
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream,
}));

let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;
let downloadQuotedInboundMedia: typeof import("./media.js").downloadQuotedInboundMedia;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
  user: {
    id: "15559876543:7@s.whatsapp.net",
    lid: "277038292303944@lid",
    phoneNumber: "15559876543@s.whatsapp.net",
  },
};

async function expectMimetype(message: Record<string, unknown>, expected: string) {
  const result = await downloadInboundMedia({ message } as never, mockSock as never);
  expect(result).toEqual({
    saved: {
      id: "saved-media",
      path: "/tmp/saved-media",
      size: Buffer.byteLength("fake-media-data"),
      contentType: expected,
    },
    mimetype: expected,
    fileName: undefined,
  });
}

describe("downloadInboundMedia", () => {
  beforeAll(async () => {
    ({ downloadInboundMedia, downloadQuotedInboundMedia } = await import("./media.js"));
  });

  beforeEach(() => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
    downloadMediaMessage.mockImplementation(() => Readable.from([Buffer.from("fake-media-data")]));
    saveMediaStream.mockClear();
    saveMediaStream.mockImplementation(
      async (
        stream: AsyncIterable<Buffer>,
        contentType: string | undefined,
        _subdir: string,
        maxBytes: number,
      ) => {
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new Error("Media exceeds limit");
          }
        }
        return { id: "saved-media", path: "/tmp/saved-media", size: total, contentType };
      },
    );
    mockSock.updateMediaMessage.mockClear();
  });

  it("returns undefined for messages without media", async () => {
    const msg = { message: { conversation: "hello" } } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toBeUndefined();
  });

  it("uses explicit mimetype from audioMessage when present", async () => {
    await expectMimetype({ audioMessage: { mimetype: "audio/mp4", ptt: true } }, "audio/mp4");
  });

  it.each([
    { name: "voice messages without explicit MIME", audioMessage: { ptt: true } },
    { name: "audio messages without MIME or ptt flag", audioMessage: {} },
  ])("defaults to audio/ogg for $name", async ({ audioMessage }) => {
    await expectMimetype({ audioMessage }, "audio/ogg; codecs=opus");
  });

  it("uses explicit mimetype from imageMessage when present", async () => {
    await expectMimetype({ imageMessage: { mimetype: "image/png" } }, "image/png");
  });

  it.each([
    { name: "image", message: { imageMessage: {} }, mimetype: "image/jpeg" },
    { name: "video", message: { videoMessage: {} }, mimetype: "video/mp4" },
    { name: "video note", message: { ptvMessage: {} }, mimetype: "video/mp4" },
    { name: "sticker", message: { stickerMessage: {} }, mimetype: "image/webp" },
  ])("defaults MIME for $name messages without explicit MIME", async ({ message, mimetype }) => {
    await expectMimetype(message, mimetype);
  });

  it("preserves fileName from document messages", async () => {
    const msg = {
      message: {
        documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" },
      },
    } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toEqual({
      saved: {
        id: "saved-media",
        path: "/tmp/saved-media",
        size: Buffer.byteLength("fake-media-data"),
        contentType: "application/pdf",
      },
      mimetype: "application/pdf",
      fileName: "report.pdf",
    });
  });

  it("downloads in stream mode and rejects over the configured cap", async () => {
    downloadMediaMessage.mockImplementationOnce(() =>
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
    );

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        7,
      ),
    ).rejects.toThrow(/Media exceeds/i);
    expect(downloadMediaMessage.mock.calls[0]?.[1]).toBe("stream");
  });

  it("preserves the store's fractional limit error for the message owner", async () => {
    const limitError = Object.assign(new Error("Media exceeds 256KB limit"), { code: "too-large" });
    saveMediaStream.mockRejectedValueOnce(limitError);

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        0.25 * 1024 * 1024,
      ),
    ).rejects.toBe(limitError);
  });

  it("propagates transport download failures to the message owner", async () => {
    downloadMediaMessage.mockRejectedValueOnce(new Error("expired media reference"));

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
      ),
    ).rejects.toThrow("expired media reference");
  });

  it.each([
    {
      name: "the bot's device-scoped phone identity",
      participant: "15559876543@s.whatsapp.net",
      expectedFromMe: true,
    },
    {
      name: "the bot's LID identity",
      participant: "277038292303944@lid",
      expectedFromMe: true,
    },
    {
      name: "another sender",
      participant: "15550000000@s.whatsapp.net",
      expectedFromMe: false,
    },
  ])("preserves quoted media authorship for $name", async ({ participant, expectedFromMe }) => {
    await downloadQuotedInboundMedia(
      {
        key: { remoteJid: "120363000000000000@g.us", id: "reply-1", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "inspect this",
            contextInfo: {
              stanzaId: "quoted-image",
              participant,
              quotedMessage: { imageMessage: { mimetype: "image/jpeg" } },
            },
          },
        },
      } as never,
      mockSock as never,
    );

    const quotedMessage = downloadMediaMessage.mock.calls[0]?.[0] as
      | { key?: { fromMe?: boolean; id?: string; participant?: string } }
      | undefined;
    expect(quotedMessage?.key).toMatchObject({
      fromMe: expectedFromMe,
      id: "quoted-image",
      participant,
    });
  });
});
