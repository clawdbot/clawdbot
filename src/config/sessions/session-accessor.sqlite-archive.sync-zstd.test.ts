import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

describe("SQLite transcript archive partial zstd capabilities", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.doUnmock("node:zlib");
    vi.resetModules();
  });

  it("reuses a sync-created legacy zstd archive through transform constructors", async () => {
    const { readSessionArchiveContentSync, writeTranscriptArchive } = await loadArchiveModules({
      hideFactories: true,
    });
    const archiveDirectory = tempDirs.make("openclaw-archive-zstd-constructors-");
    const sessionId = "constructor-zstd-session";
    const content = `${JSON.stringify({ id: sessionId, text: "compressible".repeat(8192) })}\n`;
    const bytes = Buffer.from(content, "utf8");
    const legacyPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z.zst`,
    );
    fs.writeFileSync(legacyPath, zlib.zstdCompressSync(bytes));

    const archivedPath = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(bytes, 97),
      reason: "deleted",
      sessionId,
    });

    expect(archivedPath).toBe(legacyPath);
    expect(readSessionArchiveContentSync(archivedPath)).toBe(content);
    expect(
      fs
        .readdirSync(archiveDirectory)
        .filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`)),
    ).toEqual([path.basename(legacyPath)]);
  });

  it("keeps a reusable plain fallback when no zstd transforms exist", async () => {
    const { readSessionArchiveContentSync, writeTranscriptArchive } = await loadArchiveModules({
      hideConstructors: true,
      hideFactories: true,
    });
    const archiveDirectory = tempDirs.make("openclaw-archive-true-sync-zstd-");
    const sessionId = "true-sync-only-zstd-session";
    const content = `${JSON.stringify({ id: sessionId, text: "compressible".repeat(8192) })}\n`;
    const bytes = Buffer.from(content, "utf8");
    const legacyPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z.zst`,
    );
    fs.writeFileSync(legacyPath, zlib.zstdCompressSync(bytes));

    const first = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(bytes, 97),
      reason: "deleted",
      sessionId,
    });
    const second = await writeTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(bytes, 4093),
      reason: "deleted",
      sessionId,
    });

    expect(first.endsWith(".zst")).toBe(false);
    expect(second).toBe(first);
    expect(readSessionArchiveContentSync(legacyPath)).toBe(content);
    expect(readSessionArchiveContentSync(first)).toBe(content);
    expect(
      fs
        .readdirSync(archiveDirectory)
        .filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`)),
    ).toHaveLength(2);
  });
});

async function loadArchiveModules(options: {
  hideConstructors?: boolean;
  hideFactories?: boolean;
}): Promise<{
  readSessionArchiveContentSync: typeof import("./archive-compression.js").readSessionArchiveContentSync;
  writeTranscriptArchive: typeof import("./session-accessor.sqlite-archive.js").writeTranscriptArchive;
}> {
  vi.resetModules();
  vi.doMock("node:zlib", async () => {
    const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
    return {
      ...actual,
      default: {
        ...actual,
        createZstdCompress: options.hideFactories ? undefined : actual.createZstdCompress,
        createZstdDecompress: options.hideFactories ? undefined : actual.createZstdDecompress,
        ZstdCompress: options.hideConstructors ? undefined : actual.ZstdCompress,
        ZstdDecompress: options.hideConstructors ? undefined : actual.ZstdDecompress,
      },
    };
  });
  const archiveCompression = await import("./archive-compression.js");
  const sqliteArchive = await import("./session-accessor.sqlite-archive.js");
  return {
    readSessionArchiveContentSync: archiveCompression.readSessionArchiveContentSync,
    writeTranscriptArchive: sqliteArchive.writeTranscriptArchive,
  };
}

function* splitBuffer(content: Buffer, chunkSize: number): IterableIterator<Buffer> {
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    yield content.subarray(offset, Math.min(offset + chunkSize, content.length));
  }
}
