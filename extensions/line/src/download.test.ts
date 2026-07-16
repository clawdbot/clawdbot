import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMessageContentMock = vi.hoisted(() => vi.fn());

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

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia } = await import("./download.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getMessageContentMock.mockReset();
  });

  it("does not derive temp file path from external messageId", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia(messageId, "token");
    const writtenPath = writeSpy.mock.calls[0]?.[0];

    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    expect(typeof writtenPath).toBe("string");
    if (typeof writtenPath !== "string") {
      throw new Error("expected string temp file path");
    }
    expect(result.path).toBe(writtenPath);
    expect(writtenPath).toContain("line-media-");
    expect(writtenPath).toMatch(/\.jpg$/);
    expect(writtenPath).not.toContain(messageId);
    expect(writtenPath).not.toContain("..");

    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    const rel = path.relative(tmpRoot, path.resolve(writtenPath));
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
  });

  it("rejects oversized media before writing to disk", async () => {
    getMessageContentMock.mockResolvedValueOnce(chunks([Buffer.alloc(4), Buffer.alloc(4)]));
    const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("classifies M4A ftyp major brand as audio/mp4", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([m4aHeader]));
    const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid-audio", "token");
    const writtenPath = writeSpy.mock.calls[0]?.[0];

    expect(result.contentType).toBe("audio/mp4");
    expect(result.path).toMatch(/\.m4a$/);
    expect(writtenPath).toBe(result.path);
  });

  it("detects MP4 video from ftyp major brand (isom)", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([mp4]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
    expect(result.path).toMatch(/\.mp4$/);
  });
});
