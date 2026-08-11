import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { logWarn } from "../logger.js";
import type { AudienceRef } from "../memory-host-sdk/host/authorization.js";
import { ensureMemoryPreoutputExposureLedgerSchemaInTransaction } from "../state/openclaw-agent-db-schema-helpers.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createMemoryRunExposureScopeId,
  reconcileMemoryRunExposureWithDurableLedger,
  type MemoryRunExposureSnapshot,
} from "./memory-run-exposure.js";

type MemoryPreoutputExposureLedgerDatabase = {
  memory_preoutput_exposure_ledger: {
    agent_id: string;
    session_id: string;
    run_id: string;
    revision_number: number;
    exposure_set_id: string;
    previous_exposure_set_id: string | null;
    session_key: string;
    context_fingerprint: string;
    plan_id: string;
    memory_policy_revision: string;
    source_policy_set_ids_json: string;
    exposed_resource_revisions_json: string;
    exposure_receipt_ids_json: string;
    egress_receipt_ids_json: string;
    delivery_audiences_json: string;
    delivery_revision: string;
    egress_registry_revision: string;
    session_identity_revision: string;
    subject_revision: string;
    created_at: number;
  };
};

type MemoryExposureLedgerDiagnostic = "hydrate-failed" | "persist-failed";

function logMemoryExposureLedgerDiagnostic(diagnostic: MemoryExposureLedgerDiagnostic): void {
  // Ledger errors can carry SQLite paths or other sensitive runtime details. The read already
  // fails closed, so emit only a stable outcome code for operators and tests.
  logWarn(`memory exposure ledger unavailable: ${diagnostic}`);
}

function canonicalStrings(values: readonly string[]): string | undefined {
  if (values.some((value) => !value.trim())) {
    return undefined;
  }
  return JSON.stringify([...new Set(values)].toSorted());
}

function canonicalAudiences(snapshot: MemoryRunExposureSnapshot): string | undefined {
  const audiences = snapshot.deliveryAudiences.map((audience) => ({
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

function parseCanonicalStrings(value: string): readonly string[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== "string" || !entry.trim())
    ) {
      return undefined;
    }
    const strings = parsed as string[];
    return canonicalStrings(strings) === value ? Object.freeze(strings) : undefined;
  } catch {
    return undefined;
  }
}

const audienceKinds = new Set<AudienceRef["kind"]>([
  "user",
  "conversation",
  "role",
  "agent-shared",
  "agent",
  "internal",
]);

function parseCanonicalAudiences(value: string): readonly AudienceRef[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const audiences: AudienceRef[] = [];
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !audienceKinds.has((entry as { kind?: unknown }).kind as AudienceRef["kind"]) ||
        typeof (entry as { id?: unknown }).id !== "string" ||
        !(entry as { id: string }).id.trim()
      ) {
        return undefined;
      }
      audiences.push(
        Object.freeze({
          kind: (entry as { kind: AudienceRef["kind"] }).kind,
          id: (entry as { id: string }).id,
        }),
      );
    }
    const snapshot = { deliveryAudiences: audiences } as MemoryRunExposureSnapshot;
    return canonicalAudiences(snapshot) === value ? Object.freeze(audiences) : undefined;
  } catch {
    return undefined;
  }
}

function isDurableSnapshot(snapshot: MemoryRunExposureSnapshot): boolean {
  return Boolean(
    snapshot.agentId.trim() &&
    snapshot.sessionId.trim() &&
    snapshot.runId.trim() &&
    snapshot.sessionKey.trim() &&
    snapshot.contextFingerprint.trim() &&
    snapshot.planId.trim() &&
    snapshot.memoryPolicyRevision.trim() &&
    snapshot.deliveryRevision.trim() &&
    snapshot.egressRegistryRevision.trim() &&
    snapshot.sessionIdentityRevision.trim() &&
    snapshot.subjectRevision.trim() &&
    snapshot.revisionNumber > 0 &&
    snapshot.revisionNumber === (snapshot.previous?.revisionNumber ?? 0) + 1 &&
    snapshot.durableRunScopeId === createMemoryRunExposureScopeId(snapshot) &&
    (!snapshot.previous ||
      (snapshot.previous.agentId === snapshot.agentId &&
        snapshot.previous.sessionId === snapshot.sessionId &&
        snapshot.previous.runId === snapshot.runId)),
  );
}

function persistMemoryRunExposureInTransaction(params: {
  database: OpenClawAgentDatabase;
  snapshot: MemoryRunExposureSnapshot;
  sourcePolicySetIdsJson: string;
  exposedResourceRevisionsJson: string;
  exposureReceiptIdsJson: string;
  egressReceiptIdsJson: string;
  deliveryAudiencesJson: string;
}): void {
  const { database, snapshot } = params;
  ensureMemoryPreoutputExposureLedgerSchemaInTransaction(database.db);
  const db = getNodeSqliteKysely<MemoryPreoutputExposureLedgerDatabase>(database.db);
  const inserted = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("memory_preoutput_exposure_ledger")
      .values({
        agent_id: snapshot.agentId,
        session_id: snapshot.sessionId,
        run_id: snapshot.runId,
        revision_number: snapshot.revisionNumber,
        exposure_set_id: snapshot.exposureSetId,
        previous_exposure_set_id: snapshot.previous?.exposureSetId ?? null,
        session_key: snapshot.sessionKey,
        context_fingerprint: snapshot.contextFingerprint,
        plan_id: snapshot.planId,
        memory_policy_revision: snapshot.memoryPolicyRevision,
        source_policy_set_ids_json: params.sourcePolicySetIdsJson,
        exposed_resource_revisions_json: params.exposedResourceRevisionsJson,
        exposure_receipt_ids_json: params.exposureReceiptIdsJson,
        egress_receipt_ids_json: params.egressReceiptIdsJson,
        delivery_audiences_json: params.deliveryAudiencesJson,
        delivery_revision: snapshot.deliveryRevision,
        egress_registry_revision: snapshot.egressRegistryRevision,
        session_identity_revision: snapshot.sessionIdentityRevision,
        subject_revision: snapshot.subjectRevision,
        created_at: snapshot.createdAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["agent_id", "session_id", "run_id", "revision_number"]).doNothing(),
      ),
  );
  if (inserted.numAffectedRows !== 1n) {
    throw new Error("memory exposure revision already has a durable ledger row");
  }
}

/**
 * Commits a content-free audit row before a broker can publish selected-plugin content.
 * A duplicate revision is a concurrent/stale invocation, not a successful idempotent exposure.
 */
export function persistMemoryRunExposureBeforeContent(
  snapshot: MemoryRunExposureSnapshot,
): boolean {
  const sourcePolicySetIdsJson = canonicalStrings(snapshot.sourcePolicySetIds);
  const exposedResourceRevisionsJson = canonicalStrings(snapshot.exposedResourceRevisions);
  const exposureReceiptIdsJson = canonicalStrings(snapshot.exposureReceiptIds);
  const egressReceiptIdsJson = canonicalStrings(snapshot.egressReceiptIds);
  const deliveryAudiencesJson = canonicalAudiences(snapshot);
  if (
    !isDurableSnapshot(snapshot) ||
    !sourcePolicySetIdsJson ||
    !exposedResourceRevisionsJson ||
    !exposureReceiptIdsJson ||
    !egressReceiptIdsJson ||
    !deliveryAudiencesJson
  ) {
    return false;
  }
  try {
    return persistMemoryRunExposureBeforeContentInDatabase({
      database: openOpenClawAgentDatabase({ agentId: snapshot.agentId }),
      snapshot,
    });
  } catch {
    logMemoryExposureLedgerDiagnostic("persist-failed");
    return false;
  }
}

/** Uses an already-owned agent DB for deterministic test and lifecycle setup. */
export function persistMemoryRunExposureBeforeContentInDatabase(params: {
  database: OpenClawAgentDatabase;
  snapshot: MemoryRunExposureSnapshot;
}): boolean {
  const { database, snapshot } = params;
  const sourcePolicySetIdsJson = canonicalStrings(snapshot.sourcePolicySetIds);
  const exposedResourceRevisionsJson = canonicalStrings(snapshot.exposedResourceRevisions);
  const exposureReceiptIdsJson = canonicalStrings(snapshot.exposureReceiptIds);
  const egressReceiptIdsJson = canonicalStrings(snapshot.egressReceiptIds);
  const deliveryAudiencesJson = canonicalAudiences(snapshot);
  if (
    database.agentId !== snapshot.agentId ||
    !isDurableSnapshot(snapshot) ||
    !sourcePolicySetIdsJson ||
    !exposedResourceRevisionsJson ||
    !exposureReceiptIdsJson ||
    !egressReceiptIdsJson ||
    !deliveryAudiencesJson
  ) {
    return false;
  }
  try {
    runSqliteImmediateTransactionSync(database.db, () => {
      persistMemoryRunExposureInTransaction({
        database,
        snapshot,
        sourcePolicySetIdsJson,
        exposedResourceRevisionsJson,
        exposureReceiptIdsJson,
        egressReceiptIdsJson,
        deliveryAudiencesJson,
      });
    });
    return true;
  } catch {
    logMemoryExposureLedgerDiagnostic("persist-failed");
    return false;
  }
}

/**
 * Rehydrates the immutable, session-bound exposure lineage from the pre-output ledger.
 * Transcript companions use this durable authority after a gateway restart, never the process Map.
 */
export function readDurableMemoryRunExposure(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  runId: string;
}): MemoryRunExposureSnapshot | undefined {
  try {
    return readDurableMemoryRunExposureOrThrow(params);
  } catch {
    return undefined;
  }
}

function readDurableMemoryRunExposureOrThrow(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  runId: string;
}): MemoryRunExposureSnapshot | undefined {
  const db = getNodeSqliteKysely<MemoryPreoutputExposureLedgerDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("memory_preoutput_exposure_ledger")
      .selectAll()
      .where("agent_id", "=", params.database.agentId)
      .where("session_id", "=", params.sessionId)
      .where("run_id", "=", params.runId)
      .orderBy("revision_number", "asc"),
  ).rows;
  let previous: MemoryRunExposureSnapshot | undefined;
  for (const row of rows) {
    const sourcePolicySetIds = parseCanonicalStrings(row.source_policy_set_ids_json);
    const exposedResourceRevisions = parseCanonicalStrings(row.exposed_resource_revisions_json);
    const exposureReceiptIds = parseCanonicalStrings(row.exposure_receipt_ids_json);
    const egressReceiptIds = parseCanonicalStrings(row.egress_receipt_ids_json);
    const deliveryAudiences = parseCanonicalAudiences(row.delivery_audiences_json);
    if (
      !sourcePolicySetIds ||
      !exposedResourceRevisions ||
      !exposureReceiptIds ||
      !egressReceiptIds ||
      !deliveryAudiences ||
      !row.session_key.trim() ||
      !row.context_fingerprint.trim() ||
      !row.plan_id.trim() ||
      !row.memory_policy_revision.trim() ||
      !row.delivery_revision.trim() ||
      !row.egress_registry_revision.trim() ||
      !row.session_identity_revision.trim() ||
      !row.subject_revision.trim() ||
      row.revision_number !== (previous?.revisionNumber ?? 0) + 1 ||
      row.previous_exposure_set_id !== (previous?.exposureSetId ?? null)
    ) {
      throw new Error("memory exposure ledger has an invalid durable lineage");
    }
    previous = Object.freeze({
      exposureSetId: row.exposure_set_id,
      revisionNumber: row.revision_number,
      ...(previous ? { previous } : {}),
      agentId: row.agent_id,
      sessionId: row.session_id,
      sessionKey: row.session_key,
      runId: row.run_id,
      durableRunScopeId: createMemoryRunExposureScopeId({
        agentId: row.agent_id,
        sessionId: row.session_id,
        runId: row.run_id,
      }),
      contextFingerprint: row.context_fingerprint,
      planId: row.plan_id,
      memoryPolicyRevision: row.memory_policy_revision,
      sourcePolicySetIds,
      exposedResourceRevisions,
      exposureReceiptIds,
      egressReceiptIds,
      deliveryAudiences,
      deliveryRevision: row.delivery_revision,
      egressRegistryRevision: row.egress_registry_revision,
      sessionIdentityRevision: row.session_identity_revision,
      subjectRevision: row.subject_revision,
      createdAt: row.created_at,
    }) satisfies MemoryRunExposureSnapshot;
  }
  return previous;
}

/**
 * Reconciles process state with the durable tail before preparing a new content release. A corrupt
 * or mismatched ledger fails the broker closed rather than advancing from an unsafe process tail.
 */
export function hydrateMemoryRunExposureFromLedger(params: {
  agentId: string;
  sessionId: string;
  runId: string;
}): boolean {
  try {
    const database = openOpenClawAgentDatabase({ agentId: params.agentId });
    ensureMemoryPreoutputExposureLedgerSchemaInTransaction(database.db);
    const snapshot = readDurableMemoryRunExposureOrThrow({
      database,
      sessionId: params.sessionId,
      runId: params.runId,
    });
    return reconcileMemoryRunExposureWithDurableLedger({
      ...params,
      durableSnapshot: snapshot,
    });
  } catch {
    logMemoryExposureLedgerDiagnostic("hydrate-failed");
    return false;
  }
}
