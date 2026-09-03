/** Worker entrypoint for SQLite transcript archive materialization off the gateway event loop. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort, workerData } from "node:worker_threads";
import zlib from "node:zlib";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  settleOpenClawAgentDatabaseWorkerClose,
  type OpenClawAgentDatabaseWorkerCloseResult,
} from "../../state/openclaw-agent-db.js";
import {
  hashSessionArchiveBytes,
  MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES,
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
  type TranscriptArchivePublishPlan,
  type TranscriptArchivePublishResult,
  type TranscriptArchivePublishWorkerMessage,
  type TranscriptArchiveWorkerMessage,
  type TranscriptArchiveWorkerPlan,
  type TranscriptArchiveWorkerResult,
} from "./session-accessor.sqlite-archive.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import {
  reclaimSqliteSessionInTransaction,
  type SqliteSessionReclamationWorkerData,
  type SqliteSessionReclamationWorkerResult,
} from "./session-accessor.sqlite-reclamation.js";

type TranscriptArchiveDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_archives" | "transcript_events"
>;

const WORKER_CLOSE_MAX_ATTEMPTS = 3;

async function settleReclamationDatabase(
  pathname: string,
): Promise<{ cleanupWarnings: string[]; settled: boolean }> {
  const warnings = new Set<string>();
  let outcome: OpenClawAgentDatabaseWorkerCloseResult = { errors: [], settled: false };
  for (let attempt = 0; attempt < WORKER_CLOSE_MAX_ATTEMPTS; attempt += 1) {
    outcome = settleOpenClawAgentDatabaseWorkerClose(pathname);
    outcome.errors.forEach((error) => warnings.add(error.message));
    if (outcome.settled) {
      break;
    }
    if (attempt + 1 < WORKER_CLOSE_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * 2 ** attempt);
      });
    }
  }
  return { cleanupWarnings: [...warnings], settled: outcome.settled };
}

function isSqliteTranscriptArchiveWorkerData(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "sqlite-transcript-archive-v2"
  );
}

function parsePublishWorkerPlans(value: unknown): TranscriptArchivePublishPlan[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const plans = (value as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) {
    return undefined;
  }
  const parsed: TranscriptArchivePublishPlan[] = [];
  for (const planValue of plans) {
    if (!planValue || typeof planValue !== "object" || Array.isArray(planValue)) {
      return undefined;
    }
    const plan = planValue as Record<string, unknown>;
    if (
      typeof plan.agentId !== "string" ||
      typeof plan.archiveDirectory !== "string" ||
      typeof plan.databasePath !== "string" ||
      typeof plan.generation !== "string" ||
      typeof plan.sessionId !== "string"
    ) {
      return undefined;
    }
    parsed.push({
      agentId: plan.agentId,
      archiveDirectory: plan.archiveDirectory,
      databasePath: plan.databasePath,
      generation: plan.generation,
      sessionId: plan.sessionId,
    });
  }
  return parsed;
}

function parseSessionStateDeleteSnapshot(value: unknown): SessionStateDeleteSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.acpParentStreamEventCount !== "number" ||
    (snapshot.generation !== null && typeof snapshot.generation !== "string") ||
    (snapshot.lastSeq !== null && typeof snapshot.lastSeq !== "number") ||
    (snapshot.sessionKey !== null && typeof snapshot.sessionKey !== "string") ||
    (snapshot.sessionUpdatedAt !== null && typeof snapshot.sessionUpdatedAt !== "number") ||
    (snapshot.trajectoryLastSeq !== null && typeof snapshot.trajectoryLastSeq !== "number") ||
    (snapshot.transcriptUpdatedAt !== null && typeof snapshot.transcriptUpdatedAt !== "number")
  ) {
    return null;
  }
  return {
    acpParentStreamEventCount: snapshot.acpParentStreamEventCount,
    generation: snapshot.generation,
    lastSeq: snapshot.lastSeq,
    sessionKey: snapshot.sessionKey,
    sessionUpdatedAt: snapshot.sessionUpdatedAt,
    trajectoryLastSeq: snapshot.trajectoryLastSeq,
    transcriptUpdatedAt: snapshot.transcriptUpdatedAt,
  };
}

function parseWorkerPlans(value: unknown): TranscriptArchiveWorkerPlan[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const plans = (value as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) {
    return undefined;
  }
  const parsed: TranscriptArchiveWorkerPlan[] = [];
  for (const planValue of plans) {
    if (!planValue || typeof planValue !== "object" || Array.isArray(planValue)) {
      return undefined;
    }
    const plan = planValue as Record<string, unknown>;
    const snapshot = parseSessionStateDeleteSnapshot(plan.snapshot);
    if (
      typeof plan.agentId !== "string" ||
      typeof plan.archiveDirectory !== "string" ||
      typeof plan.databasePath !== "string" ||
      (plan.reason !== "deleted" && plan.reason !== "reset") ||
      typeof plan.sessionId !== "string" ||
      !snapshot
    ) {
      return undefined;
    }
    parsed.push({
      agentId: plan.agentId,
      archiveDirectory: plan.archiveDirectory,
      databasePath: plan.databasePath,
      reason: plan.reason,
      sessionId: plan.sessionId,
      snapshot,
    });
  }
  return parsed;
}

function stageTranscriptArchiveContent(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
  stagedPath: string,
): number {
  const fd = fs.openSync(stagedPath, "wx", 0o600);
  let rowCount = 0;
  try {
    const query = "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC";
    const rows = database /* sqlite-allow-raw: the iterator keeps one row in memory at a time. */
      .prepare(query)
      .iterate(sessionId);
    for (const row of rows) {
      if (typeof row.event_json !== "string") {
        throw new Error(`Invalid transcript event row for ${sessionId}`);
      }
      fs.writeFileSync(fd, row.event_json);
      fs.writeFileSync(fd, "\n");
      rowCount += 1;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return rowCount;
}

function createArchiveByteLimitTransform(): Transform {
  let encodedBytes = 0;
  return new Transform({
    transform(chunk: unknown, encoding, callback) {
      let chunkBytes: number;
      if (typeof chunk === "string") {
        chunkBytes = Buffer.byteLength(chunk, encoding);
      } else if (chunk instanceof Uint8Array) {
        chunkBytes = chunk.byteLength;
      } else {
        callback(new TypeError("Archive encoder emitted an unsupported chunk type"));
        return;
      }
      encodedBytes += chunkBytes;
      if (encodedBytes > MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES) {
        callback(
          new Error(
            `Archive exceeds ${MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES} bytes during encoding`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}
async function encodeStagedTranscriptArchive(params: {
  archiveDirectory: string;
  generation: string;
  reason: "deleted" | "reset";
  sessionId: string;
  stagedPath: string;
}): Promise<NonNullable<TranscriptArchiveWorkerResult["archive"]>> {
  const createdAt = Date.now();
  const optionalZlib: Partial<typeof zlib> = zlib;
  const createZstdCompress = optionalZlib.createZstdCompress;
  const compressed = typeof createZstdCompress === "function";
  const archivePath = `${resolveSqliteTranscriptArchivePath({
    archiveDirectory: params.archiveDirectory,
    generation: params.generation,
    identityOwner: "registry",
    reason: params.reason,
    sessionId: params.sessionId,
    nowMs: createdAt,
  })}${compressed ? ".zst" : ""}`;
  const encodedPath = `${archivePath}.${randomUUID()}.stage`;
  try {
    if (compressed) {
      await pipeline(
        fs.createReadStream(params.stagedPath),
        createZstdCompress.call(zlib),
        createArchiveByteLimitTransform(),
        fs.createWriteStream(encodedPath, { flags: "wx", mode: 0o600 }),
      );
    } else {
      await pipeline(
        fs.createReadStream(params.stagedPath),
        createArchiveByteLimitTransform(),
        fs.createWriteStream(encodedPath, { flags: "wx", mode: 0o600 }),
      );
    }
    const bytes = fs.readFileSync(encodedPath);
    return {
      archiveName: path.basename(archivePath),
      bytes,
      createdAt,
      encoding: compressed ? "zstd" : "identity",
      sha256: hashSessionArchiveBytes(bytes),
    };
  } finally {
    fs.rmSync(encodedPath, { force: true });
  }
}

export async function materializeTranscriptArchiveInWorker(
  plan: TranscriptArchiveWorkerPlan,
): Promise<TranscriptArchiveWorkerResult> {
  fs.mkdirSync(plan.archiveDirectory, { recursive: true, mode: 0o700 });
  const stagedPath = `${resolveSqliteTranscriptArchivePath({
    archiveDirectory: plan.archiveDirectory,
    generation: plan.snapshot.generation ?? undefined,
    identityOwner: "registry",
    reason: plan.reason,
    sessionId: plan.sessionId,
  })}.${randomUUID()}.jsonl-stage`;
  try {
    const opened = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        let transactionOpen = false;
        try {
          // sqlite-allow-raw: metadata and transcript rows must come from one read snapshot.
          database.db.exec("BEGIN");
          transactionOpen = true;
          const snapshot = readSessionStateDeleteSnapshot(database.db, plan.sessionId);
          if (!sqliteSessionStateDeleteSnapshotsEqual(snapshot, plan.snapshot)) {
            throw new Error(
              `SQLite session state changed before archive materialization for ${plan.sessionId}`,
            );
          }
          const rowCount = stageTranscriptArchiveContent(database.db, plan.sessionId, stagedPath);
          database.db.exec("COMMIT"); // sqlite-allow-raw: closes the consistent read snapshot.
          transactionOpen = false;
          return { rowCount, snapshot };
        } catch (error) {
          if (transactionOpen) {
            database.db.exec("ROLLBACK"); // sqlite-allow-raw: releases a failed read snapshot.
          }
          throw error;
        }
      },
      { agentId: plan.agentId, path: plan.databasePath },
    );
    if (!opened.found) {
      throw new Error(
        `Cannot archive SQLite transcript ${plan.sessionId}: ${opened.reason.replaceAll("-", " ")}`,
      );
    }
    const generation = plan.snapshot.generation;
    if (opened.value.rowCount > 0 && !generation) {
      throw new Error(
        `Cannot archive SQLite transcript without a generation for ${plan.sessionId}`,
      );
    }
    const archive =
      opened.value.rowCount > 0 && generation
        ? await encodeStagedTranscriptArchive({
            archiveDirectory: plan.archiveDirectory,
            generation,
            reason: plan.reason,
            sessionId: plan.sessionId,
            stagedPath,
          })
        : null;
    return { archive, sessionId: plan.sessionId };
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
}

export function publishTranscriptArchiveInWorker(
  plan: TranscriptArchivePublishPlan,
): TranscriptArchivePublishResult {
  try {
    const opened = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database.db);
        return executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_transcript_archives")
            .select(["archive_blob", "archive_name", "archive_sha256"])
            .where("session_id", "=", plan.sessionId)
            .where("generation", "=", plan.generation),
        ).rows[0];
      },
      { agentId: plan.agentId, path: plan.databasePath },
    );
    if (!opened.found || !opened.value) {
      throw new Error(`Canonical SQLite transcript archive is missing for ${plan.sessionId}`);
    }
    if (hashSessionArchiveBytes(opened.value.archive_blob) !== opened.value.archive_sha256) {
      throw new Error(`Canonical SQLite transcript archive is corrupt for ${plan.sessionId}`);
    }
    return {
      archivedPath: publishEncodedSessionTranscriptArchive({
        archiveDirectory: plan.archiveDirectory,
        archiveName: opened.value.archive_name,
        bytes: opened.value.archive_blob,
        sha256: opened.value.archive_sha256,
      }),
      generation: plan.generation,
      sessionId: plan.sessionId,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      generation: plan.generation,
      sessionId: plan.sessionId,
    };
  }
}

async function runWorkerPort(
  port: NonNullable<typeof parentPort>,
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<void> {
  let materializedBytes = 0;
  for (const plan of plans) {
    const result = await materializeTranscriptArchiveInWorker(plan);
    materializedBytes += result.archive?.bytes.byteLength ?? 0;
    if (materializedBytes > MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES) {
      throw new Error(
        `Archive batch exceeds ${MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES} bytes; use fewer sessions`,
      );
    }
    port.postMessage({ type: "done", results: [result] } satisfies TranscriptArchiveWorkerMessage);
  }
  port.close();
}

function runPublishWorkerPort(
  port: NonNullable<typeof parentPort>,
  plans: readonly TranscriptArchivePublishPlan[],
): void {
  const results = plans.map((plan) => publishTranscriptArchiveInWorker(plan));
  port.postMessage({ type: "published", results } satisfies TranscriptArchivePublishWorkerMessage);
  port.close();
}

async function runReclamationWorkerPort(
  port: NonNullable<typeof parentPort>,
  data: SqliteSessionReclamationWorkerData,
): Promise<void> {
  let result: ReturnType<typeof reclaimSqliteSessionInTransaction>;
  try {
    result = reclaimSqliteSessionInTransaction(data.plan);
  } catch (error) {
    const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
    if (!cleanup.settled) {
      throw new AggregateError(
        [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
        "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
        { cause: error },
      );
    }
    throw error;
  }
  const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
  const workerResult: SqliteSessionReclamationWorkerResult = {
    result,
    ...(cleanup.cleanupWarnings.length > 0 ? { cleanupWarnings: cleanup.cleanupWarnings } : {}),
    ...(!cleanup.settled ? { cleanupIncomplete: true } : {}),
  };
  port.postMessage({ type: "reclaimed", results: [workerResult] });
  port.close();
}

if (isSqliteTranscriptArchiveWorkerData(workerData)) {
  if (!parentPort) {
    throw new Error("SQLite transcript archive worker requires a parent port");
  }
  const operation = (workerData as { operation?: unknown }).operation;
  if (operation === "materialize") {
    const plans = parseWorkerPlans(workerData);
    if (!plans) {
      throw new Error("SQLite transcript archive worker requires valid materialization data");
    }
    await runWorkerPort(parentPort, plans);
  } else if (operation === "publish") {
    const plans = parsePublishWorkerPlans(workerData);
    if (!plans) {
      throw new Error("SQLite transcript archive worker requires valid publication data");
    }
    runPublishWorkerPort(parentPort, plans);
  } else if (operation === "reclaim") {
    // SAFETY: the parent creates this internal structured-clone payload from the typed plan.
    await runReclamationWorkerPort(parentPort, workerData as SqliteSessionReclamationWorkerData);
  } else {
    throw new Error("SQLite transcript archive worker requires a supported operation");
  }
}
