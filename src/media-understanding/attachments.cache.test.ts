// Attachment cache tests cover MIME detection after local and remote bytes are available.
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";

const { buildRandomTempFilePathMock, readRemoteMediaBufferMock } = vi.hoisted(() => ({
  buildRandomTempFilePathMock: vi.fn(),
  readRemoteMediaBufferMock: vi.fn(),
}));

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
  };
});

vi.mock("../plugin-sdk/temp-path.js", async () => {
  const actual = await vi.importActual<typeof import("../plugin-sdk/temp-path.js")>(
    "../plugin-sdk/temp-path.js",
  );
  return {
    ...actual,
    buildRandomTempFilePath: buildRandomTempFilePathMock,
  };
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const AMBIGUOUS_WEBM = Buffer.from("1a45dfa3874282847765626d", "hex");

describe("media understanding attachment MIME detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    buildRandomTempFilePathMock.mockReset();
    readRemoteMediaBufferMock.mockReset();
  });

  it("prefers local attachment bytes over conflicting declared MIME", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-mime-local-" }, async (base) => {
      const attachmentPath = path.join(base, "photo.jpg");
      await fs.writeFile(attachmentPath, PNG_1X1);
      const cache = new MediaAttachmentCache(
        [{ index: 0, path: attachmentPath, mime: "application/pdf" }],
        { localPathRoots: [base] },
      );

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });

      expect(result.mime).toBe("image/png");
    });
  });

  it("prefers remote attachment bytes over conflicting MIME metadata", async () => {
    const url = "https://example.com/photo.jpg";
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: PNG_1X1,
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/pdf" }]);

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe("image/png");
  });

  it("uses fetched audio metadata when declared MIME is stale for ambiguous WebM", async () => {
    const url = "https://example.com/voice.webm";
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: AMBIGUOUS_WEBM,
      contentType: "audio/webm",
      fileName: "voice.webm",
    });
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/pdf" }]);

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe("audio/webm");
  });

  it("uses fetched OOXML metadata to refine extensionless generic ZIP bytes", async () => {
    const url = "https://example.com/download";
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer,
      contentType: docxMime,
      fileName: "download",
    });
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/pdf" }]);

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe(docxMime);
  });

  it("removes a partially staged attachment and preserves its write failure", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-write-failure-" }, async (base) => {
      const stagedPath = path.join(base, "failed.png");
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const writeFile = fs.writeFile.bind(fs);
      buildRandomTempFilePathMock.mockReturnValueOnce(stagedPath);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        await writeFile(file, PNG_1X1.subarray(0, 4));
        throw writeError;
      });
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }]);

      await expect(cache.getPath({ attachmentIndex: 0, timeoutMs: 1_000 })).rejects.toBe(
        writeError,
      );
      await cache.cleanup();

      expect(await fs.readdir(base)).toEqual([]);
    });
  });

  it("retries failed cleanup without losing earlier staging when a later attempt succeeds", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-cleanup-retry-" }, async (base) => {
      const firstPath = path.join(base, "failed.png");
      const secondPath = path.join(base, "success.png");
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const cleanupError = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const writeFile = fs.writeFile.bind(fs);
      buildRandomTempFilePathMock.mockReturnValueOnce(firstPath).mockReturnValueOnce(secondPath);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        await writeFile(file, PNG_1X1.subarray(0, 4));
        throw writeError;
      });
      vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupError);
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }]);
      const request = { attachmentIndex: 0, timeoutMs: 1_000 };

      await expect(cache.getPath(request)).rejects.toBe(writeError);
      expect(await fs.readdir(base)).toEqual(["failed.png"]);

      const staged = await cache.getPath(request);
      expect(staged.path).toBe(secondPath);
      expect((await cache.getPath(request)).path).toBe(secondPath);
      expect(writeFileSpy).toHaveBeenCalledTimes(2);
      expect((await fs.readdir(base)).toSorted()).toEqual(["failed.png", "success.png"]);

      await cache.cleanup();

      expect(await fs.readdir(base)).toEqual([]);
    });
  });
});
