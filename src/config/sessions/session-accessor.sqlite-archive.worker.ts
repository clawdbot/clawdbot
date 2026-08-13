/** Worker entrypoint for SQLite transcript archive materialization off the gateway event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnlyAsync } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  sqliteSessionStateDeleteSnapshotsEqual,
  type SessionStateDeleteSnapshot,
  type TranscriptArchiveWorkerMessage,
  type TranscriptArchiveWorkerPlan,
  type TranscriptArchiveWorkerResult,
  writeTranscriptArchive,
} from "./session-accessor.sqlite-archive.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";

type TranscriptArchiveDatabase = Pick<OpenClawAgentKyselyDatabase, "transcript_events">;

const TRANSCRIPT_ARCHIVE_ROW_BATCH_SIZE = 16;

type TranscriptArchiveWorkerHooks = {
  afterBatchRead?: (batchIndex: number) => void;
};

function isSqliteTranscriptArchiveWorkerData(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "sqlite-transcript-archive-v1"
  );
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

const TRANSCRIPT_ARCHIVE_NEWLINE = Buffer.from("\n");

function* iterateTranscriptArchiveContent(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
  snapshotLastSeq: number,
  hooks?: TranscriptArchiveWorkerHooks,
): IterableIterator<Buffer> {
  const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database);
  let afterSeq: number | null = null;
  let batchIndex = 0;
  for (;;) {
    let query = db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .where("seq", "<=", snapshotLastSeq)
      .orderBy("seq", "asc")
      .limit(TRANSCRIPT_ARCHIVE_ROW_BATCH_SIZE);
    if (afterSeq !== null) {
      query = query.where("seq", ">", afterSeq);
    }
    // Materialize one bounded batch so no SQLite statement remains open while
    // compression or filesystem backpressure suspends this generator.
    const rows = executeSqliteQuerySync(database, query).rows;
    if (rows.length === 0) {
      return;
    }
    hooks?.afterBatchRead?.(batchIndex);
    for (const row of rows) {
      yield Buffer.from(row.event_json, "utf8");
      yield TRANSCRIPT_ARCHIVE_NEWLINE;
    }
    afterSeq = rows.at(-1)?.seq ?? null;
    batchIndex += 1;
    if (rows.length < TRANSCRIPT_ARCHIVE_ROW_BATCH_SIZE) {
      return;
    }
  }
}

function assertArchiveSnapshotCurrent(
  database: import("node:sqlite").DatabaseSync,
  plan: TranscriptArchiveWorkerPlan,
  phase: "before" | "during",
): void {
  const snapshot = readSessionStateDeleteSnapshot(database, plan.sessionId);
  if (!sqliteSessionStateDeleteSnapshotsEqual(snapshot, plan.snapshot)) {
    throw new Error(
      `SQLite session state changed ${phase} archive materialization for ${plan.sessionId}`,
    );
  }
}

export async function materializeTranscriptArchiveInWorker(
  plan: TranscriptArchiveWorkerPlan,
  hooks?: TranscriptArchiveWorkerHooks,
): Promise<TranscriptArchiveWorkerResult> {
  const opened = await withOpenClawAgentDatabaseReadOnlyAsync(
    async (database) => {
      assertArchiveSnapshotCurrent(database.db, plan, "before");
      const snapshotLastSeq = plan.snapshot.lastSeq;
      if (snapshotLastSeq === null) {
        return null;
      }
      return await writeTranscriptArchive({
        archiveDirectory: plan.archiveDirectory,
        contentChunks: iterateTranscriptArchiveContent(
          database.db,
          plan.sessionId,
          snapshotLastSeq,
          hooks,
        ),
        reason: plan.reason,
        sessionId: plan.sessionId,
        validateSource: () => assertArchiveSnapshotCurrent(database.db, plan, "during"),
      });
    },
    { agentId: plan.agentId, path: plan.databasePath },
  );
  if (!opened.found) {
    throw new Error(
      `Cannot archive SQLite transcript ${plan.sessionId}: ${opened.reason.replaceAll("-", " ")}`,
    );
  }
  return { archivedPath: opened.value, sessionId: plan.sessionId };
}

async function runWorkerPort(
  port: NonNullable<typeof parentPort>,
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<void> {
  const results: TranscriptArchiveWorkerResult[] = [];
  for (const plan of plans) {
    results.push(await materializeTranscriptArchiveInWorker(plan));
  }
  port.postMessage({ type: "done", results } satisfies TranscriptArchiveWorkerMessage);
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
  await runWorkerPort(parentPort, plans);
}
