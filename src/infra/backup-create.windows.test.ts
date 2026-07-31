import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("writeArchiveStreamToFile", () => {
  it("removes the exclusive partial archive when its initial descriptor stat fails", async () => {
    const tempDir = tempDirs.make("openclaw-backup-stream-fstat-");
    const archivePath = path.join(tempDir, "partial.tar.gz");
    const archiveStream = new PassThrough();
    const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("fstat failed"), { code: "EIO" });
    });
    try {
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        archiveStream,
      });
      archiveStream.end("partial archive");

      await expect(writePromise).rejects.toThrow("fstat failed");
      await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      fstatSpy.mockRestore();
    }
  });

  it("closes a partial archive before propagating a stream error", async () => {
    const tempDir = tempDirs.make("openclaw-backup-stream-");
    const archivePath = path.join(tempDir, "partial.tar.gz");
    const archiveStream = new PassThrough();
    const writePromise = writeArchiveStreamToFile({
      archivePath,
      archiveStream,
    });
    archiveStream.write("partial archive");
    archiveStream.destroy(new Error("injected tar read failure"));

    await expect(writePromise).rejects.toThrow("injected tar read failure");
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts and closes a partial archive when the source stops producing data", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-timeout-");
      const archivePath = path.join(tempDir, "partial.tar.gz");
      const archiveStream = new PassThrough();
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        archiveStream,
        idleTimeoutMs: 50,
      });
      archiveStream.write("partial archive");

      const rejection = expect(writePromise).rejects.toThrow(
        "Backup archive write stalled: no data produced for 50ms",
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
      expect(archiveStream.destroyed).toBe(true);
      await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle timeout when archive data keeps arriving", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-progress-");
      const archivePath = path.join(tempDir, "complete.tar.gz");
      const archiveStream = new PassThrough();
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        archiveStream,
        idleTimeoutMs: 50,
      });

      archiveStream.write("first");
      await vi.advanceTimersByTimeAsync(40);
      archiveStream.write("second");
      await vi.advanceTimersByTimeAsync(40);
      archiveStream.end("third");

      await expect(writePromise).resolves.toMatchObject({ archivePath });
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("firstsecondthird");
    } finally {
      vi.useRealTimers();
    }
  });
});
