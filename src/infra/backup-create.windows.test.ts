import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Minipass } from "minipass";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeBackupTarEntryProgress, writeArchiveStreamToFile } from "./backup-create-stream.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type ReportBackupProgress = Parameters<
  Parameters<typeof writeArchiveStreamToFile>[0]["createArchiveStream"]
>[0];

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
        createArchiveStream: () => archiveStream,
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
      createArchiveStream: () => archiveStream,
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
        createArchiveStream: () => archiveStream,
        idleTimeoutMs: 50,
      });
      archiveStream.write("partial archive");

      const rejection = expect(writePromise).rejects.toThrow(
        "Backup archive write stalled: no progress observed for 50ms",
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
        createArchiveStream: () => archiveStream,
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

  it("keeps the archive alive while the producer reports silent traversal progress", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-traversal-progress-");
      const archivePath = path.join(tempDir, "complete.tar.gz");
      const archiveStream = new PassThrough();
      let reportProgress: ReportBackupProgress | undefined;
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        createArchiveStream: (progress) => {
          reportProgress = progress;
          return archiveStream;
        },
      });

      for (let elapsed = 0; elapsed < 360_000; elapsed += 60_000) {
        await vi.advanceTimersByTimeAsync(60_000);
        reportProgress?.();
      }
      archiveStream.end("archive after traversal");

      await expect(writePromise).resolves.toMatchObject({ archivePath });
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("archive after traversal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the archive alive through more than five minutes of one entry's raw bytes", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-entry-progress-");
      const archivePath = path.join(tempDir, "complete.tar.gz");
      const archiveStream = new PassThrough();
      const entry = new Minipass();
      let reportProgress: ReportBackupProgress | undefined;
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        createArchiveStream: (progress) => {
          reportProgress = progress;
          return archiveStream;
        },
      });
      observeBackupTarEntryProgress(entry, (bytes) => {
        reportProgress?.({ phase: "raw", entryPath: "/source/large.pack", bytes });
      });
      entry.on("data", () => {});

      for (let elapsed = 0; elapsed < 360_000; elapsed += 60_000) {
        await vi.advanceTimersByTimeAsync(60_000);
        entry.write(Buffer.alloc(16));
      }
      entry.end();
      archiveStream.end("archive after one large entry");

      await expect(writePromise).resolves.toMatchObject({ archivePath });
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("archive after one large entry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-current tar entries paused until the archive consumer attaches", async () => {
    const firstEntry = new Minipass();
    const secondEntry = new Minipass();
    const reportProgress = vi.fn();
    observeBackupTarEntryProgress(firstEntry, reportProgress);
    observeBackupTarEntryProgress(secondEntry, reportProgress);

    firstEntry.end("first entry");
    secondEntry.end("second entry");
    const firstChunks: Buffer[] = [];
    const secondChunks: Buffer[] = [];
    firstEntry.on("data", (chunk) => firstChunks.push(chunk));
    secondEntry.on("data", (chunk) => secondChunks.push(chunk));

    await Promise.all([firstEntry.promise(), secondEntry.promise()]);
    expect(Buffer.concat(firstChunks).toString()).toBe("first entry");
    expect(Buffer.concat(secondChunks).toString()).toBe("second entry");
    expect(reportProgress).toHaveBeenCalledTimes(2);
  });

  it("cleans a partial archive when one entry stops producing raw bytes", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-entry-timeout-");
      const archivePath = path.join(tempDir, "partial.tar.gz");
      const archiveStream = new PassThrough();
      const entry = new Minipass();
      let reportProgress: ReportBackupProgress | undefined;
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        createArchiveStream: (progress) => {
          reportProgress = progress;
          return archiveStream;
        },
      });
      observeBackupTarEntryProgress(entry, (bytes) => {
        reportProgress?.({ phase: "raw", entryPath: "/source/stalled.pack", bytes });
      });
      entry.on("data", () => {});
      entry.write(Buffer.alloc(16));
      archiveStream.write("partial archive");

      const rejection = expect(writePromise).rejects.toThrow(
        'Backup archive write stalled: no progress observed for 300000ms (phase=output, entry="/source/stalled.pack", rawBytes=16, outputBytes=15)',
      );
      await vi.advanceTimersByTimeAsync(300_001);
      await rejection;
      await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
    }
  });
});
