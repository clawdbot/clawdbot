import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { writeTranscriptArchive } from "./session-accessor.sqlite-archive.js";

describe("SQLite transcript archive stream writer", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let archiveDirectory: string;

  beforeEach(() => {
    archiveDirectory = tempDirs.make("openclaw-archive-stream-");
  });

  afterEach(() => {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
  });

  it("routes existing whole-content callers through the canonical publisher", async () => {
    const sessionId = "whole-content-archive-session";
    const content = `${createTranscriptEventLine(sessionId, "existing caller")}\n`;

    const archivedPath = await writeTranscriptArchive({
      archiveDirectory,
      content,
      reason: "bak",
      sessionId,
    });

    expect(readSessionArchiveContentSync(archivedPath)).toBe(content);
  });

  it("reuses matching content across arbitrary source chunk boundaries", async () => {
    const sessionId = "streamed-duplicate-archive-session";
    const content = `${JSON.stringify({
      id: sessionId,
      text: "\u4f60\u597d\ud83e\udd9e".repeat(32_768),
    })}\n`;
    const contentBytes = Buffer.from(content, "utf8");
    const first = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(contentBytes, 7),
      reason: "deleted",
      sessionId,
    });
    const second = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(contentBytes, 4093),
      reason: "deleted",
      sessionId,
    });

    expect(second).toBe(first);
    expect(readSessionArchiveContentSync(second)).toBe(content);
  });

  it("ignores a corrupt compressed candidate and publishes an exact archive", async () => {
    const sessionId = "corrupt-candidate-archive-session";
    const content = `${createTranscriptEventLine(sessionId, "valid replacement")}\n`;
    const corruptPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z.zst`,
    );
    fs.writeFileSync(corruptPath, randomBytes(128));

    const archivedPath = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: [Buffer.from(content, "utf8")],
      reason: "deleted",
      sessionId,
    });

    expect(archivedPath).not.toBe(corruptPath);
    expect(readSessionArchiveContentSync(archivedPath)).toBe(content);
    expect(fs.readFileSync(corruptPath)).toHaveLength(128);
  });

  it("cleans staged output when exact stream verification fails", async () => {
    const sessionId = "failed-stream-verification-session";

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("original\n", "utf8")],
        reason: "deleted",
        sessionId,
        validateSource: () => {
          const staged = fs
            .readdirSync(archiveDirectory)
            .find((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`));
          if (!staged) {
            throw new Error("expected staged archive");
          }
          fs.writeFileSync(path.join(archiveDirectory, staged), "changed\n", "utf8");
        },
      }),
    ).rejects.toThrow(`SQLite transcript archive verification failed for ${sessionId}`);

    expect(findArchiveEntries(archiveDirectory, sessionId)).toEqual([]);
  });

  it("cleans staged output when archive durability fails", async () => {
    const sessionId = "failed-stream-fsync-session";
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected archive fsync failure"), { code: "EIO" });
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("durability required\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow("injected archive fsync failure");
    expect(findArchiveEntries(archiveDirectory, sessionId)).toEqual([]);
  });

  it("preserves the archive failure when Windows-style temp cleanup also fails", async () => {
    const sessionId = "failed-stream-cleanup-session";
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("primary archive failure"), { code: "EIO" });
    });
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected busy cleanup"), { code: "EBUSY" });
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("preserve the primary failure\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow("primary archive failure");
  });

  it("reuses an identical archive after a no-clobber publication race", async () => {
    const sessionId = "concurrent-stream-archive-session";
    const content = `${createTranscriptEventLine(sessionId, "concurrent publication")}\n`;
    vi.spyOn(Date, "now").mockReturnValue(1_788_000_000_000);
    const writeArchive = () =>
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from(content, "utf8")],
        reason: "deleted",
        sessionId,
      });

    const [first, second] = await Promise.all([writeArchive(), writeArchive()]);

    expect(second).toBe(first);
    expect(readSessionArchiveContentSync(first)).toBe(content);
    expect(
      findArchiveEntries(archiveDirectory, sessionId).filter((entry) => !entry.endsWith(".tmp")),
    ).toHaveLength(1);
  });

  it("rejects an archive pathname pruned during the publication durability boundary", async () => {
    const sessionId = "pruned-during-publication-session";
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync: (_method, targetPath) => {
        fs.rmSync(targetPath);
      },
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("must remain durable\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow(`SQLite transcript archive verification failed for ${sessionId}`);

    expect(findArchiveEntries(archiveDirectory, sessionId)).toEqual([]);
  });

  it("removes its published archive when final content verification fails", async () => {
    const sessionId = "corrupt-after-publication-session";
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync: (_method, targetPath) => {
        fs.writeFileSync(targetPath, "corrupt after publication\n", "utf8");
      },
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("verified before publication\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow(`SQLite transcript archive verification failed for ${sessionId}`);

    expect(findArchiveEntries(archiveDirectory, sessionId)).toEqual([]);
  });

  it("preserves a replacement at the archive path after final verification fails", async () => {
    const sessionId = "replaced-after-publication-session";
    let publishedPath: string | undefined;
    const displacedPath = path.join(archiveDirectory, "displaced-publication");
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync: (_method, targetPath) => {
        publishedPath = targetPath;
        fs.renameSync(targetPath, displacedPath);
        fs.writeFileSync(targetPath, "replacement owner\n", "utf8");
      },
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("original publication\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow(`SQLite transcript archive verification failed for ${sessionId}`);

    expect(publishedPath).toBeDefined();
    expect(fs.readFileSync(publishedPath!, "utf8")).toBe("replacement owner\n");
  });

  it("preserves the verification error when published archive cleanup fails", async () => {
    const sessionId = "busy-after-publication-session";
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync: (_method, targetPath) => {
        fs.writeFileSync(targetPath, "corrupt after publication\n", "utf8");
      },
    });
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected busy published archive cleanup"), { code: "EBUSY" });
    });

    await expect(
      writeTranscriptArchive({
        archiveDirectory,
        contentChunks: [Buffer.from("verified before publication\n", "utf8")],
        reason: "deleted",
        sessionId,
      }),
    ).rejects.toThrow(`SQLite transcript archive verification failed for ${sessionId}`);

    expect(findArchiveEntries(archiveDirectory, sessionId)).toHaveLength(1);
  });
});

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({ type: "session", id: sessionId, content });
}

function findArchiveEntries(archiveDirectory: string, sessionId: string): string[] {
  return fs
    .readdirSync(archiveDirectory)
    .filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`));
}

function* splitBuffer(content: Buffer, chunkSize: number): IterableIterator<Buffer> {
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    yield content.subarray(offset, Math.min(offset + chunkSize, content.length));
  }
}
