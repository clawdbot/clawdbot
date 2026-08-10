// Whatsapp tests cover message-enrichment plugin behavior.
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
  downloadMediaMessage: vi.fn(),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", async () => ({
  DisconnectReason: { loggedOut: 401 },
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
  downloadMediaMessage,
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream,
}));

let enrichWhatsAppInboundMessage: typeof import("./message-enrichment.js").enrichWhatsAppInboundMessage;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
  user: { id: "15559876543:7@s.whatsapp.net" },
};

function audioMessage() {
  return {
    key: { remoteJid: "15550001111@s.whatsapp.net", id: "audio-1", fromMe: false },
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
  } as never;
}

describe("enrichWhatsAppInboundMessage", () => {
  beforeAll(async () => {
    ({ enrichWhatsAppInboundMessage } = await import("./message-enrichment.js"));
  });

  beforeEach(() => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockReset();
    saveMediaStream.mockReset();
    saveMediaStream.mockImplementation(
      async (
        stream: AsyncIterable<Buffer>,
        contentType: string | undefined,
        _subdir: string,
        _maxBytes: number,
      ) => {
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
        }
        return { id: "saved-media", path: "/tmp/saved-media", size: total, contentType };
      },
    );
    mockSock.updateMediaMessage.mockClear();
  });

  it("rejects instead of degrading a transient (HTTP 429) media download failure", async () => {
    const boom = Object.assign(new Error("rate limited"), {
      isBoom: true,
      output: { statusCode: 429 },
    });
    downloadMediaMessage.mockRejectedValueOnce(boom);

    await expect(
      enrichWhatsAppInboundMessage({
        msg: audioMessage(),
        sock: mockSock as never,
        logVerbose: () => {},
      }),
    ).rejects.toBe(boom);
  });

  it("degrades a permanent (HTTP 400) media download failure to the unavailable notice", async () => {
    const boom = Object.assign(new Error("bad request"), {
      isBoom: true,
      output: { statusCode: 400 },
    });
    downloadMediaMessage.mockRejectedValueOnce(boom);

    const result = await enrichWhatsAppInboundMessage({
      msg: audioMessage(),
      sock: mockSock as never,
      logVerbose: () => {},
    });

    expect(result?.body).toBe("[whatsapp attachment unavailable]");
    expect(result?.mediaPath).toBeUndefined();
  });

  it("delivers the attachment on a successful download", async () => {
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("fake-media-data"));
    saveMediaStream.mockResolvedValueOnce({
      id: "saved-media",
      path: "/tmp/saved-media",
      size: 4,
      contentType: "audio/ogg; codecs=opus",
    });

    const result = await enrichWhatsAppInboundMessage({
      msg: audioMessage(),
      sock: mockSock as never,
      logVerbose: () => {},
    });

    expect(result?.mediaPath).toBe("/tmp/saved-media");
    expect(result?.body).not.toContain("unavailable");
  });
});
