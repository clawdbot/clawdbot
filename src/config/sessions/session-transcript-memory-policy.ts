import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { isMemoryIsolationTranscriptPolicyEnforcedInDatabase } from "../../plugins/memory-cutover.js";
import { readDurableMemoryRunExposure } from "../../plugins/memory-run-exposure-ledger.js";
import { type MemoryRunExposureSnapshot } from "../../plugins/memory-run-exposure.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getOwnedSessionTranscriptWriterFence } from "./transcript-write-context.js";

type TranscriptMemoryPolicyDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  | "memory_policies"
  | "memory_policy_revisions"
  | "memory_policy_set_members"
  | "memory_policy_sets"
  | "memory_resource_revisions"
  | "memory_run_exposure_resources"
  | "memory_run_exposures"
  | "session_memory_subject_snapshots"
  | "transcript_events"
  | "transcript_event_memory_policies"
  | "transcript_event_memory_policy_details"
  | "transcript_event_memory_policy_transitions"
>;

type StablePolicyMember = Readonly<{
  expectedRevocationEpoch: number;
  expectedRevisionId: string;
  policyId: string;
}>;

type PersistedExposure = Readonly<{
  deliveryAudiencesJson: string;
  egressReceiptIdsJson: string;
  exposedResourceRevisionsJson: string;
  exposureReceiptIdsJson: string;
  policySetId: string;
}>;

export type PreservedTranscriptMemoryPolicy = Readonly<{
  actorEvidenceJson: string;
  contextFingerprint: string;
  createdAt: number;
  delegationSnapshotJson: string;
  deliveryAudiencesJson: string;
  egressReceiptIdsJson: string;
  eventSeq: number;
  exposedResourceRevisionsJson: string;
  exposureReceiptIdsJson: string;
  finalizedDeliveryAudiencesJson: string;
  normalizedAudienceIntersectionJson: string;
  retentionState: "retained" | "quarantined";
  runExposureRevision: number;
  runExposureSetId: string;
  runId: string;
  sessionIdentityRevision: string;
  sourceEventSeq: number;
  sourcePolicySetId: string;
  sourceSessionId: string;
  subjectRevision: string;
}>;

export type TranscriptMemoryPolicyTransitionKind =
  | "parent-fork"
  | "fork"
  | "rewind"
  | "switch"
  | "checkpoint";

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
  members: readonly StablePolicyMember[],
  audienceIntersectionJson: string,
): string {
  return `mpset2_${createHash("sha256")
    .update(
      JSON.stringify({
        audienceIntersectionJson,
        members,
        memoryPolicyRevision,
        sourcePolicySetIdsJson,
      }),
    )
    .digest("base64url")}`;
}

/**
 * The process-stable P1C pilot and final Phase 6 cutover share this companion boundary.
 * A failed authority read remains enforced rather than reopening transcript rows.
 */
export function isTranscriptMemoryPolicyEnforcedInDatabase(db: DatabaseSync): boolean {
  const cached = enforcementByDatabase.get(db);
  if (cached !== undefined) {
    return cached;
  }
  let enforced: boolean;
  try {
    enforced = isMemoryIsolationTranscriptPolicyEnforcedInDatabase(db);
  } catch {
    enforced = true;
  }
  enforcementByDatabase.set(db, enforced);
  return enforced;
}

/**
 * Resolve only persisted built-in revision facts. Plugin policy payload remains opaque:
 * an exposure without stable resource revisions is pending instead of being reverse-engineered.
 */
function resolveStablePolicyMembersInTransaction(params: {
  database: OpenClawAgentDatabase;
  exposedResourceRevisions: readonly string[];
  sourcePolicySetIds: readonly string[];
}): readonly StablePolicyMember[] | undefined {
  const db = policyDatabase(params.database.db);
  if (params.exposedResourceRevisions.length === 0) {
    return undefined;
  }
  const resources = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("memory_resource_revisions")
      .select(["policy_revision_id", "revision_id", "source_policy_set_id"])
      .where("revision_id", "in", [...new Set(params.exposedResourceRevisions)]),
  ).rows;
  if (resources.length !== new Set(params.exposedResourceRevisions).size) {
    return undefined;
  }
  if (params.sourcePolicySetIds.length === 0) {
    return undefined;
  }
  const sourcePolicySetIds = new Set(params.sourcePolicySetIds);
  if (resources.some((resource) => !sourcePolicySetIds.has(resource.source_policy_set_id))) {
    return undefined;
  }
  const policyRevisionIds = new Set(resources.map((resource) => resource.policy_revision_id));
  const revisions = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("memory_policy_revisions as revision")
      .innerJoin("memory_policies as policy", "policy.policy_id", "revision.policy_id")
      .select([
        "policy.policy_id as policy_id",
        "revision.revision_id as revision_id",
        "revision.revocation_epoch as revision_revocation_epoch",
      ])
      .where("revision.revision_id", "in", [...policyRevisionIds]),
  ).rows;
  if (revisions.length !== policyRevisionIds.size) {
    return undefined;
  }
  const members = revisions
    .map(
      (revision) =>
        ({
          expectedRevocationEpoch: revision.revision_revocation_epoch,
          expectedRevisionId: revision.revision_id,
          policyId: revision.policy_id,
        }) satisfies StablePolicyMember,
    )
    .toSorted((left, right) => left.policyId.localeCompare(right.policyId));
  return new Set(members.map((member) => member.policyId)).size === members.length
    ? Object.freeze(members)
    : undefined;
}

function persistExposureLineageInTransaction(params: {
  database: OpenClawAgentDatabase;
  current: MemoryRunExposureSnapshot;
}): PersistedExposure | undefined {
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
  let currentResult: PersistedExposure | undefined;
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
    const members = resolveStablePolicyMembersInTransaction({
      database: params.database,
      exposedResourceRevisions: snapshot.exposedResourceRevisions,
      sourcePolicySetIds: snapshot.sourcePolicySetIds,
    });
    if (!members) {
      return undefined;
    }
    const policySetId = effectivePolicySetId(
      snapshot.memoryPolicyRevision,
      sourcePolicySetIdsJson,
      members,
      deliveryAudiencesJson,
    );
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
    for (const member of members) {
      executeSqliteQuerySync(
        params.database.db,
        db
          .insertInto("memory_policy_set_members")
          .values({
            policy_set_id: policySetId,
            policy_id: member.policyId,
            expected_revision_id: member.expectedRevisionId,
            expected_revocation_epoch: member.expectedRevocationEpoch,
            audience_intersection_json: deliveryAudiencesJson,
            retention_state: "retained",
            created_at: snapshot.createdAt,
          })
          .onConflict((conflict) => conflict.columns(["policy_set_id", "policy_id"]).doNothing()),
      );
    }
    executeSqliteQuerySync(
      params.database.db,
      db
        .insertInto("memory_run_exposures")
        .values({
          exposure_set_id: snapshot.exposureSetId,
          agent_id: snapshot.agentId,
          run_id: snapshot.durableRunScopeId,
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
    for (const resourceRevisionId of snapshot.exposedResourceRevisions) {
      executeSqliteQuerySync(
        params.database.db,
        db
          .insertInto("memory_run_exposure_resources")
          .values({
            exposure_set_id: snapshot.exposureSetId,
            resource_revision_id: resourceRevisionId,
            policy_set_id: policySetId,
            created_at: snapshot.createdAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["exposure_set_id", "resource_revision_id"]).doNothing(),
          ),
      );
    }
    if (snapshot === params.current) {
      currentResult = {
        deliveryAudiencesJson,
        egressReceiptIdsJson,
        exposedResourceRevisionsJson,
        exposureReceiptIdsJson,
        policySetId,
      };
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
  inherited?: PreservedTranscriptMemoryPolicy;
  /** Replacement rows may retain only an exact durable predecessor. */
  replacement?: boolean;
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
  if (
    params.inherited &&
    recordInheritedTranscriptMemoryPolicyInTransaction({
      ...params,
      inherited: params.inherited,
    })
  ) {
    return true;
  }
  // Rewrites must never borrow a currently active writer's exposure for new
  // material. A replacement carries authorization only through exact durable
  // lineage; every unmatched or invalid row remains pending.
  const runId = params.replacement
    ? undefined
    : getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId;
  const exposure = runId
    ? readDurableMemoryRunExposure({
        database: params.database,
        sessionId: params.sessionId,
        runId,
      })
    : undefined;
  const persisted =
    exposure &&
    isCurrentAuthorizedLabel({ database: params.database, sessionId: params.sessionId, exposure })
      ? persistExposureLineageInTransaction({ database: params.database, current: exposure })
      : undefined;
  // The exposure ledger carries the trusted, pre-output actor/delegation facts.
  // Session subject rows only revalidate binding; they never reconstruct an actor.
  const actorEvidenceJson = exposure ? JSON.stringify(exposure.actorEvidence) : undefined;
  const delegationSnapshotJson = exposure ? JSON.stringify(exposure.delegationSnapshot) : undefined;
  const authorized = Boolean(exposure && persisted && actorEvidenceJson && delegationSnapshotJson);
  executeSqliteQuerySync(
    params.database.db,
    db.insertInto("transcript_event_memory_policies").values(
      authorized && exposure && persisted && actorEvidenceJson && delegationSnapshotJson
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
            run_id: exposure.durableRunScopeId,
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
  if (authorized && exposure && persisted && actorEvidenceJson && delegationSnapshotJson) {
    executeSqliteQuerySync(
      params.database.db,
      db.insertInto("transcript_event_memory_policy_details").values({
        session_id: params.sessionId,
        event_seq: params.eventSeq,
        actor_evidence_json: actorEvidenceJson,
        delegation_snapshot_json: delegationSnapshotJson,
        exposed_resource_revisions_json: persisted.exposedResourceRevisionsJson,
        exposure_receipt_ids_json: persisted.exposureReceiptIdsJson,
        egress_receipt_ids_json: persisted.egressReceiptIdsJson,
        normalized_audience_intersection_json: persisted.deliveryAudiencesJson,
        finalized_delivery_audiences_json: persisted.deliveryAudiencesJson,
        retention_state: "retained",
        source_session_id: params.sessionId,
        source_event_seq: params.eventSeq,
        created_at: params.createdAt,
      }),
    );
  }
  return authorized;
}

function recordInheritedTranscriptMemoryPolicyInTransaction(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  sessionKey: string;
  eventSeq: number;
  createdAt: number;
  inherited: PreservedTranscriptMemoryPolicy;
}): boolean {
  const inherited = params.inherited;
  // A replacement may copy only an already durable, same-session companion.
  // Cross-session forks have a distinct session identity and must use the
  // transition owner to establish a new authorized lineage rather than replay it.
  const currentSubject = executeSqliteQueryTakeFirstSync(
    params.database.db,
    policyDatabase(params.database.db)
      .selectFrom("session_memory_subject_snapshots")
      .select(["session_identity_revision", "subject_revision"])
      .where("session_id", "=", params.sessionId)
      .limit(1),
  );
  if (
    inherited.retentionState !== "retained" ||
    inherited.sourceSessionId !== params.sessionId ||
    inherited.sessionIdentityRevision !== currentSubject?.session_identity_revision ||
    inherited.subjectRevision !== currentSubject?.subject_revision
  ) {
    return false;
  }
  const db = policyDatabase(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    db.insertInto("transcript_event_memory_policies").values({
      session_id: params.sessionId,
      event_seq: params.eventSeq,
      authorization_status: "authorized",
      source_policy_set_id: inherited.sourcePolicySetId,
      run_exposure_set_id: inherited.runExposureSetId,
      run_exposure_revision: inherited.runExposureRevision,
      delivery_audiences_json: inherited.deliveryAudiencesJson,
      session_identity_revision: inherited.sessionIdentityRevision,
      subject_revision: inherited.subjectRevision,
      run_id: inherited.runId,
      context_fingerprint: inherited.contextFingerprint,
      created_at: params.createdAt,
    }),
  );
  executeSqliteQuerySync(
    params.database.db,
    db.insertInto("transcript_event_memory_policy_details").values({
      session_id: params.sessionId,
      event_seq: params.eventSeq,
      actor_evidence_json: inherited.actorEvidenceJson,
      delegation_snapshot_json: inherited.delegationSnapshotJson,
      exposed_resource_revisions_json: inherited.exposedResourceRevisionsJson,
      exposure_receipt_ids_json: inherited.exposureReceiptIdsJson,
      egress_receipt_ids_json: inherited.egressReceiptIdsJson,
      normalized_audience_intersection_json: inherited.normalizedAudienceIntersectionJson,
      finalized_delivery_audiences_json: inherited.finalizedDeliveryAudiencesJson,
      retention_state: inherited.retentionState,
      source_session_id: inherited.sourceSessionId,
      source_event_seq: inherited.sourceEventSeq,
      created_at: params.createdAt,
    }),
  );
  return true;
}

/**
 * Capture durable companion evidence by exact stored event bytes before a
 * same-session replacement deletes old rows. Replacements can reorder or drop
 * events, so a sequence number is never a safe lineage key.
 */
export function readPreservedTranscriptMemoryPoliciesInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Map<string, PreservedTranscriptMemoryPolicy[]> {
  const rows = executeSqliteQuerySync(
    database.db,
    policyDatabase(database.db)
      .selectFrom("transcript_event_memory_policies as policy")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "policy.session_id")
          .onRef("event.seq", "=", "policy.event_seq"),
      )
      .innerJoin("transcript_event_memory_policy_details as detail", (join) =>
        join
          .onRef("detail.session_id", "=", "policy.session_id")
          .onRef("detail.event_seq", "=", "policy.event_seq"),
      )
      .select([
        "event.event_json",
        "policy.context_fingerprint",
        "policy.delivery_audiences_json",
        "policy.event_seq",
        "policy.run_exposure_revision",
        "policy.run_exposure_set_id",
        "policy.run_id",
        "policy.session_identity_revision",
        "policy.source_policy_set_id",
        "policy.subject_revision",
        "detail.actor_evidence_json",
        "detail.created_at",
        "detail.delegation_snapshot_json",
        "detail.egress_receipt_ids_json",
        "detail.exposed_resource_revisions_json",
        "detail.exposure_receipt_ids_json",
        "detail.finalized_delivery_audiences_json",
        "detail.normalized_audience_intersection_json",
        "detail.retention_state",
        "detail.source_event_seq",
        "detail.source_session_id",
      ])
      .where("policy.session_id", "=", sessionId)
      .where("policy.authorization_status", "=", "authorized")
      .orderBy("policy.event_seq", "asc"),
  ).rows;
  const result = new Map<string, PreservedTranscriptMemoryPolicy[]>();
  for (const row of rows) {
    if (
      row.source_policy_set_id === null ||
      row.run_exposure_set_id === null ||
      row.run_exposure_revision === null ||
      row.delivery_audiences_json === null ||
      row.session_identity_revision === null ||
      row.subject_revision === null ||
      row.run_id === null ||
      row.context_fingerprint === null ||
      (row.retention_state !== "retained" && row.retention_state !== "quarantined")
    ) {
      continue;
    }
    const preserved = Object.freeze({
      actorEvidenceJson: row.actor_evidence_json,
      contextFingerprint: row.context_fingerprint,
      createdAt: row.created_at,
      delegationSnapshotJson: row.delegation_snapshot_json,
      deliveryAudiencesJson: row.delivery_audiences_json,
      egressReceiptIdsJson: row.egress_receipt_ids_json,
      eventSeq: row.event_seq,
      exposedResourceRevisionsJson: row.exposed_resource_revisions_json,
      exposureReceiptIdsJson: row.exposure_receipt_ids_json,
      finalizedDeliveryAudiencesJson: row.finalized_delivery_audiences_json,
      normalizedAudienceIntersectionJson: row.normalized_audience_intersection_json,
      retentionState: row.retention_state,
      runExposureRevision: row.run_exposure_revision,
      runExposureSetId: row.run_exposure_set_id,
      runId: row.run_id,
      sessionIdentityRevision: row.session_identity_revision,
      sourceEventSeq: row.source_event_seq,
      sourcePolicySetId: row.source_policy_set_id,
      sourceSessionId: row.source_session_id,
      subjectRevision: row.subject_revision,
    } satisfies PreservedTranscriptMemoryPolicy);
    const matches = result.get(row.event_json);
    if (matches) {
      matches.push(preserved);
    } else {
      result.set(row.event_json, [preserved]);
    }
  }
  return result;
}

/**
 * Copies only already-readable, exact source events into a new session identity.
 * The target snapshot must exist first: a copied companion is transition lineage,
 * never a replay of the source session's authorization context.
 */
export function preserveTranscriptMemoryPolicyTransitionInTransaction(params: {
  database: OpenClawAgentDatabase;
  sourceSessionId: string;
  targetSessionId: string;
  transitionKind: TranscriptMemoryPolicyTransitionKind;
}): number {
  if (
    params.sourceSessionId === params.targetSessionId ||
    !isTranscriptMemoryPolicyEnforcedInDatabase(params.database.db)
  ) {
    return 0;
  }
  const db = policyDatabase(params.database.db);
  const [sourceSubject, targetSubject] = [params.sourceSessionId, params.targetSessionId].map(
    (sessionId) =>
      executeSqliteQueryTakeFirstSync(
        params.database.db,
        db
          .selectFrom("session_memory_subject_snapshots")
          .select(["session_identity_revision", "subject_revision"])
          .where("session_id", "=", sessionId)
          .limit(1),
      ),
  );
  if (
    !sourceSubject ||
    !targetSubject ||
    sourceSubject.subject_revision !== targetSubject.subject_revision
  ) {
    return 0;
  }
  const readableSourceEventSeqs = readAuthorizedTranscriptEventSeqs(
    params.database.db,
    params.sourceSessionId,
  );
  if (!readableSourceEventSeqs || readableSourceEventSeqs.size === 0) {
    return 0;
  }
  const sourceRows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events as event")
      .innerJoin("transcript_event_memory_policies as policy", (join) =>
        join
          .onRef("policy.session_id", "=", "event.session_id")
          .onRef("policy.event_seq", "=", "event.seq"),
      )
      .innerJoin("transcript_event_memory_policy_details as detail", (join) =>
        join
          .onRef("detail.session_id", "=", "policy.session_id")
          .onRef("detail.event_seq", "=", "policy.event_seq"),
      )
      .select([
        "event.event_json",
        "policy.context_fingerprint",
        "policy.delivery_audiences_json",
        "policy.event_seq",
        "policy.run_exposure_revision",
        "policy.run_exposure_set_id",
        "policy.run_id",
        "policy.source_policy_set_id",
        "detail.actor_evidence_json",
        "detail.delegation_snapshot_json",
        "detail.egress_receipt_ids_json",
        "detail.exposed_resource_revisions_json",
        "detail.exposure_receipt_ids_json",
        "detail.finalized_delivery_audiences_json",
        "detail.normalized_audience_intersection_json",
        "detail.retention_state",
      ])
      .where("event.session_id", "=", params.sourceSessionId)
      .where("policy.authorization_status", "=", "authorized")
      .where("detail.retention_state", "=", "retained")
      .orderBy("event.seq", "asc"),
  ).rows;
  const sourcesByEventJson = new Map<string, (typeof sourceRows)[number][]>();
  for (const row of sourceRows) {
    if (!readableSourceEventSeqs.has(row.event_seq)) {
      continue;
    }
    const matches = sourcesByEventJson.get(row.event_json);
    if (matches) {
      matches.push(row);
    } else {
      sourcesByEventJson.set(row.event_json, [row]);
    }
  }
  const targetRows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", params.targetSessionId)
      .orderBy("seq", "asc"),
  ).rows;
  let preserved = 0;
  for (const target of targetRows) {
    const source = sourcesByEventJson.get(target.event_json)?.shift();
    if (
      !source ||
      source.source_policy_set_id === null ||
      source.run_exposure_set_id === null ||
      source.run_exposure_revision === null ||
      source.delivery_audiences_json === null ||
      source.run_id === null ||
      source.context_fingerprint === null
    ) {
      continue;
    }
    const updated = executeSqliteQuerySync(
      params.database.db,
      db
        .updateTable("transcript_event_memory_policies")
        .set({
          authorization_status: "authorized",
          source_policy_set_id: source.source_policy_set_id,
          run_exposure_set_id: source.run_exposure_set_id,
          run_exposure_revision: source.run_exposure_revision,
          delivery_audiences_json: source.delivery_audiences_json,
          session_identity_revision: targetSubject.session_identity_revision,
          subject_revision: targetSubject.subject_revision,
          run_id: source.run_id,
          context_fingerprint: source.context_fingerprint,
        })
        .where("session_id", "=", params.targetSessionId)
        .where("event_seq", "=", target.seq)
        .where("authorization_status", "=", "pending"),
    );
    if (updated.numAffectedRows !== 1n) {
      continue;
    }
    executeSqliteQuerySync(
      params.database.db,
      db.insertInto("transcript_event_memory_policy_details").values({
        session_id: params.targetSessionId,
        event_seq: target.seq,
        actor_evidence_json: source.actor_evidence_json,
        delegation_snapshot_json: source.delegation_snapshot_json,
        exposed_resource_revisions_json: source.exposed_resource_revisions_json,
        exposure_receipt_ids_json: source.exposure_receipt_ids_json,
        egress_receipt_ids_json: source.egress_receipt_ids_json,
        normalized_audience_intersection_json: source.normalized_audience_intersection_json,
        finalized_delivery_audiences_json: source.finalized_delivery_audiences_json,
        retention_state: "retained",
        source_session_id: params.sourceSessionId,
        source_event_seq: source.event_seq,
        created_at: Date.now(),
      }),
    );
    executeSqliteQuerySync(
      params.database.db,
      db.insertInto("transcript_event_memory_policy_transitions").values({
        session_id: params.targetSessionId,
        event_seq: target.seq,
        source_session_id: params.sourceSessionId,
        source_event_seq: source.event_seq,
        transition_kind: params.transitionKind,
        source_session_identity_revision: sourceSubject.session_identity_revision,
        target_session_identity_revision: targetSubject.session_identity_revision,
        subject_revision: targetSubject.subject_revision,
        created_at: Date.now(),
      }),
    );
    preserved += 1;
  }
  return preserved;
}

function isCurrentPolicySetAuthorized(db: DatabaseSync, policySetId: string): boolean {
  try {
    const policy = policyDatabase(db);
    const members = executeSqliteQuerySync(
      db,
      policy
        .selectFrom("memory_policy_set_members")
        .select([
          "expected_revocation_epoch",
          "expected_revision_id",
          "policy_id",
          "retention_state",
        ])
        .where("policy_set_id", "=", policySetId),
    ).rows;
    if (members.length === 0 || members.some((member) => member.retention_state !== "retained")) {
      return false;
    }
    return members.every((member) => {
      const current = executeSqliteQueryTakeFirstSync(
        db,
        policy
          .selectFrom("memory_policies as policy")
          .innerJoin(
            "memory_policy_revisions as revision",
            "revision.revision_id",
            "policy.current_revision_id",
          )
          .select([
            "policy.lifecycle_state",
            "policy.revocation_epoch",
            "revision.lifecycle_state as revision_state",
          ])
          .where("policy.policy_id", "=", member.policy_id)
          .where("policy.current_revision_id", "=", member.expected_revision_id)
          .where("policy.revocation_epoch", "=", member.expected_revocation_epoch)
          .limit(1),
      );
      return current?.lifecycle_state === "active" && current.revision_state === "active";
    });
  } catch {
    return false;
  }
}

function areExposedResourcesCurrent(db: DatabaseSync, exposureSetId: string): boolean {
  try {
    const policy = policyDatabase(db);
    const resources = executeSqliteQuerySync(
      db,
      policy
        .selectFrom("memory_run_exposure_resources as exposure_resource")
        .innerJoin(
          "memory_resource_revisions as resource",
          "resource.revision_id",
          "exposure_resource.resource_revision_id",
        )
        .select(["resource.expires_at", "resource.lifecycle_state"])
        .where("exposure_resource.exposure_set_id", "=", exposureSetId),
    ).rows;
    const now = Date.now();
    return (
      resources.length > 0 &&
      resources.every(
        (resource) =>
          resource.lifecycle_state === "active" &&
          (resource.expires_at === null || resource.expires_at > now),
      )
    );
  } catch {
    return false;
  }
}

function isCurrentTranscriptMemoryTransition(params: {
  db: DatabaseSync;
  policySessionIdentityRevision: string | null;
  policySubjectRevision: string | null;
  transition: {
    source_event_seq: number | null;
    source_session_id: string | null;
    source_session_identity_revision: string | null;
    subject_revision: string | null;
    target_session_identity_revision: string | null;
  };
}): boolean {
  const { transition } = params;
  if (
    transition.source_event_seq === null ||
    transition.source_session_id === null ||
    transition.source_session_identity_revision === null ||
    transition.subject_revision === null ||
    transition.target_session_identity_revision === null ||
    params.policySessionIdentityRevision !== transition.target_session_identity_revision ||
    params.policySubjectRevision !== transition.subject_revision
  ) {
    return false;
  }
  const sourceSnapshot = executeSqliteQueryTakeFirstSync(
    params.db,
    policyDatabase(params.db)
      .selectFrom("session_memory_subject_snapshots")
      .select(["session_identity_revision", "subject_revision"])
      .where("session_id", "=", transition.source_session_id)
      .limit(1),
  );
  if (
    !sourceSnapshot ||
    sourceSnapshot.session_identity_revision !== transition.source_session_identity_revision ||
    sourceSnapshot.subject_revision !== transition.subject_revision
  ) {
    return false;
  }
  // A transition never grants new authority: the exact source event must still
  // be readable under current policy, resource, and source-session checks.
  return Boolean(
    readAuthorizedTranscriptEventSeqs(params.db, transition.source_session_id)?.has(
      transition.source_event_seq,
    ),
  );
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
        .leftJoin("transcript_event_memory_policy_transitions as transition", (join) =>
          join
            .onRef("transition.session_id", "=", "policy.session_id")
            .onRef("transition.event_seq", "=", "policy.event_seq"),
        )
        .select([
          "policy.event_seq",
          "policy.session_identity_revision as policy_session_identity_revision",
          "policy.subject_revision as policy_subject_revision",
          "policy.source_policy_set_id",
          "policy.run_exposure_set_id",
          "detail.source_event_seq",
          "detail.source_session_id",
          "transition.source_event_seq as transition_source_event_seq",
          "transition.source_session_id as transition_source_session_id",
          "transition.source_session_identity_revision",
          "transition.subject_revision as transition_subject_revision",
          "transition.target_session_identity_revision",
        ])
        .where("policy.session_id", "=", sessionId)
        .where("policy.authorization_status", "=", "authorized")
        .where("detail.retention_state", "=", "retained")
        .whereRef("subject.session_identity_revision", "=", "policy.session_identity_revision")
        .whereRef("subject.subject_revision", "=", "policy.subject_revision")
        .whereRef("exposure.run_id", "=", "policy.run_id")
        .whereRef("exposure.context_fingerprint", "=", "policy.context_fingerprint")
        .whereRef("exposure.revision_number", "=", "policy.run_exposure_revision")
        .whereRef("exposure.effective_source_policy_set_id", "=", "policy.source_policy_set_id")
        .whereRef("exposure.delivery_audiences_json", "=", "policy.delivery_audiences_json")
        .whereRef("detail.finalized_delivery_audiences_json", "=", "policy.delivery_audiences_json")
        .whereRef(
          "detail.normalized_audience_intersection_json",
          "=",
          "policy.delivery_audiences_json",
        )
        .whereRef("policy_set.policy_set_id", "=", "exposure.effective_source_policy_set_id"),
    ).rows;
    return new Set(
      rows.flatMap((row) => {
        if (
          !row.source_policy_set_id ||
          !row.run_exposure_set_id ||
          !isCurrentPolicySetAuthorized(db, row.source_policy_set_id) ||
          !areExposedResourcesCurrent(db, row.run_exposure_set_id)
        ) {
          return [];
        }
        const transitioned = row.transition_source_session_id !== null;
        const lineageCurrent = transitioned
          ? isCurrentTranscriptMemoryTransition({
              db,
              policySessionIdentityRevision: row.policy_session_identity_revision,
              policySubjectRevision: row.policy_subject_revision,
              transition: {
                source_event_seq: row.transition_source_event_seq,
                source_session_id: row.transition_source_session_id,
                source_session_identity_revision: row.source_session_identity_revision,
                subject_revision: row.transition_subject_revision,
                target_session_identity_revision: row.target_session_identity_revision,
              },
            })
          : // Exact same-session replacement retains the original source sequence
            // after delete-and-reappend. No transition row means this is either the
            // direct event or that already-verified replacement lineage.
            row.source_session_id === sessionId;
        return lineageCurrent ? [row.event_seq] : [];
      }),
    );
  } catch {
    return new Set();
  }
}

export function resetTranscriptMemoryPolicyForTest(db: DatabaseSync): void {
  enforcementByDatabase.delete(db);
}
