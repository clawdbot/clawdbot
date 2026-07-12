// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";

export const SESSION_ARCHIVE_ZSTD_SUFFIX = ".zst";

type ZstdCodec = {
  compress: (data: Buffer) => Buffer;
  decompress: (data: Buffer) => Buffer;
};

// node:zlib ships zstd since Node 22.15/23.8; Bun may not implement it yet.
// Feature-detect so the Bun path writes plain JSONL archives instead of
// crashing, and mixed plain/compressed archives always stay readable.
function resolveZstdCodec(): ZstdCodec | null {
  const candidate = zlib as Partial<{
    zstdCompressSync: (data: Buffer) => Buffer;
    zstdDecompressSync: (data: Buffer) => Buffer;
  }>;
  if (
    typeof candidate.zstdCompressSync !== "function" ||
    typeof candidate.zstdDecompressSync !== "function"
  ) {
    return null;
  }
  return {
    compress: candidate.zstdCompressSync.bind(zlib),
    decompress: candidate.zstdDecompressSync.bind(zlib),
  };
}

const zstdCodec = resolveZstdCodec();

/** Strips the optional zstd suffix so archive name parsers see one shape. */
export function stripSessionArchiveCompressionSuffix(fileName: string): string {
  return fileName.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)
    ? fileName.slice(0, -SESSION_ARCHIVE_ZSTD_SUFFIX.length)
    : fileName;
}

/** Compresses archive content when the runtime supports zstd. */
export function encodeSessionArchiveContent(content: string): {
  bytes: Buffer;
  suffix: "" | typeof SESSION_ARCHIVE_ZSTD_SUFFIX;
} {
  const plain = Buffer.from(content, "utf8");
  if (!zstdCodec || plain.length === 0) {
    return { bytes: plain, suffix: "" };
  }
  // Default zstd level (3) matches the ratio/speed point Codex uses for cold
  // rollouts; archives are write-once so speed matters less than footprint.
  return { bytes: zstdCodec.compress(plain), suffix: SESSION_ARCHIVE_ZSTD_SUFFIX };
}

/** Reads an archived transcript, transparently decompressing zstd artifacts. */
export function readSessionArchiveContentSync(filePath: string): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return fs.readFileSync(filePath, "utf8");
  }
  if (!zstdCodec) {
    throw new Error(
      `Cannot read compressed transcript archive ${filePath}: this runtime lacks node:zlib zstd support`,
    );
  }
  return zstdCodec.decompress(fs.readFileSync(filePath)).toString("utf8");
}

/**
 * Materializes a compressed archive as a plain JSONL cache file and returns
 * the readable path; plain archives pass through untouched. Archives are
 * write-once (timestamped names), so a cache hit never needs revalidation —
 * this lets every downstream transcript reader (index, tail chunks, header
 * probes) work on archives without learning about compression.
 */
export function materializeSessionArchiveForRead(filePath: string): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return filePath;
  }
  const cacheDir = path.join(resolvePreferredOpenClawTmpDir(), "session-archive-read-cache");
  const pathKey = createHash("sha256").update(filePath).digest("hex").slice(0, 32);
  // Source identity gates every hit: a deleted or replaced archive must never
  // keep serving plaintext from the cache (budget eviction deletes archives).
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(filePath);
  } catch (error) {
    removeMaterializedArchiveCacheEntries(cacheDir, pathKey);
    throw error;
  }
  const cachePath = path.join(
    cacheDir,
    `${pathKey}-${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}.jsonl`,
  );
  sweepMaterializedArchiveCache(cacheDir);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }
  const content = readSessionArchiveContentSync(filePath);
  removeMaterializedArchiveCacheEntries(cacheDir, pathKey, path.basename(cachePath));
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  // Concurrent readers may race to the same identity; last rename wins with
  // identical content, so neither can observe a torn or missing cache file.
  fs.renameSync(tempPath, cachePath);
  return cachePath;
}

// Bounded plaintext exposure: cache entries expire on age so archives deleted
// by budget eviction cannot leave decompressed copies behind indefinitely,
// and the cache itself cannot outgrow the archives it mirrors for long.
const MATERIALIZED_ARCHIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let lastMaterializedArchiveCacheSweepMs = 0;

function sweepMaterializedArchiveCache(cacheDir: string): void {
  const now = Date.now();
  if (now - lastMaterializedArchiveCacheSweepMs < MATERIALIZED_ARCHIVE_CACHE_TTL_MS / 24) {
    return;
  }
  lastMaterializedArchiveCacheSweepMs = now;
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(cacheDir, entry);
    try {
      if (now - fs.statSync(entryPath).mtimeMs > MATERIALIZED_ARCHIVE_CACHE_TTL_MS) {
        fs.rmSync(entryPath, { force: true });
      }
    } catch {
      // Another sweep may have removed it first; nothing to do.
    }
  }
}

// Scrubs stale identities for one archive path while leaving the current
// identity and any in-flight temp files (unique per writer) untouched, so
// concurrent readers can never delete each other's live materialization.
function removeMaterializedArchiveCacheEntries(
  cacheDir: string,
  pathKey: string,
  keepName?: string,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${pathKey}-`) || entry === keepName || entry.endsWith(".tmp")) {
      continue;
    }
    fs.rmSync(path.join(cacheDir, entry), { force: true });
  }
}
