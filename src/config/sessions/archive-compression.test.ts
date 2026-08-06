// Round-trip and naming coverage for the archived-transcript zstd cold tier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
  stripSessionArchiveCompressionSuffix,
} from "./archive-compression.js";
import {
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "./artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-zstd-"));
  tempDirs.push(dir);
  return dir;
}

describe("archive compression", () => {
  it("round-trips archived transcript content through encode and read", () => {
    const content = `${JSON.stringify({ type: "message", body: "hello" })}\n`.repeat(200);
    const encoded = encodeSessionArchiveContent(content);
    const dir = makeTempDir();
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    expect(readSessionArchiveContentSync(archivePath)).toBe(content);
    if (encoded.suffix === SESSION_ARCHIVE_ZSTD_SUFFIX) {
      // Compression must actually pay for itself on repetitive JSONL.
      expect(encoded.bytes.length).toBeLessThan(Buffer.byteLength(content, "utf8") / 2);
    }
  });

  it("keeps plain archives readable regardless of runtime zstd support", () => {
    const dir = makeTempDir();
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "plain\n", "utf8");

    expect(readSessionArchiveContentSync(archivePath)).toBe("plain\n");
  });

  it("materializes compressed archives to a stable plain JSONL cache path", () => {
    const content = `${JSON.stringify({ type: "message", body: "cold" })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = makeTempDir();
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    const first = materializeSessionArchiveForRead(archivePath);
    const second = materializeSessionArchiveForRead(archivePath);

    expect(second).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(content);
    if (encoded.suffix === "") {
      // Plain archives pass through untouched.
      expect(first).toBe(archivePath);
    } else {
      expect(first.endsWith(".jsonl")).toBe(true);
    }
  });

  it("strips the zstd suffix so archive name parsers see one shape", () => {
    const plain = "sess.jsonl.deleted.2026-07-11T00-00-00.000Z";
    const compressed = `${plain}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;

    expect(stripSessionArchiveCompressionSuffix(compressed)).toBe(plain);
    expect(parseSessionArchiveTimestamp(compressed, "deleted")).toBe(
      parseSessionArchiveTimestamp(plain, "deleted"),
    );
    expect(parseUsageCountedSessionIdFromFileName(compressed)).toBe("sess");
  });
});
