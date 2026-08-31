/** Worker entrypoint for SQLite transcript archive materialization off the gateway event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  encodeMaterializedSessionTranscriptArchive,
  hashSessionArchiveBytes,
  MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES,
  publishEncodedSessionTranscriptArchive,
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
import { serializeJsonlLines } from "./transcript-jsonl.js";

type TranscriptArchiveDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_archives" | "transcript_events"
>;

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

function readTranscriptArchiveContent(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
): string {
  const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database);
  const lines = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => row.event_json);
  return serializeJsonlLines(lines);
}

export function materializeTranscriptArchiveInWorker(
  plan: TranscriptArchiveWorkerPlan,
): TranscriptArchiveWorkerResult {
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
        const content = readTranscriptArchiveContent(database.db, plan.sessionId);
        database.db.exec("COMMIT"); // sqlite-allow-raw: closes the consistent read snapshot.
        transactionOpen = false;
        return { content, snapshot };
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
  const { content } = opened.value;
  const generation = plan.snapshot.generation;
  if (content.length > 0 && !generation) {
    throw new Error(`Cannot archive SQLite transcript without a generation for ${plan.sessionId}`);
  }
  const archive =
    content.length > 0 && generation
      ? encodeMaterializedSessionTranscriptArchive({
          archiveDirectory: plan.archiveDirectory,
          content,
          generation,
          reason: plan.reason,
          sessionId: plan.sessionId,
        })
      : null;
  return { archive, sessionId: plan.sessionId };
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

function runWorkerPort(
  port: NonNullable<typeof parentPort>,
  plans: readonly TranscriptArchiveWorkerPlan[],
): void {
  let materializedBytes = 0;
  for (const plan of plans) {
    const result = materializeTranscriptArchiveInWorker(plan);
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
    runWorkerPort(parentPort, plans);
  } else if (operation === "publish") {
    const plans = parsePublishWorkerPlans(workerData);
    if (!plans) {
      throw new Error("SQLite transcript archive worker requires valid publication data");
    }
    runPublishWorkerPort(parentPort, plans);
  } else {
    throw new Error("SQLite transcript archive worker requires a supported operation");
  }
}
