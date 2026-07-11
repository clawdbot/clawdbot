// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import fs from "node:fs";
import zlib from "node:zlib";

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
