/**
 * At-rest encryption for OpenClaw session transcript files.
 *
 * Session JSONL files contain the full conversation history — every message
 * the user sent, every reply from the LLM, every tool call and its output.
 * They are stored in plain-text on disk under ~/.openclaw/agents/<agentId>/sessions/.
 *
 * This module provides AES-256-GCM encryption/decryption for those files
 * using a key derived from a user-supplied passphrase via PBKDF2-SHA256.
 *
 * Wire-up
 * ───────
 * The encryption is applied at the JSONL *line* level.  Each line of the
 * transcript is individually encrypted so that:
 *  1. Partial corruption only affects individual messages, not the whole file.
 *  2. The file header (first line) stays readable as a plain JSON marker.
 *
 * Note: encryption is currently applied in bulk (full-file rewrite) via
 * `encryptSessionFile`.  Per-line streaming appends are not yet implemented.
 *
 * On-disk format (encrypted file)
 * ───────────────────────────────
 * Line 0: plain-text JSON header  {"type":"openclaw_encrypted_session","v":1,"alg":"aes-256-gcm","kdf":"pbkdf2-sha256","iter":<N>,"salt":"<hex>"}
 * Line 1+: base64(iv[12] || authTag[16] || ciphertext)  — one per original JSONL line
 *
 * Usage
 * ─────
 *  import { encryptSessionFile, decryptSessionFile, isEncryptedSessionFile } from "./session-encrypt.js";
 *
 *  // Encrypt an existing plain-text session file in-place
 *  await encryptSessionFile({ filePath, passphrase });
 *
 *  // Read back all plain-text lines from an encrypted file
 *  const lines = await decryptSessionFile({ filePath, passphrase });
 *
 *  // Check whether a file is already encrypted
 *  const encrypted = await isEncryptedSessionFile(filePath);
 *
 * @module privacy/session-encrypt
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // 96-bit IV — GCM standard
const TAG_LEN = 16; // 128-bit auth tag
const KDF = "pbkdf2-sha256";
const DEFAULT_PBKDF2_ITERATIONS = 210_000; // OWASP minimum for PBKDF2-SHA256
const SALT_LEN = 32;

const ENCRYPTED_HEADER_TYPE = "openclaw_encrypted_session";
const ENCRYPTED_HEADER_VERSION = 1;

export const ERR_ALREADY_ENCRYPTED = "File is already encrypted" as const;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type EncryptedFileHeader = {
  type: typeof ENCRYPTED_HEADER_TYPE;
  v: number;
  alg: string;
  kdf: string;
  iter: number;
  salt: string; // hex-encoded 32-byte salt
};

export type EncryptSessionFileParams = {
  filePath: string;
  passphrase: string;
  /** Override PBKDF2 iteration count. Default: 210_000. */
  iterations?: number;
};

export type DecryptSessionFileParams = {
  filePath: string;
  passphrase: string;
};

export type SessionEncryptResult =
  | { ok: true; linesProcessed: number }
  | { ok: false; error: string };

export type SessionDecryptResult = { ok: true; lines: string[] } | { ok: false; error: string };

// ──────────────────────────────────────────────────────────────────────────────
// Key derivation
// ──────────────────────────────────────────────────────────────────────────────

const pbkdf2Async = promisify(pbkdf2);

async function deriveKey(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return pbkdf2Async(passphrase, salt, iterations, KEY_LEN, "sha256");
}

// ──────────────────────────────────────────────────────────────────────────────
// Line-level encrypt / decrypt
// ──────────────────────────────────────────────────────────────────────────────

function encryptLine(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: iv[12] || authTag[16] || ciphertext[N]
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

function decryptLine(encoded: string, key: Buffer): string {
  const packed = Buffer.from(encoded, "base64");
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error(`Encrypted line too short: ${packed.length} bytes`);
  }
  const iv = packed.subarray(0, IV_LEN);
  const authTag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given file begins with an OpenClaw encrypted-session
 * header.  Does not validate the passphrase.
 */
export async function isEncryptedSessionFile(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const fd = await fs.open(filePath, "r");
    const buf = Buffer.alloc(256);
    try {
      const { bytesRead } = await fd.read(buf, 0, 256, 0);
      const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      const header = JSON.parse(firstLine.trim()) as Partial<EncryptedFileHeader>;
      return header.type === ENCRYPTED_HEADER_TYPE && header.v === ENCRYPTED_HEADER_VERSION;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * Encrypt an existing plain-text JSONL session file in-place.
 *
 * The operation is atomic: the file is written to a temp path first and then
 * renamed over the original.  If the file is already encrypted, returns an
 * error rather than double-encrypting.
 */
export async function encryptSessionFile(
  params: EncryptSessionFileParams,
): Promise<SessionEncryptResult> {
  const { filePath, passphrase } = params;
  const iterations = params.iterations ?? DEFAULT_PBKDF2_ITERATIONS;

  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  if (await isEncryptedSessionFile(filePath)) {
    return { ok: false, error: ERR_ALREADY_ENCRYPTED };
  }

  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { ok: true, linesProcessed: 0 };
  }

  const salt = randomBytes(SALT_LEN);
  const key = await deriveKey(passphrase, salt, iterations);

  const header: EncryptedFileHeader = {
    type: ENCRYPTED_HEADER_TYPE,
    v: ENCRYPTED_HEADER_VERSION,
    alg: ALGORITHM,
    kdf: KDF,
    iter: iterations,
    salt: salt.toString("hex"),
  };

  const encryptedLines = [JSON.stringify(header)];
  for (const line of lines) {
    encryptedLines.push(encryptLine(line, key));
  }

  const output = encryptedLines.join("\n") + "\n";
  const tmpPath = `${filePath}.encrypting`;

  try {
    writeFileSync(tmpPath, output, { mode: 0o600, encoding: "utf8" });
    renameSync(tmpPath, filePath);
    return { ok: true, linesProcessed: lines.length };
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup error
    }
    return {
      ok: false,
      error: `Failed to write encrypted file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Decrypt an encrypted JSONL session file and return all plain-text lines.
 * Does not modify the file on disk.
 */
export async function decryptSessionFile(
  params: DecryptSessionFileParams,
): Promise<SessionDecryptResult> {
  const { filePath, passphrase } = params;

  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  if (!(await isEncryptedSessionFile(filePath))) {
    // File is plain-text — just return lines as-is (transparent fallback)
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return { ok: true, lines };
  }

  const raw = readFileSync(filePath, "utf8");
  const allLines = raw.split("\n").filter((l) => l.trim().length > 0);

  if (allLines.length === 0) {
    return { ok: true, lines: [] };
  }

  let header: EncryptedFileHeader;
  try {
    header = JSON.parse(allLines[0]!) as EncryptedFileHeader;
  } catch (err) {
    return { ok: false, error: `Malformed encryption header: ${String(err)}` };
  }

  if (header.type !== ENCRYPTED_HEADER_TYPE) {
    return { ok: false, error: "Unexpected header type" };
  }

  const salt = Buffer.from(header.salt, "hex");
  const key = await deriveKey(passphrase, salt, header.iter);

  const plainLines: string[] = [];
  const encryptedLines = allLines.slice(1); // skip header

  for (let i = 0; i < encryptedLines.length; i++) {
    const encoded = encryptedLines[i];
    try {
      plainLines.push(decryptLine(encoded!, key));
    } catch (err) {
      return {
        ok: false,
        error: `Failed to decrypt line ${i + 1}: ${err instanceof Error ? err.message : String(err)} — wrong passphrase?`,
      };
    }
  }

  return { ok: true, lines: plainLines };
}

/**
 * Decrypt an encrypted session file back to plain-text JSONL in-place.
 * This is the reverse operation of `encryptSessionFile`.
 */
export async function decryptSessionFileInPlace(
  params: DecryptSessionFileParams,
): Promise<SessionEncryptResult> {
  const result = await decryptSessionFile(params);
  if (!result.ok) {
    return result;
  }

  const output = result.lines.join("\n") + (result.lines.length > 0 ? "\n" : "");
  const tmpPath = `${params.filePath}.decrypting`;

  try {
    writeFileSync(tmpPath, output, { mode: 0o600, encoding: "utf8" });
    renameSync(tmpPath, params.filePath);
    return { ok: true, linesProcessed: result.lines.length };
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `Failed to write decrypted file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Encrypt all session JSONL files in a directory tree.
 * Skips already-encrypted files.
 *
 * @returns Summary of files processed, skipped, and failed.
 */
export async function encryptSessionDirectory(params: {
  dirPath: string;
  passphrase: string;
  iterations?: number;
}): Promise<{
  encrypted: number;
  skipped: number;
  failed: Array<{ file: string; error: string }>;
}> {
  const { dirPath, passphrase, iterations } = params;
  let encrypted = 0;
  let skipped = 0;
  const failed: Array<{ file: string; error: string }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const result = await encryptSessionFile({ filePath: full, passphrase, iterations });
        if (!result.ok) {
          if (result.error === ERR_ALREADY_ENCRYPTED) {
            skipped++;
          } else {
            failed.push({ file: full, error: result.error });
          }
        } else {
          encrypted++;
        }
      }
    }
  }

  await walk(dirPath);
  return { encrypted, skipped, failed };
}
