import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMessageContentMock = vi.hoisted(() => vi.fn());
const saveMediaBufferMock = vi.hoisted(() => vi.fn());

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
  saveMediaBuffer: saveMediaBufferMock,
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

function saveMediaBufferCall(): unknown[] {
  const call = saveMediaBufferMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveMediaBuffer call");
  }
  return call;
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
    saveMediaBufferMock.mockReset();
    saveMediaBufferMock.mockImplementation(
      async (_buffer: Buffer, contentType?: string, subdir?: string) => ({
        path: `/home/user/.openclaw/media/${subdir ?? "unknown"}/saved-media`,
        contentType,
      }),
    );
  });

  it("persists inbound media with the shared media store", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia("mid-jpeg", "token");

    expect(saveMediaBufferMock).toHaveBeenCalledTimes(1);
    const call = saveMediaBufferCall();
    expect((call[0] as Buffer).equals(jpeg)).toBe(true);
    expect(call[1]).toBe("image/jpeg");
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(result).toEqual({
      path: "/home/user/.openclaw/media/inbound/saved-media",
      contentType: "image/jpeg",
      size: jpeg.length,
    });
  });

  it("does not pass the external messageId to saveMediaBuffer", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia(messageId, "token");

    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    for (const arg of saveMediaBufferCall()) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("rejects oversized media before invoking saveMediaBuffer", async () => {
    getMessageContentMock.mockResolvedValueOnce(chunks([Buffer.alloc(4), Buffer.alloc(4)]));

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("classifies M4A ftyp major brand as audio/mp4", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([m4aHeader]));

    const result = await downloadLineMedia("mid-audio", "token");

    expect(result.contentType).toBe("audio/mp4");
    expect(saveMediaBufferCall()[1]).toBe("audio/mp4");
    expect(saveMediaBufferCall()[2]).toBe("inbound");
  });

  it("detects MP4 video from ftyp major brand (isom)", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([mp4]));

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
    expect(saveMediaBufferCall()[1]).toBe("video/mp4");
  });

  it("propagates media store failures", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));
    saveMediaBufferMock.mockRejectedValueOnce(new Error("Media exceeds 0MB limit"));

    await expect(downloadLineMedia("mid-bad", "token")).rejects.toThrow(/Media exceeds/i);
  });
});
