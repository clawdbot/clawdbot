/** Worker entrypoint for SQLite transcript archive materialization off the gateway event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  sqliteSessionStateDeleteSnapshotsEqual,
  type SqliteSessionStateDeleteSnapshot,
  type SqliteTranscriptArchiveWorkerMessage,
  type SqliteTranscriptArchiveWorkerPlan,
  type SqliteTranscriptArchiveWorkerResult,
  writeSqliteTranscriptArchive,
} from "./session-accessor.sqlite-archive.js";
import { readSqliteSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { serializeJsonlLines } from "./transcript-jsonl.js";

type TranscriptArchiveDatabase = Pick<OpenClawAgentKyselyDatabase, "transcript_events">;

function isSqliteTranscriptArchiveWorkerData(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "sqlite-transcript-archive-v1"
  );
}

function parseSessionStateDeleteSnapshot(value: unknown): SqliteSessionStateDeleteSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.acpParentStreamEventCount !== "number" ||
    (snapshot.generation !== null && typeof snapshot.generation !== "string") ||
    (snapshot.lastSeq !== null && typeof snapshot.lastSeq !== "number") ||
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
    sessionUpdatedAt: snapshot.sessionUpdatedAt,
    trajectoryLastSeq: snapshot.trajectoryLastSeq,
    transcriptUpdatedAt: snapshot.transcriptUpdatedAt,
  };
}

function parseWorkerPlans(value: unknown): SqliteTranscriptArchiveWorkerPlan[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const plans = (value as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) {
    return undefined;
  }
  const parsed: SqliteTranscriptArchiveWorkerPlan[] = [];
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

export function materializeSqliteTranscriptArchiveInWorker(
  plan: SqliteTranscriptArchiveWorkerPlan,
): SqliteTranscriptArchiveWorkerResult {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      let transactionOpen = false;
      try {
        // sqlite-allow-raw: metadata and transcript rows must come from one read snapshot.
        database.db.exec("BEGIN");
        transactionOpen = true;
        const snapshot = readSqliteSessionStateDeleteSnapshot(database.db, plan.sessionId);
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
  const archivedPath =
    content.length > 0
      ? writeSqliteTranscriptArchive({
          archiveDirectory: plan.archiveDirectory,
          content,
          reason: plan.reason,
          sessionId: plan.sessionId,
        })
      : null;
  return { archivedPath, sessionId: plan.sessionId };
}

function runWorkerPort(
  port: NonNullable<typeof parentPort>,
  plans: readonly SqliteTranscriptArchiveWorkerPlan[],
): void {
  const results = plans.map((plan) => materializeSqliteTranscriptArchiveInWorker(plan));
  port.postMessage({ type: "done", results } satisfies SqliteTranscriptArchiveWorkerMessage);
  port.close();
}

if (isSqliteTranscriptArchiveWorkerData(workerData)) {
  if (!parentPort) {
    throw new Error("SQLite transcript archive worker requires a parent port");
  }
  const plans = parseWorkerPlans(workerData);
  if (!plans) {
    throw new Error("SQLite transcript archive worker requires valid worker data");
  }
  runWorkerPort(parentPort, plans);
}
