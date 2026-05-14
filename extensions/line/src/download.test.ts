import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMessageContentMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiBlobClient: class {
      getMessageContent(messageId: string) {
        return getMessageContentMock(messageId);
      }
    },
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    return logger;
  },
  logVerbose: () => {},
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream: saveMediaStreamMock,
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

function saveMediaStreamCall(): unknown[] {
  const call = saveMediaStreamMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveMediaStream call");
  }
  return call;
}

function detectMockContentType(buffer: Buffer, contentType?: string): string | undefined {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    return buffer.toString("ascii", 8, 12) === "M4A " ? "audio/x-m4a" : "video/mp4";
  }
  return contentType;
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia } = await import("./download.js"));
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/media-store");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getMessageContentMock.mockReset();
    saveMediaStreamMock.mockReset();
    saveMediaStreamMock.mockImplementation(
      async (stream: AsyncIterable<Buffer>, contentType?: string, subdir?: string) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        return {
          path: `/home/user/.openclaw/media/${subdir ?? "unknown"}/saved-media`,
          contentType: detectMockContentType(buffer, contentType),
          size: buffer.length,
        };
      },
    );
  });

  it("persists inbound media with the shared media store", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia("mid-jpeg", "token");

    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    const call = saveMediaStreamCall();
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(result).toEqual({
      path: "/home/user/.openclaw/media/inbound/saved-media",
      contentType: "image/jpeg",
      size: jpeg.length,
    });
  });

  it("does not pass the external messageId to saveMediaStream", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia(messageId, "token");

    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    for (const arg of saveMediaStreamCall()) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("delegates oversized media rejection to saveMediaStream", async () => {
    getMessageContentMock.mockResolvedValueOnce(chunks([Buffer.alloc(4), Buffer.alloc(4)]));
    saveMediaStreamMock.mockRejectedValueOnce(new Error("Media exceeds 0MB limit"));

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
  });

  it("uses media store content type for M4A media", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([m4aHeader]));

    const result = await downloadLineMedia("mid-audio", "token");

    expect(result.contentType).toBe("audio/x-m4a");
    expect(saveMediaStreamCall()[2]).toBe("inbound");
  });

  it("uses media store content type for MP4 video", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([mp4]));

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
  });

  it("propagates media store failures", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));
    saveMediaStreamMock.mockRejectedValueOnce(new Error("Media exceeds 0MB limit"));

    await expect(downloadLineMedia("mid-bad", "token")).rejects.toThrow(/Media exceeds/i);
  });
});
