import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { replaceFileAtomicSync } from "./replace-file.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { transformHistoricalTranscriptEvent } from "./state-migrations.transcript-directives-transform.js";

export const TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE = 32;

type TranscriptArchiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_archives"
>;

type ArchiveCursor = { generation: string; sessionId: string };

type ArchiveRowPlan = {
  archiveName: string;
  archiveSha256: string;
  bytes: Buffer;
  changed: boolean;
  encoding: "identity" | "zstd";
  generation: string;
  nextBytes: Buffer;
  nextSha256: string;
  publishedAt: number | null;
  sessionId: string;
};

function parseTranscriptEvent(raw: string, owner: string): TranscriptEvent {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner} contains invalid transcript JSON`, { cause: error });
  }
}

function transformArchiveContent(
  content: string,
  owner: string,
): {
  changed: boolean;
  content: string;
} {
  if (!content) {
    return { changed: false, content };
  }
  const trailingNewline = content.endsWith("\n");
  const lines = trailingNewline ? content.slice(0, -1).split("\n") : content.split("\n");
  let changed = false;
  const rewritten = lines.map((line, index) => {
    if (!line) {
      throw new Error(`${owner} contains a blank JSONL record at line ${index + 1}`);
    }
    const event = parseTranscriptEvent(line, `${owner}:${index + 1}`);
    const transformed = transformHistoricalTranscriptEvent(event);
    changed ||= transformed.changed;
    return transformed.changed ? JSON.stringify(transformed.event) : line;
  });
  return {
    changed,
    content: `${rewritten.join("\n")}${trailingNewline ? "\n" : ""}`,
  };
}

function encodeArchiveContent(
  content: string,
  encoding: "identity" | "zstd",
  owner: string,
): Buffer {
  if (encoding === "identity") {
    return Buffer.from(content, "utf8");
  }
  const encoded = encodeSessionArchiveContent(content);
  if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error(`${owner} could not be re-encoded with its zstd codec`);
  }
  return encoded.bytes;
}

function readArchiveEncoding(value: string, owner: string): "identity" | "zstd" {
  if (value === "identity" || value === "zstd") {
    return value;
  }
  throw new Error(`${owner} has unsupported transcript archive encoding ${value}`);
}

function listArchiveBatch(database: DatabaseSync, cursor: ArchiveCursor): ArchiveRowPlan[] {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  let query = db
    .selectFrom("session_transcript_archives")
    .select([
      "archive_blob",
      "archive_name",
      "archive_sha256",
      "encoding",
      "generation",
      "published_at",
      "session_id",
    ])
    .orderBy("session_id", "asc")
    .orderBy("generation", "asc")
    .limit(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE);
  if (cursor.sessionId) {
    query = query.where((eb) =>
      eb.or([
        eb("session_id", ">", cursor.sessionId),
        eb.and([eb("session_id", "=", cursor.sessionId), eb("generation", ">", cursor.generation)]),
      ]),
    );
  }
  return executeSqliteQuerySync(database, query).rows.map((row) => {
    const owner = `${row.session_id}:${row.generation}`;
    const encoding = readArchiveEncoding(row.encoding, owner);
    const bytes = Buffer.from(row.archive_blob);
    if (createHash("sha256").update(bytes).digest("hex") !== row.archive_sha256) {
      throw new Error(`Canonical SQLite transcript archive is corrupt for ${row.session_id}`);
    }
    const content = decodeSessionArchiveBytes(bytes, encoding === "zstd");
    const transformed = transformArchiveContent(content, owner);
    const nextBytes = transformed.changed
      ? encodeArchiveContent(transformed.content, encoding, owner)
      : bytes;
    return {
      archiveName: row.archive_name,
      archiveSha256: row.archive_sha256,
      bytes,
      changed: transformed.changed,
      encoding,
      generation: row.generation,
      nextBytes,
      nextSha256: createHash("sha256").update(nextBytes).digest("hex"),
      publishedAt: row.published_at,
      sessionId: row.session_id,
    };
  });
}

function assertArchiveSourceUnchanged(database: DatabaseSync, planned: ArchiveRowPlan): boolean {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const current = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_transcript_archives")
      .select(["archive_blob", "archive_name", "archive_sha256", "encoding"])
      .where("session_id", "=", planned.sessionId)
      .where("generation", "=", planned.generation),
  );
  if (!current) {
    return false;
  }
  if (
    current.archive_name !== planned.archiveName ||
    current.archive_sha256 !== planned.archiveSha256 ||
    current.encoding !== planned.encoding ||
    !Buffer.from(current.archive_blob).equals(planned.bytes)
  ) {
    throw new Error(
      `Transcript archive source changed before migration commit for ${planned.sessionId}`,
    );
  }
  return true;
}

function rewriteArchiveRow(database: DatabaseSync, planned: ArchiveRowPlan): boolean {
  if (!assertArchiveSourceUnchanged(database, planned)) {
    return false;
  }
  if (!planned.changed) {
    return true;
  }
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const result = executeSqliteQuerySync(
    database,
    db
      .updateTable("session_transcript_archives")
      .set({
        archive_blob: planned.nextBytes,
        archive_sha256: planned.nextSha256,
        published_at: null,
      })
      .where("session_id", "=", planned.sessionId)
      .where("generation", "=", planned.generation)
      .where("archive_sha256", "=", planned.archiveSha256),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Transcript archive changed before rewrite for ${planned.sessionId}`);
  }
  return true;
}

function repairPublishedArchiveFile(params: {
  archiveDirectory: string;
  planned: ArchiveRowPlan;
}): boolean {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(archiveDirectory, params.planned.archiveName);
  if (
    path.dirname(archivePath) !== archiveDirectory ||
    path.basename(archivePath) !== params.planned.archiveName
  ) {
    throw new Error(`Cannot migrate transcript archive outside ${archiveDirectory}`);
  }
  if (!fs.existsSync(archivePath)) {
    return false;
  }
  if (
    createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex") ===
    params.planned.nextSha256
  ) {
    return true;
  }
  replaceFileAtomicSync({
    beforeRename: ({ tempPath }) => {
      const stagedHash = createHash("sha256").update(fs.readFileSync(tempPath)).digest("hex");
      if (stagedHash !== params.planned.nextSha256) {
        throw new Error(`Transcript archive staging verification failed for ${archivePath}`);
      }
    },
    content: params.planned.nextBytes,
    filePath: archivePath,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(archivePath)}.directive-migration`,
  });
  if (
    createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex") !==
    params.planned.nextSha256
  ) {
    throw new Error(`Transcript archive verification failed for ${archivePath}`);
  }
  return true;
}

function finalizeArchiveCursor(params: {
  database: DatabaseSync;
  fileCurrent: boolean;
  planned: ArchiveRowPlan;
  writeCursor: (cursor: ArchiveCursor | { phase: "complete" }) => void;
}): void {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(params.database);
  const current = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("session_transcript_archives")
      .select(["archive_blob", "archive_sha256"])
      .where("session_id", "=", params.planned.sessionId)
      .where("generation", "=", params.planned.generation),
  );
  if (current) {
    if (
      current.archive_sha256 !== params.planned.nextSha256 ||
      !Buffer.from(current.archive_blob).equals(params.planned.nextBytes)
    ) {
      throw new Error(
        `Transcript archive changed before migration commit for ${params.planned.sessionId}`,
      );
    }
    if (params.planned.changed && params.planned.publishedAt !== null && params.fileCurrent) {
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("session_transcript_archives")
          .set({ published_at: params.planned.publishedAt })
          .where("session_id", "=", params.planned.sessionId)
          .where("generation", "=", params.planned.generation)
          .where("archive_sha256", "=", params.planned.nextSha256),
      );
    }
  }
  params.writeCursor({
    generation: params.planned.generation,
    sessionId: params.planned.sessionId,
  });
}

export function migrateTranscriptDirectiveArchives(params: {
  agentId: string;
  database: DatabaseSync;
  pathname: string;
  start: ArchiveCursor;
  writeCursor: (cursor: ArchiveCursor | { phase: "complete" }) => void;
}): number {
  let rewrittenArchives = 0;
  let cursor = params.start;
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: params.agentId,
    path: params.pathname,
  });
  while (true) {
    const batch = listArchiveBatch(params.database, cursor);
    if (batch.length === 0) {
      runSqliteImmediateTransactionSync(params.database, () => {
        params.writeCursor({ phase: "complete" });
      });
      return rewrittenArchives;
    }
    for (const planned of batch) {
      const rowPresent = runSqliteImmediateTransactionSync(
        params.database,
        () => rewriteArchiveRow(params.database, planned),
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "historical-transcript-archive-directives",
        },
      );
      const fileCurrent = rowPresent
        ? repairPublishedArchiveFile({ archiveDirectory, planned })
        : false;
      runSqliteImmediateTransactionSync(
        params.database,
        () =>
          finalizeArchiveCursor({
            database: params.database,
            fileCurrent,
            planned,
            writeCursor: params.writeCursor,
          }),
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "historical-transcript-archive-cursor",
        },
      );
      rewrittenArchives += planned.changed && rowPresent ? 1 : 0;
      cursor = { generation: planned.generation, sessionId: planned.sessionId };
    }
  }
}
