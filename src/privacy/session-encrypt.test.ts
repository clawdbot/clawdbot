import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  encryptSessionFile,
  decryptSessionFile,
  decryptSessionFileInPlace,
  isEncryptedSessionFile,
  encryptSessionDirectory,
} from "./session-encrypt.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const PASSPHRASE = "s3cr3t-test-passphrase";

const SAMPLE_LINES = [
  JSON.stringify({ type: "session", id: "abc123", version: 3, timestamp: 1_700_000_000_000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello world" }] }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Hi there!" }] }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "My SSN is 123-45-6789" }] }),
];

function writeTempJsonl(dir: string, name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", { mode: 0o600 });
  return filePath;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-privacy-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// isEncryptedSessionFile
// ──────────────────────────────────────────────────────────────────────────────

describe("isEncryptedSessionFile", () => {
  it("returns false for plain JSONL", async () => {
    const file = writeTempJsonl(tmpDir, "plain.jsonl", SAMPLE_LINES);
    expect(await isEncryptedSessionFile(file)).toBe(false);
  });

  it("returns false for non-existent file", async () => {
    expect(await isEncryptedSessionFile(path.join(tmpDir, "ghost.jsonl"))).toBe(false);
  });

  it("returns true after encrypting", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    expect(await isEncryptedSessionFile(file)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// encryptSessionFile
// ──────────────────────────────────────────────────────────────────────────────

describe("encryptSessionFile", () => {
  it("returns error for missing file", async () => {
    const result = await encryptSessionFile({
      filePath: path.join(tmpDir, "missing.jsonl"),
      passphrase: PASSPHRASE,
      iterations: 1000,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("not found");
  });

  it("encrypts a plain-text JSONL file", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    const result = await encryptSessionFile({
      filePath: file,
      passphrase: PASSPHRASE,
      iterations: 1000,
    });
    expect(result.ok).toBe(true);
    expect((result as { linesProcessed: number }).linesProcessed).toBe(SAMPLE_LINES.length);
  });

  it("replaces file with opaque content (no plaintext visible)", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    const content = fs.readFileSync(file, "utf8");
    // Plain-text should NOT appear in the encrypted file
    expect(content).not.toContain("Hello world");
    expect(content).not.toContain("123-45-6789");
    expect(content).not.toContain("assistant");
    // The header should be present
    expect(content).toContain("openclaw_encrypted_session");
  });

  it("refuses to double-encrypt an already-encrypted file", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    const second = await encryptSessionFile({
      filePath: file,
      passphrase: PASSPHRASE,
      iterations: 1000,
    });
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toContain("already encrypted");
  });

  it("handles empty file gracefully", async () => {
    const file = writeTempJsonl(tmpDir, "empty.jsonl", []);
    const result = await encryptSessionFile({
      filePath: file,
      passphrase: PASSPHRASE,
      iterations: 1000,
    });
    expect(result.ok).toBe(true);
    expect((result as { linesProcessed: number }).linesProcessed).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// decryptSessionFile (read-only, does not modify file)
// ──────────────────────────────────────────────────────────────────────────────

describe("decryptSessionFile", () => {
  it("round-trips: decrypt recovers original lines", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    const result = await decryptSessionFile({ filePath: file, passphrase: PASSPHRASE });
    expect(result.ok).toBe(true);
    const lines = (result as { lines: string[] }).lines;
    expect(lines).toHaveLength(SAMPLE_LINES.length);
    for (let i = 0; i < SAMPLE_LINES.length; i++) {
      expect(lines[i]).toBe(SAMPLE_LINES[i]);
    }
  });

  it("returns error with wrong passphrase", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    const result = await decryptSessionFile({ filePath: file, passphrase: "wrong-passphrase" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("line 1");
  });

  it("transparently reads plain-text files (unencrypted pass-through)", async () => {
    const file = writeTempJsonl(tmpDir, "plain.jsonl", SAMPLE_LINES);
    const result = await decryptSessionFile({ filePath: file, passphrase: PASSPHRASE });
    expect(result.ok).toBe(true);
    const lines = (result as { lines: string[] }).lines;
    expect(lines).toEqual(SAMPLE_LINES);
  });

  it("returns error for missing file", async () => {
    const result = await decryptSessionFile({
      filePath: path.join(tmpDir, "ghost.jsonl"),
      passphrase: PASSPHRASE,
    });
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// decryptSessionFileInPlace
// ──────────────────────────────────────────────────────────────────────────────

describe("decryptSessionFileInPlace", () => {
  it("restores original plain-text content", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    const result = await decryptSessionFileInPlace({ filePath: file, passphrase: PASSPHRASE });
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    for (const line of SAMPLE_LINES) {
      expect(content).toContain(line);
    }
  });

  it("file is no longer detected as encrypted after decryption", async () => {
    const file = writeTempJsonl(tmpDir, "session.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });
    await decryptSessionFileInPlace({ filePath: file, passphrase: PASSPHRASE });
    expect(await isEncryptedSessionFile(file)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// encryptSessionDirectory
// ──────────────────────────────────────────────────────────────────────────────

describe("encryptSessionDirectory", () => {
  it("encrypts all JSONL files in a directory tree", async () => {
    const subDir = path.join(tmpDir, "agents", "main", "sessions");
    fs.mkdirSync(subDir, { recursive: true });
    writeTempJsonl(subDir, "sess-a.jsonl", SAMPLE_LINES);
    writeTempJsonl(subDir, "sess-b.jsonl", SAMPLE_LINES);

    const summary = await encryptSessionDirectory({
      dirPath: tmpDir,
      passphrase: PASSPHRASE,
      iterations: 1000,
    });

    expect(summary.encrypted).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toHaveLength(0);

    // Verify both files are now encrypted
    expect(await isEncryptedSessionFile(path.join(subDir, "sess-a.jsonl"))).toBe(true);
    expect(await isEncryptedSessionFile(path.join(subDir, "sess-b.jsonl"))).toBe(true);
  });

  it("skips already-encrypted files and counts them", async () => {
    const file = writeTempJsonl(tmpDir, "already.jsonl", SAMPLE_LINES);
    await encryptSessionFile({ filePath: file, passphrase: PASSPHRASE, iterations: 1000 });

    const summary = await encryptSessionDirectory({
      dirPath: tmpDir,
      passphrase: PASSPHRASE,
      iterations: 1000,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.encrypted).toBe(0);
  });
});
