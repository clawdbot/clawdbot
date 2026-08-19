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
import { readAuthorizedTranscriptEventSeqs } from "./session-transcript-memory-policy.js";
import { serializeJsonlLines } from "./transcript-jsonl.js";

type TranscriptArchiveDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_memory_subject_snapshots"
  | "transcript_events"
  | "transcript_event_memory_policies"
  | "transcript_event_memory_policy_details"
  | "transcript_event_memory_policy_transitions"
>;

const TRANSCRIPT_MEMORY_POLICY_ARCHIVE_RECORD_TYPE = "openclaw.memory-policy-archive-v1";

type TranscriptMemoryPolicyArchiveRecord = Readonly<{
  agentId: string;
  type: typeof TRANSCRIPT_MEMORY_POLICY_ARCHIVE_RECORD_TYPE;
  version: 1;
  sessionId: string;
  eventSeq: number;
  subject: Readonly<{
    sessionKey: string;
    sessionIdentityRevision: string;
    subjectRevision: string;
  }>;
  policy: Readonly<{
    contextFingerprint: string;
    deliveryAudiencesJson: string;
    runExposureRevision: number;
    runExposureSetId: string;
    runId: string;
    sourcePolicySetId: string;
  }>;
  detail: Readonly<{
    actorEvidenceJson: string;
    delegationSnapshotJson: string;
    egressReceiptIdsJson: string;
    exposedResourceRevisionsJson: string;
    exposureReceiptIdsJson: string;
    finalizedDeliveryAudiencesJson: string;
    normalizedAudienceIntersectionJson: string;
    sourceEventSeq: number;
    sourceSessionId: string;
  }>;
  transition?: Readonly<{
    sourceEventSeq: number;
    sourceSessionId: string;
    sourceSessionIdentityRevision: string;
    subjectRevision: string;
    targetSessionIdentityRevision: string;
    kind: string;
  }>;
}>;

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
  agentId: string,
  sessionId: string,
): string {
  const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database);
  const lines = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  // An archive is an export surface. Once cut over, a raw row without a
  // current companion label must not become a durable bypass of the replay fence.
  const authorizedSeqs = readAuthorizedTranscriptEventSeqs(database, sessionId);
  if (!authorizedSeqs) {
    return serializeJsonlLines(lines.map((row) => row.event_json));
  }
  const authorizedRows = lines.filter((row) => authorizedSeqs.has(row.seq));
  if (authorizedRows.length !== lines.length) {
    // Deletion must not turn a pending, stale, or revoked event into either a
    // durable raw bypass or silent data loss. Keep the source rows until an
    // explicit repair/confirmed import establishes their lineage.
    throw new Error(`Unauthorized transcript policy archive event for ${sessionId}`);
  }
  const records = readTranscriptMemoryPolicyArchiveRecords(
    database,
    agentId,
    sessionId,
    authorizedSeqs,
  );
  if (records.size !== authorizedRows.length) {
    // Policy-enforced archives are later import candidates. Refuse to emit any
    // raw event whose immutable companion cannot travel with its lineage.
    throw new Error(`Missing transcript policy archive companion for ${sessionId}`);
  }
  return serializeJsonlLines(
    authorizedRows.flatMap((row) => {
      const record = records.get(row.seq);
      if (!record) {
        throw new Error(`Missing transcript policy archive record for ${sessionId}:${row.seq}`);
      }
      return [row.event_json, JSON.stringify(record)];
    }),
  );
}

function readTranscriptMemoryPolicyArchiveRecords(
  database: import("node:sqlite").DatabaseSync,
  agentId: string,
  sessionId: string,
  authorizedSeqs: ReadonlySet<number>,
): ReadonlyMap<number, TranscriptMemoryPolicyArchiveRecord> {
  const db = getNodeSqliteKysely<TranscriptArchiveDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_event_memory_policies as policy")
      .innerJoin("transcript_event_memory_policy_details as detail", (join) =>
        join
          .onRef("detail.session_id", "=", "policy.session_id")
          .onRef("detail.event_seq", "=", "policy.event_seq"),
      )
      .innerJoin(
        "session_memory_subject_snapshots as subject",
        "subject.session_id",
        "policy.session_id",
      )
      .leftJoin("transcript_event_memory_policy_transitions as transition", (join) =>
        join
          .onRef("transition.session_id", "=", "policy.session_id")
          .onRef("transition.event_seq", "=", "policy.event_seq"),
      )
      .select([
        "policy.event_seq",
        "policy.context_fingerprint",
        "policy.delivery_audiences_json",
        "policy.run_exposure_revision",
        "policy.run_exposure_set_id",
        "policy.run_id",
        "policy.source_policy_set_id",
        "subject.session_identity_revision",
        "subject.session_key",
        "subject.subject_revision",
        "detail.actor_evidence_json",
        "detail.delegation_snapshot_json",
        "detail.egress_receipt_ids_json",
        "detail.exposed_resource_revisions_json",
        "detail.exposure_receipt_ids_json",
        "detail.finalized_delivery_audiences_json",
        "detail.normalized_audience_intersection_json",
        "detail.source_event_seq",
        "detail.source_session_id",
        "transition.source_event_seq as transition_source_event_seq",
        "transition.source_session_id as transition_source_session_id",
        "transition.source_session_identity_revision as transition_source_session_identity_revision",
        "transition.subject_revision as transition_subject_revision",
        "transition.target_session_identity_revision as transition_target_session_identity_revision",
        "transition.transition_kind",
      ])
      .where("policy.session_id", "=", sessionId)
      .where("policy.authorization_status", "=", "authorized")
      .where("detail.retention_state", "=", "retained"),
  ).rows;
  const records = new Map<number, TranscriptMemoryPolicyArchiveRecord>();
  for (const row of rows) {
    if (
      !authorizedSeqs.has(row.event_seq) ||
      row.context_fingerprint === null ||
      row.delivery_audiences_json === null ||
      row.run_exposure_revision === null ||
      row.run_exposure_set_id === null ||
      row.run_id === null ||
      row.source_policy_set_id === null ||
      row.source_event_seq === null ||
      row.source_session_id === null
    ) {
      continue;
    }
    const hasTransition = row.transition_source_session_id !== null;
    if (
      hasTransition &&
      (row.transition_source_event_seq === null ||
        row.transition_source_session_identity_revision === null ||
        row.transition_subject_revision === null ||
        row.transition_target_session_identity_revision === null ||
        row.transition_kind === null)
    ) {
      continue;
    }
    records.set(
      row.event_seq,
      Object.freeze({
        agentId,
        type: TRANSCRIPT_MEMORY_POLICY_ARCHIVE_RECORD_TYPE,
        version: 1,
        sessionId,
        eventSeq: row.event_seq,
        subject: Object.freeze({
          sessionKey: row.session_key,
          sessionIdentityRevision: row.session_identity_revision,
          subjectRevision: row.subject_revision,
        }),
        policy: Object.freeze({
          contextFingerprint: row.context_fingerprint,
          deliveryAudiencesJson: row.delivery_audiences_json,
          runExposureRevision: row.run_exposure_revision,
          runExposureSetId: row.run_exposure_set_id,
          runId: row.run_id,
          sourcePolicySetId: row.source_policy_set_id,
        }),
        detail: Object.freeze({
          actorEvidenceJson: row.actor_evidence_json,
          delegationSnapshotJson: row.delegation_snapshot_json,
          egressReceiptIdsJson: row.egress_receipt_ids_json,
          exposedResourceRevisionsJson: row.exposed_resource_revisions_json,
          exposureReceiptIdsJson: row.exposure_receipt_ids_json,
          finalizedDeliveryAudiencesJson: row.finalized_delivery_audiences_json,
          normalizedAudienceIntersectionJson: row.normalized_audience_intersection_json,
          sourceEventSeq: row.source_event_seq,
          sourceSessionId: row.source_session_id,
        }),
        ...(hasTransition
          ? {
              transition: Object.freeze({
                sourceEventSeq: row.transition_source_event_seq!,
                sourceSessionId: row.transition_source_session_id!,
                sourceSessionIdentityRevision: row.transition_source_session_identity_revision!,
                subjectRevision: row.transition_subject_revision!,
                targetSessionIdentityRevision: row.transition_target_session_identity_revision!,
                kind: row.transition_kind!,
              }),
            }
          : {}),
      }),
    );
  }
  return records;
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
        const content = readTranscriptArchiveContent(database.db, plan.agentId, plan.sessionId);
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
