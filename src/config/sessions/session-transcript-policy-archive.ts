// Versioned transcript-policy archive decoding for explicit confirmed-import workflows.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readAuthorizedTranscriptEventSeqs } from "./session-transcript-memory-policy.js";

const RECORD_TYPE = "openclaw.memory-policy-archive-v1";

type TranscriptPolicyArchiveDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  | "session_memory_subject_snapshots"
  | "transcript_events"
  | "transcript_event_memory_policies"
  | "transcript_event_memory_policy_details"
  | "transcript_event_memory_policy_transitions"
>;

export type TranscriptPolicyArchiveEvent = Readonly<{
  event: unknown;
  eventJson: string;
  eventSeq: number;
  metadata: TranscriptPolicyArchiveMetadata;
}>;

export type TranscriptPolicyArchiveMetadata = Readonly<{
  agentId: string;
  eventSeq: number;
  sessionId: string;
  subject: Readonly<{
    sessionIdentityRevision: string;
    sessionKey: string;
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
    kind: "parent-fork" | "fork" | "rewind" | "switch" | "checkpoint";
    sourceEventSeq: number;
    sourceSessionId: string;
    sourceSessionIdentityRevision: string;
    subjectRevision: string;
    targetSessionIdentityRevision: string;
  }>;
}>;

export type TranscriptPolicyArchive = Readonly<{
  agentId: string;
  events: readonly TranscriptPolicyArchiveEvent[];
  sessionId: string;
  sessionIdentityRevision: string;
  sessionKey: string;
  subjectRevision: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseJson(line: string): unknown | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return JSON.stringify(parsed) === line ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseMetadata(value: unknown): TranscriptPolicyArchiveMetadata | undefined {
  if (!isRecord(value) || value.type !== RECORD_TYPE || value.version !== 1) {
    return undefined;
  }
  const subject = isRecord(value.subject) ? value.subject : undefined;
  const policy = isRecord(value.policy) ? value.policy : undefined;
  const detail = isRecord(value.detail) ? value.detail : undefined;
  const agentId = text(value.agentId);
  const sessionId = text(value.sessionId);
  const eventSeq = integer(value.eventSeq);
  const sessionKey = text(subject?.sessionKey);
  const sessionIdentityRevision = text(subject?.sessionIdentityRevision);
  const subjectRevision = text(subject?.subjectRevision);
  const contextFingerprint = text(policy?.contextFingerprint);
  const deliveryAudiencesJson = text(policy?.deliveryAudiencesJson);
  const runExposureRevision = integer(policy?.runExposureRevision);
  const runExposureSetId = text(policy?.runExposureSetId);
  const runId = text(policy?.runId);
  const sourcePolicySetId = text(policy?.sourcePolicySetId);
  const actorEvidenceJson = text(detail?.actorEvidenceJson);
  const delegationSnapshotJson = text(detail?.delegationSnapshotJson);
  const egressReceiptIdsJson = text(detail?.egressReceiptIdsJson);
  const exposedResourceRevisionsJson = text(detail?.exposedResourceRevisionsJson);
  const exposureReceiptIdsJson = text(detail?.exposureReceiptIdsJson);
  const finalizedDeliveryAudiencesJson = text(detail?.finalizedDeliveryAudiencesJson);
  const normalizedAudienceIntersectionJson = text(detail?.normalizedAudienceIntersectionJson);
  const sourceEventSeq = integer(detail?.sourceEventSeq);
  const sourceSessionId = text(detail?.sourceSessionId);
  if (
    !agentId ||
    !sessionId ||
    eventSeq === undefined ||
    !sessionKey ||
    !sessionIdentityRevision ||
    !subjectRevision ||
    !contextFingerprint ||
    !deliveryAudiencesJson ||
    runExposureRevision === undefined ||
    !runExposureSetId ||
    !runId ||
    !sourcePolicySetId ||
    !actorEvidenceJson ||
    !delegationSnapshotJson ||
    !egressReceiptIdsJson ||
    !exposedResourceRevisionsJson ||
    !exposureReceiptIdsJson ||
    !finalizedDeliveryAudiencesJson ||
    !normalizedAudienceIntersectionJson ||
    sourceEventSeq === undefined ||
    !sourceSessionId
  ) {
    return undefined;
  }
  const transitionRecord =
    value.transition === undefined
      ? undefined
      : isRecord(value.transition)
        ? value.transition
        : null;
  if (transitionRecord === null) {
    return undefined;
  }
  const transition = transitionRecord
    ? {
        kind: transitionRecord.kind,
        sourceEventSeq: integer(transitionRecord.sourceEventSeq),
        sourceSessionId: text(transitionRecord.sourceSessionId),
        sourceSessionIdentityRevision: text(transitionRecord.sourceSessionIdentityRevision),
        subjectRevision: text(transitionRecord.subjectRevision),
        targetSessionIdentityRevision: text(transitionRecord.targetSessionIdentityRevision),
      }
    : undefined;
  if (
    transition &&
    (!["parent-fork", "fork", "rewind", "switch", "checkpoint"].includes(String(transition.kind)) ||
      transition.sourceEventSeq === undefined ||
      !transition.sourceSessionId ||
      !transition.sourceSessionIdentityRevision ||
      !transition.subjectRevision ||
      !transition.targetSessionIdentityRevision)
  ) {
    return undefined;
  }
  return Object.freeze({
    agentId,
    eventSeq,
    sessionId,
    subject: Object.freeze({ sessionIdentityRevision, sessionKey, subjectRevision }),
    policy: Object.freeze({
      contextFingerprint,
      deliveryAudiencesJson,
      runExposureRevision,
      runExposureSetId,
      runId,
      sourcePolicySetId,
    }),
    detail: Object.freeze({
      actorEvidenceJson,
      delegationSnapshotJson,
      egressReceiptIdsJson,
      exposedResourceRevisionsJson,
      exposureReceiptIdsJson,
      finalizedDeliveryAudiencesJson,
      normalizedAudienceIntersectionJson,
      sourceEventSeq,
      sourceSessionId,
    }),
    ...(transition
      ? {
          transition: Object.freeze(
            transition as NonNullable<TranscriptPolicyArchiveMetadata["transition"]>,
          ),
        }
      : {}),
  });
}

/** Parse only canonical event/companion pairs; legacy raw JSONL is never importable here. */
export function parseTranscriptPolicyArchive(content: string): TranscriptPolicyArchive | undefined {
  if (!content.endsWith("\n")) {
    return undefined;
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length % 2 !== 0) {
    return undefined;
  }
  const events: TranscriptPolicyArchiveEvent[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const eventJson = lines[index];
    const metadataJson = lines[index + 1];
    if (eventJson === undefined || metadataJson === undefined) {
      return undefined;
    }
    const event = parseJson(eventJson);
    const metadata = parseMetadata(parseJson(metadataJson));
    if (event === undefined || !metadata || metadata.eventSeq !== events.length) {
      return undefined;
    }
    events.push(Object.freeze({ event, eventJson, eventSeq: metadata.eventSeq, metadata }));
  }
  const first = events[0]?.metadata;
  if (
    !first ||
    events.some(
      ({ metadata, eventSeq }) =>
        metadata.agentId !== first.agentId ||
        metadata.sessionId !== first.sessionId ||
        metadata.subject.sessionKey !== first.subject.sessionKey ||
        metadata.subject.sessionIdentityRevision !== first.subject.sessionIdentityRevision ||
        metadata.subject.subjectRevision !== first.subject.subjectRevision ||
        metadata.eventSeq !== eventSeq,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    agentId: first.agentId,
    events: Object.freeze(events),
    sessionId: first.sessionId,
    sessionIdentityRevision: first.subject.sessionIdentityRevision,
    sessionKey: first.subject.sessionKey,
    subjectRevision: first.subject.subjectRevision,
  });
}

/**
 * Restores only already-appended archive events. The caller owns entry creation
 * and event insertion; this helper proves provenance before making companions
 * readable, then reruns the canonical current-policy reader in the same txn.
 */
export function restoreConfirmedTranscriptPolicyArchiveInTransaction(params: {
  archive: TranscriptPolicyArchive;
  database: OpenClawAgentDatabase;
  sessionId: string;
  sessionKey: string;
}): void {
  const { archive, database, sessionId, sessionKey } = params;
  if (
    archive.agentId !== database.agentId ||
    archive.sessionId !== sessionId ||
    archive.sessionKey !== sessionKey
  ) {
    throw new Error("confirmed transcript archive owner mismatch");
  }
  const db = getNodeSqliteKysely<TranscriptPolicyArchiveDatabase>(database.db);
  const subject = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_memory_subject_snapshots")
      .select(["session_identity_revision", "session_key", "subject_revision"])
      .where("session_id", "=", sessionId)
      .limit(1),
  );
  if (
    !subject ||
    subject.session_key !== archive.sessionKey ||
    subject.session_identity_revision !== archive.sessionIdentityRevision ||
    subject.subject_revision !== archive.subjectRevision
  ) {
    throw new Error("confirmed transcript archive subject mismatch");
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  if (
    rows.length !== archive.events.length ||
    rows.some(
      (row, index) =>
        row.seq !== archive.events[index]?.eventSeq ||
        row.event_json !== archive.events[index]?.eventJson,
    )
  ) {
    throw new Error("confirmed transcript archive event mismatch");
  }
  for (const archived of archive.events) {
    const { detail, policy, transition } = archived.metadata;
    const updated = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_event_memory_policies")
        .set({
          authorization_status: "authorized",
          context_fingerprint: policy.contextFingerprint,
          delivery_audiences_json: policy.deliveryAudiencesJson,
          run_exposure_revision: policy.runExposureRevision,
          run_exposure_set_id: policy.runExposureSetId,
          run_id: policy.runId,
          session_identity_revision: archive.sessionIdentityRevision,
          source_policy_set_id: policy.sourcePolicySetId,
          subject_revision: archive.subjectRevision,
        })
        .where("session_id", "=", sessionId)
        .where("event_seq", "=", archived.eventSeq)
        .where("authorization_status", "=", "pending"),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error("confirmed transcript archive companion conflict");
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("transcript_event_memory_policy_details").values({
        session_id: sessionId,
        event_seq: archived.eventSeq,
        actor_evidence_json: detail.actorEvidenceJson,
        delegation_snapshot_json: detail.delegationSnapshotJson,
        egress_receipt_ids_json: detail.egressReceiptIdsJson,
        exposed_resource_revisions_json: detail.exposedResourceRevisionsJson,
        exposure_receipt_ids_json: detail.exposureReceiptIdsJson,
        finalized_delivery_audiences_json: detail.finalizedDeliveryAudiencesJson,
        normalized_audience_intersection_json: detail.normalizedAudienceIntersectionJson,
        retention_state: "retained",
        source_event_seq: detail.sourceEventSeq,
        source_session_id: detail.sourceSessionId,
        created_at: Date.now(),
      }),
    );
    if (transition) {
      executeSqliteQuerySync(
        database.db,
        db.insertInto("transcript_event_memory_policy_transitions").values({
          session_id: sessionId,
          event_seq: archived.eventSeq,
          source_event_seq: transition.sourceEventSeq,
          source_session_id: transition.sourceSessionId,
          transition_kind: transition.kind,
          source_session_identity_revision: transition.sourceSessionIdentityRevision,
          subject_revision: transition.subjectRevision,
          target_session_identity_revision: transition.targetSessionIdentityRevision,
          created_at: Date.now(),
        }),
      );
    }
  }
  const readable = readAuthorizedTranscriptEventSeqs(database.db, sessionId);
  if (
    !readable ||
    readable.size !== archive.events.length ||
    archive.events.some((archived) => !readable.has(archived.eventSeq))
  ) {
    throw new Error("confirmed transcript archive policy is no longer authorized");
  }
}
