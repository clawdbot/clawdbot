import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import { formatSessionArchiveTimestamp, type SessionArchiveReason } from "./artifacts.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";

export type SqliteSessionStateDeletePlan = {
  archiveDirectory: string;
  archiveTranscript: boolean;
  content: string;
  hadTranscriptState: boolean;
  reason: "deleted" | "reset";
  sessionId: string;
};

export type MaterializedSqliteSessionStateDeletePlan = SqliteSessionStateDeletePlan & {
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};

function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  reason: SessionArchiveReason;
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(
    archiveDirectory,
    `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
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
    if (!entry.startsWith(prefix)) {
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
export function writeSqliteTranscriptArchive(params: {
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
      fsyncDirectory(params.archiveDirectory);
      // Full readback is bounded by the same single-generation content the
      // delete plan already buffers (Node string limits cap both); a partial
      // or corrupt archive must fail here, before any rows are reclaimed.
      if (readSessionArchiveContentSync(archivePath) !== params.content) {
        fs.rmSync(archivePath, { force: true });
        throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
      }
      return archivePath;
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
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

function fsyncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every supported platform/filesystem.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// Runs duplicate probing, archive write, rename, and fsync outside SQLite
// write transactions; deletion later consumes this durable proof.
export function materializeSqliteSessionStateDeletePlans(
  plans: readonly SqliteSessionStateDeletePlan[],
): MaterializedSqliteSessionStateDeletePlan[] {
  return dedupeSqliteSessionStateDeletePlans(plans).map((plan) => {
    // Empty content means no transcript to preserve (e.g. trajectory-only
    // sessions). Writing a verified-but-empty archive would fake extraction;
    // trajectory runtime events are diagnostic telemetry and are reclaimed
    // without an archive artifact.
    const archivedTranscript =
      plan.archiveTranscript && plan.content.length > 0
        ? {
            archivedPath: writeSqliteTranscriptArchive({
              archiveDirectory: plan.archiveDirectory,
              content: plan.content,
              reason: plan.reason,
              sessionId: plan.sessionId,
            }),
            sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
          }
        : null;
    return Object.assign({}, plan, { archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session. If any owner
// asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SqliteSessionStateDeletePlan[],
): SqliteSessionStateDeletePlan[] {
  const deduped = new Map<string, SqliteSessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (existing.content !== plan.content || existing.reason !== plan.reason) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}
