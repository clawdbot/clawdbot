import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  readMemoryRunExposure,
  type MemoryRunExposureSnapshot,
} from "../../plugins/memory-run-exposure.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "../../state/openclaw-agent-scoped-memory-schema.js";
import { getOwnedSessionTranscriptWriterFence } from "./transcript-write-context.js";

type TranscriptMemoryPolicyDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  | "memory_migrations"
  | "memory_policy_sets"
  | "memory_run_exposures"
  | "session_memory_subject_snapshots"
  | "transcript_event_memory_policies"
>;

const enforcementByDatabase = new WeakMap<DatabaseSync, boolean>();

function policyDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptMemoryPolicyDatabase>(db);
}

function canonicalStrings(values: readonly string[]): string | undefined {
  if (values.some((value) => !value.trim())) {
    return undefined;
  }
  return JSON.stringify([...new Set(values)].toSorted());
}

function canonicalAudiences(exposure: MemoryRunExposureSnapshot): string | undefined {
  const audiences = exposure.deliveryAudiences.map((audience) => ({
    kind: audience.kind,
    id: audience.id,
  }));
  if (audiences.some((audience) => !audience.id.trim())) {
    return undefined;
  }
  const keys = audiences.map((audience) => `${audience.kind}\u0000${audience.id}`);
  if (new Set(keys).size !== keys.length) {
    return undefined;
  }
  return JSON.stringify(
    audiences.toSorted((left, right) =>
      `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`),
    ),
  );
}

function effectivePolicySetId(
  memoryPolicyRevision: string,
  sourcePolicySetIdsJson: string,
): string {
  return `mpset1_${createHash("sha256")
    .update(JSON.stringify({ memoryPolicyRevision, sourcePolicySetIdsJson }))
    .digest("base64url")}`;
}

/** Cut-over is process-stable. A failed authority read remains enforced rather than reopening rows. */
export function isTranscriptMemoryPolicyEnforcedInDatabase(db: DatabaseSync): boolean {
  const cached = enforcementByDatabase.get(db);
  if (cached !== undefined) {
    return cached;
  }
  let enforced: boolean;
  try {
    ensureOpenClawAgentScopedMemorySchema(db);
    enforced =
      executeSqliteQueryTakeFirstSync(
        db,
        policyDatabase(db)
          .selectFrom("memory_migrations")
          .select("migration_id")
          .where("phase", "=", "cutover")
          .where("verified_at", "is not", null)
          .where("cutover_at", "is not", null)
          .limit(1),
      ) !== undefined;
  } catch {
    enforced = true;
  }
  enforcementByDatabase.set(db, enforced);
  return enforced;
}

function persistExposureLineageInTransaction(params: {
  database: OpenClawAgentDatabase;
  current: MemoryRunExposureSnapshot;
}):
  | Readonly<{
      policySetId: string;
      deliveryAudiencesJson: string;
    }>
  | undefined {
  const snapshots: MemoryRunExposureSnapshot[] = [];
  const seen = new Set<string>();
  let cursor: MemoryRunExposureSnapshot | undefined = params.current;
  while (cursor) {
    if (
      seen.has(cursor.exposureSetId) ||
      cursor.agentId !== params.database.agentId ||
      cursor.revisionNumber !== (cursor.previous?.revisionNumber ?? 0) + 1
    ) {
      return undefined;
    }
    seen.add(cursor.exposureSetId);
    snapshots.push(cursor);
    cursor = cursor.previous;
  }
  const db = policyDatabase(params.database.db);
  let currentResult: { policySetId: string; deliveryAudiencesJson: string } | undefined;
  for (const snapshot of snapshots.toReversed()) {
    const sourcePolicySetIdsJson = canonicalStrings(snapshot.sourcePolicySetIds);
    const exposedResourceRevisionsJson = canonicalStrings(snapshot.exposedResourceRevisions);
    const exposureReceiptIdsJson = canonicalStrings(snapshot.exposureReceiptIds);
    const egressReceiptIdsJson = canonicalStrings(snapshot.egressReceiptIds);
    const deliveryAudiencesJson = canonicalAudiences(snapshot);
    if (
      !sourcePolicySetIdsJson ||
      !exposedResourceRevisionsJson ||
      !exposureReceiptIdsJson ||
      !egressReceiptIdsJson ||
      !deliveryAudiencesJson ||
      !snapshot.planId.trim() ||
      !snapshot.contextFingerprint.trim() ||
      !snapshot.memoryPolicyRevision.trim()
    ) {
      return undefined;
    }
    const policySetId = effectivePolicySetId(snapshot.memoryPolicyRevision, sourcePolicySetIdsJson);
    executeSqliteQuerySync(
      params.database.db,
      db
        .insertInto("memory_policy_sets")
        .values({
          policy_set_id: policySetId,
          agent_id: snapshot.agentId,
          memory_policy_revision: snapshot.memoryPolicyRevision,
          member_policy_set_ids_json: sourcePolicySetIdsJson,
          created_at: snapshot.createdAt,
        })
        .onConflict((conflict) => conflict.column("policy_set_id").doNothing()),
    );
    executeSqliteQuerySync(
      params.database.db,
      db
        .insertInto("memory_run_exposures")
        .values({
          exposure_set_id: snapshot.exposureSetId,
          agent_id: snapshot.agentId,
          run_id: snapshot.runId,
          context_fingerprint: snapshot.contextFingerprint,
          plan_id: snapshot.planId,
          revision_number: snapshot.revisionNumber,
          previous_exposure_set_id: snapshot.previous?.exposureSetId ?? null,
          source_policy_set_ids_json: sourcePolicySetIdsJson,
          effective_source_policy_set_id: policySetId,
          exposed_resource_revisions_json: exposedResourceRevisionsJson,
          exposure_receipt_ids_json: exposureReceiptIdsJson,
          egress_receipt_ids_json: egressReceiptIdsJson,
          delivery_audiences_json: deliveryAudiencesJson,
          delivery_revision: snapshot.deliveryRevision,
          egress_registry_revision: snapshot.egressRegistryRevision,
          created_at: snapshot.createdAt,
        })
        .onConflict((conflict) => conflict.column("exposure_set_id").doNothing()),
    );
    if (snapshot === params.current) {
      currentResult = { policySetId, deliveryAudiencesJson };
    }
  }
  return currentResult;
}

function isCurrentAuthorizedLabel(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  exposure: MemoryRunExposureSnapshot;
}): boolean {
  const subject = executeSqliteQueryTakeFirstSync(
    params.database.db,
    policyDatabase(params.database.db)
      .selectFrom("session_memory_subject_snapshots")
      .select(["session_identity_revision", "subject_revision"])
      .where("session_id", "=", params.sessionId)
      .limit(1),
  );
  return Boolean(
    subject &&
    subject.session_identity_revision === params.exposure.sessionIdentityRevision &&
    subject.subject_revision === params.exposure.subjectRevision,
  );
}

/** Writes a pending or fully linked companion immediately after the event in the same SQLite txn. */
export function recordTranscriptMemoryPolicyInTransaction(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  sessionKey: string;
  eventSeq: number;
  createdAt: number;
}): boolean {
  if (!isTranscriptMemoryPolicyEnforcedInDatabase(params.database.db)) {
    return true;
  }
  const db = policyDatabase(params.database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_event_memory_policies")
      .select("authorization_status")
      .where("session_id", "=", params.sessionId)
      .where("event_seq", "=", params.eventSeq)
      .limit(1),
  );
  if (existing) {
    return existing.authorization_status === "authorized";
  }
  const runId = getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId;
  const exposure = runId
    ? readMemoryRunExposure({
        agentId: params.database.agentId,
        sessionId: params.sessionId,
        runId,
      })
    : undefined;
  const persisted =
    exposure &&
    isCurrentAuthorizedLabel({ database: params.database, sessionId: params.sessionId, exposure })
      ? persistExposureLineageInTransaction({ database: params.database, current: exposure })
      : undefined;
  const authorized = Boolean(exposure && persisted);
  executeSqliteQuerySync(
    params.database.db,
    db.insertInto("transcript_event_memory_policies").values(
      authorized && exposure && persisted
        ? {
            session_id: params.sessionId,
            event_seq: params.eventSeq,
            authorization_status: "authorized",
            source_policy_set_id: persisted.policySetId,
            run_exposure_set_id: exposure.exposureSetId,
            run_exposure_revision: exposure.revisionNumber,
            delivery_audiences_json: persisted.deliveryAudiencesJson,
            session_identity_revision: exposure.sessionIdentityRevision,
            subject_revision: exposure.subjectRevision,
            run_id: exposure.runId,
            context_fingerprint: exposure.contextFingerprint,
            created_at: params.createdAt,
          }
        : {
            session_id: params.sessionId,
            event_seq: params.eventSeq,
            authorization_status: "pending",
            source_policy_set_id: null,
            run_exposure_set_id: null,
            run_exposure_revision: null,
            delivery_audiences_json: null,
            session_identity_revision: null,
            subject_revision: null,
            run_id: null,
            context_fingerprint: null,
            created_at: params.createdAt,
          },
    ),
  );
  return authorized;
}

/** Legacy returns undefined; cut-over returns only companion-authorized raw event sequences. */
export function readAuthorizedTranscriptEventSeqs(
  db: DatabaseSync,
  sessionId: string,
): Set<number> | undefined {
  if (!isTranscriptMemoryPolicyEnforcedInDatabase(db)) {
    return undefined;
  }
  try {
    const rows = executeSqliteQuerySync(
      db,
      policyDatabase(db)
        .selectFrom("transcript_event_memory_policies as policy")
        .innerJoin(
          "session_memory_subject_snapshots as subject",
          "subject.session_id",
          "policy.session_id",
        )
        .innerJoin(
          "memory_run_exposures as exposure",
          "exposure.exposure_set_id",
          "policy.run_exposure_set_id",
        )
        .innerJoin(
          "memory_policy_sets as policy_set",
          "policy_set.policy_set_id",
          "policy.source_policy_set_id",
        )
        .select("policy.event_seq")
        .where("policy.session_id", "=", sessionId)
        .where("policy.authorization_status", "=", "authorized")
        .whereRef("subject.session_identity_revision", "=", "policy.session_identity_revision")
        .whereRef("subject.subject_revision", "=", "policy.subject_revision")
        .whereRef("exposure.run_id", "=", "policy.run_id")
        .whereRef("exposure.context_fingerprint", "=", "policy.context_fingerprint")
        .whereRef("exposure.revision_number", "=", "policy.run_exposure_revision")
        .whereRef("exposure.effective_source_policy_set_id", "=", "policy.source_policy_set_id")
        .whereRef("exposure.delivery_audiences_json", "=", "policy.delivery_audiences_json")
        .whereRef("policy_set.policy_set_id", "=", "exposure.effective_source_policy_set_id"),
    ).rows;
    return new Set(rows.map((row) => row.event_seq));
  } catch {
    return new Set();
  }
}

export function resetTranscriptMemoryPolicyForTest(db: DatabaseSync): void {
  enforcementByDatabase.delete(db);
}
