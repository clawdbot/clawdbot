import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncDirectoryBestEffortSync } from "../../infra/directory-durability.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import {
  formatSessionArchiveTimestamp,
  isSessionArchiveArtifactName,
  type SessionArchiveReason,
} from "./artifacts.js";

export const MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES = 256 * 1024 * 1024;

// Leave room under the 255-byte component limit for timestamps, generations,
// compression suffixes, and staging UUIDs. Raising this can break publication.
const MAX_REGISTERED_ARCHIVE_SESSION_ID_BYTES = 96;

function resolveRegisteredArchiveSessionIdComponent(sessionId: string): string {
  if (Buffer.byteLength(sessionId, "utf8") <= MAX_REGISTERED_ARCHIVE_SESSION_ID_BYTES) {
    return sessionId;
  }
  return `session-${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  generation?: string;
  identityOwner: "filename" | "registry";
  reason: SessionArchiveReason;
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const generationSuffix = params.generation ? `.${params.generation}` : "";
  const sessionIdComponent =
    params.identityOwner === "registry"
      ? resolveRegisteredArchiveSessionIdComponent(params.sessionId)
      : params.sessionId;
  const archivePath = path.resolve(
    archiveDirectory,
    `${sessionIdComponent}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}${generationSuffix}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

export function resolveRegisteredSqliteTranscriptArchiveName(params: {
  createdAt: number;
  encoding: "identity" | "zstd";
  generation: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string {
  return path.basename(
    `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: ".",
      generation: params.generation,
      identityOwner: "registry",
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: params.createdAt,
    })}${params.encoding === "zstd" ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`,
  );
}

function findMatchingSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !isSessionArchiveArtifactName(entry)) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    const compressed = entry.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile()) {
        continue;
      }
      if (!compressed && stat.size !== Buffer.byteLength(params.content, "utf8")) {
        continue;
      }
      if (readSessionArchiveContentSync(archivePath) === params.content) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Writes or reuses a transcript archive and returns its durable path. */
export function writeTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string {
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const existing = findMatchingSqliteTranscriptArchive(params);
  if (existing) {
    return existing;
  }
  // Archives are the long-lived cold tier; compress when the runtime can so
  // keep-forever retention stays cheap. Plain JSONL is the Bun/older fallback.
  const encoded = encodeSessionArchiveContent(params.content);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const archivePath = `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: params.archiveDirectory,
      identityOwner: "filename",
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: Date.now() + attempt,
    })}${encoded.suffix}`;
    if (fs.existsSync(archivePath)) {
      continue;
    }
    const tempPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      writeDurableFileExclusive(tempPath, encoded.bytes);
      fs.renameSync(tempPath, archivePath);
      syncDirectoryBestEffortSync(params.archiveDirectory);
      // Full readback is bounded by the same single-generation content held by
      // this Worker (Node string limits cap both); a partial
      // or corrupt archive must fail here, before any rows are reclaimed.
      if (readSessionArchiveContentSync(archivePath) !== params.content) {
        fs.rmSync(archivePath, { force: true });
        throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
      }
      return archivePath;
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      // SAFETY: Only inspect an optional errno code; every other error is rethrown.
      if ((error as { code?: unknown })?.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
}

// Windows rejects fsync on read-only handles, so keep the exclusive writable
// descriptor open through both the write and durability boundary.
function writeDurableFileExclusive(filePath: string, content: Buffer): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function hashSessionArchiveBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Publishes one exact canonical archive without directory scans or replacement. */
export function publishEncodedSessionTranscriptArchive(params: {
  archiveDirectory: string;
  archiveName: string;
  bytes: Uint8Array;
  sha256: string;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(archiveDirectory, params.archiveName);
  if (
    path.dirname(archivePath) !== archiveDirectory ||
    path.basename(archivePath) !== params.archiveName
  ) {
    throw new Error(`Cannot publish SQLite transcript archive outside ${archiveDirectory}`);
  }
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archivePath)) {
    if (hashSessionArchiveBytes(fs.readFileSync(archivePath)) !== params.sha256) {
      throw new Error(`SQLite transcript archive collision for ${params.archiveName}`);
    }
    return archivePath;
  }

  const tempPath = `${archivePath}.${randomUUID()}.tmp`;
  writeDurableFileExclusive(tempPath, Buffer.from(params.bytes));
  try {
    fs.linkSync(tempPath, archivePath);
  } catch (error) {
    // SAFETY: linkSync throws a Node error; its optional errno code selects collisions.
    if ((error as { code?: unknown }).code !== "EEXIST") {
      throw error;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  syncDirectoryBestEffortSync(archiveDirectory);
  if (hashSessionArchiveBytes(fs.readFileSync(archivePath)) !== params.sha256) {
    throw new Error(`SQLite transcript archive verification failed for ${params.archiveName}`);
  }
  return archivePath;
}
