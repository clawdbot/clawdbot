// Attachment cache tests cover bounded reads, MIME detection, and temporary-file ownership.
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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

describe("media understanding attachment cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    buildRandomTempFilePathMock.mockReset();
    readRemoteMediaBufferMock.mockReset();
  });

  it.each([
    {
      name: "prefers local attachment bytes over conflicting declared MIME",
      fileName: "photo.jpg",
      buffer: PNG_1X1,
      declaredMime: "application/pdf",
      expected: { mime: "image/png", class: "image" },
    },
    {
      name: "infers long UTF-8 text from a generically typed local attachment",
      fileName: "notes",
      buffer: Buffer.from("验证".repeat(700), "utf8"),
      declaredMime: "application/octet-stream",
      expected: { mime: "text/plain", class: "text" },
    },
  ])("$name", async (testCase) => {
    await withTestDir({ prefix: "openclaw-media-cache-mime-local-" }, async (base) => {
      const attachmentPath = path.join(base, testCase.fileName);
      await fs.writeFile(attachmentPath, testCase.buffer);
      const cache = new MediaAttachmentCache(
        [{ index: 0, path: attachmentPath, mime: testCase.declaredMime }],
        { localPathRoots: [base] },
      );

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: testCase.buffer.byteLength,
        timeoutMs: 1000,
      });

      expect(result.mime).toBe(testCase.expected.mime);
      expect(result.classification).toEqual(testCase.expected);
      expect(result.buffer).toEqual(testCase.buffer);
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

  it.each(["unchanged", "growing", "read-failure"] as const)(
    "closes one bounded local read when the file is %s",
    async (behavior) => {
      await withTestDir({ prefix: "openclaw-media-cache-growth-" }, async (base) => {
        const attachmentPath = path.join(base, "growing.png");
        await fs.writeFile(attachmentPath, PNG_1X1);
        const maxBytes = PNG_1X1.length;
        const open = fs.open.bind(fs);
        let consumed = 0;
        let opens = 0;
        let closes = 0;
        let grew = false;
        const readError = new Error("synthetic read failure");
        const growBeforeRead = async () => {
          if (behavior === "read-failure") {
            throw readError;
          }
          if (behavior === "growing" && !grew) {
            grew = true;
            await fs.appendFile(attachmentPath, Buffer.alloc(4096));
          }
        };
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          opens += 1;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            closes += 1;
            await close();
          });
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            await growBeforeRead();
            const result = await read(...readArgs);
            consumed += result.bytesRead;
            return result;
          });
          const readFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => {
            await growBeforeRead();
            const result = await readFile(...readArgs);
            consumed += result.length;
            return result;
          });
          return handle;
        });
        const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
          localPathRoots: [base],
          includeDefaultLocalPathRoots: false,
        });

        const result = cache.getBuffer({ attachmentIndex: 0, maxBytes, timeoutMs: 1000 });
        if (behavior === "unchanged") {
          await expect(result).resolves.toMatchObject({ buffer: PNG_1X1 });
        } else if (behavior === "growing") {
          await expect(result).rejects.toMatchObject({ reason: "maxBytes" });
        } else {
          await expect(result).rejects.toBe(readError);
        }
        expect(opens).toBe(1);
        expect(closes).toBe(opens);
        expect(consumed).toBe(behavior === "read-failure" ? 0 : maxBytes + Number(grew));
      });
    },
  );

  it.each(["local", "staged"] as const)(
    "enforces a zero-byte path limit for %s files",
    async (source) => {
      expectTypeOf<Parameters<MediaAttachmentCache["getPath"]>[0]>().toEqualTypeOf<{
        attachmentIndex: number;
        maxBytes: number;
        timeoutMs: number;
      }>();
      await withTestDir({ prefix: "openclaw-media-cache-path-limit-" }, async (base) => {
        const attachmentPath = path.join(base, "photo.png");
        await fs.writeFile(attachmentPath, PNG_1X1);
        buildRandomTempFilePathMock.mockReturnValue(path.join(base, "staged.png"));
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
        const attachment =
          source === "local"
            ? { index: 0, path: attachmentPath }
            : { index: 0, url: "https://example.com/photo.png" };
        const cache = new MediaAttachmentCache([attachment], { localPathRoots: [base] });
        const request = { attachmentIndex: 0, maxBytes: PNG_1X1.length, timeoutMs: 1000 };
        try {
          await expect(cache.getPath(request)).resolves.toHaveProperty("path");
          await expect(cache.getPath({ ...request, maxBytes: 0 })).rejects.toMatchObject({
            reason: "maxBytes",
          });
        } finally {
          await cache.cleanup();
        }
      });
    },
  );

  it.each(["cache", "returned"] as const)(
    "restages files after %s cleanup",
    async (cleanupOwner) => {
      await withTestDir({ prefix: "openclaw-media-cache-restage-" }, async (base) => {
        buildRandomTempFilePathMock
          .mockReturnValueOnce(path.join(base, "first.png"))
          .mockReturnValueOnce(path.join(base, "second.png"));
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
        const cache = new MediaAttachmentCache([
          { index: 0, url: "https://example.com/photo.png" },
        ]);
        const request = { attachmentIndex: 0, maxBytes: PNG_1X1.length, timeoutMs: 1000 };
        try {
          const first = await cache.getPath(request);
          await (cleanupOwner === "cache" ? cache.cleanup() : first.cleanup?.());
          await expect(fs.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
          const second = await cache.getPath(request);
          await expect(fs.readFile(second.path)).resolves.toEqual(PNG_1X1);
          await first.cleanup?.();
          expect((await cache.getPath(request)).path).toBe(second.path);
          expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
        } finally {
          await cache.cleanup();
        }
        expect(await fs.readdir(base)).toEqual([]);
      });
    },
  );

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

      await expect(
        cache.getPath({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 }),
      ).rejects.toBe(writeError);
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
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 };

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
