import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
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
  type DurableMemoryActorEvidence,
  type DurableMemoryDelegationSnapshot,
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
  memory_preoutput_exposure_authorization_facts: {
    exposure_set_id: string;
    actor_evidence_json: string;
    delegation_snapshot_json: string;
    host_facts_revision: string;
    created_at: number;
  };
};

type MemoryExposureLedgerDiagnostic = "hydrate-failed" | "persist-failed";

export type DurableMemoryRunExposureLookup =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "current"; snapshot: MemoryRunExposureSnapshot }>
  | Readonly<{ kind: "unavailable" }>;

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

function canonicalAudiences(
  snapshot: Pick<MemoryRunExposureSnapshot, "deliveryAudiences">,
): string | undefined {
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
    return canonicalAudiences({ deliveryAudiences: audiences }) === value
      ? Object.freeze(audiences)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalActorEvidence(value: DurableMemoryActorEvidence): string | undefined {
  if (value.kind === "principal") {
    if (
      !hasExactKeys(
        value,
        value.expiresAt === undefined
          ? ["actorKind", "assurance", "evidenceRevision", "kind", "principalId", "version"]
          : [
              "actorKind",
              "assurance",
              "evidenceRevision",
              "expiresAt",
              "kind",
              "principalId",
              "version",
            ],
      )
    ) {
      return undefined;
    }
    if (
      !["human", "agent", "service", "system"].includes(value.actorKind) ||
      !["gateway-profile", "adapter-attested", "oidc", "service"].includes(value.assurance) ||
      !value.principalId.trim() ||
      !value.evidenceRevision.trim()
    ) {
      return undefined;
    }
    if (
      value.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(value.expiresAt)) ||
        new Date(Date.parse(value.expiresAt)).toISOString() !== value.expiresAt)
    ) {
      return undefined;
    }
    return JSON.stringify({
      version: 1,
      kind: "principal",
      actorKind: value.actorKind,
      principalId: value.principalId,
      assurance: value.assurance,
      evidenceRevision: value.evidenceRevision,
      ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    });
  }
  if (!hasExactKeys(value, ["evidenceRevision", "kind", "transportAuditRef", "version"])) {
    return undefined;
  }
  return value.transportAuditRef.trim() && value.evidenceRevision.trim()
    ? JSON.stringify({
        version: 1,
        kind: "unattributed",
        transportAuditRef: value.transportAuditRef,
        evidenceRevision: value.evidenceRevision,
      })
    : undefined;
}

function canonicalDelegationSnapshot(value: DurableMemoryDelegationSnapshot): string | undefined {
  if (value.kind === "none") {
    return hasExactKeys(value, ["kind", "version"])
      ? JSON.stringify({ version: 1, kind: "none" })
      : undefined;
  }
  if (
    !hasExactKeys(value, [
      "allowedOperations",
      "capabilitySnapshotId",
      "depth",
      "kind",
      "maximumAudiences",
      "parentContextId",
      "parentMemoryPlanId",
      "rootContextId",
      "rootPrincipalId",
      "version",
    ])
  ) {
    return undefined;
  }
  const allowedOperations = [...new Set(value.allowedOperations)].toSorted();
  const maximumAudiences = canonicalAudiences({ deliveryAudiences: value.maximumAudiences });
  if (
    allowedOperations.length !== value.allowedOperations.length ||
    allowedOperations.some(
      (operation) =>
        ![
          "read",
          "append",
          "replace",
          "derive",
          "deposit",
          "project",
          "publish",
          "import",
          "export",
          "delete",
          "sync",
          "status",
          "policy-admin",
        ].includes(operation),
    ) ||
    !maximumAudiences ||
    !value.rootPrincipalId.trim() ||
    !value.rootContextId.trim() ||
    !value.parentContextId.trim() ||
    !value.parentMemoryPlanId.trim() ||
    !value.capabilitySnapshotId.trim() ||
    !Number.isSafeInteger(value.depth) ||
    value.depth < 0
  ) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    kind: "delegated",
    rootPrincipalId: value.rootPrincipalId,
    rootContextId: value.rootContextId,
    parentContextId: value.parentContextId,
    parentMemoryPlanId: value.parentMemoryPlanId,
    capabilitySnapshotId: value.capabilitySnapshotId,
    allowedOperations,
    maximumAudiences: JSON.parse(maximumAudiences),
    depth: value.depth,
  });
}

function parseCanonicalActorEvidence(value: string): DurableMemoryActorEvidence | undefined {
  try {
    const parsed = JSON.parse(value) as DurableMemoryActorEvidence;
    const canonical = canonicalActorEvidence(parsed);
    return canonical === value ? Object.freeze(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function parseCanonicalDelegationSnapshot(
  value: string,
): DurableMemoryDelegationSnapshot | undefined {
  try {
    const parsed = JSON.parse(value) as DurableMemoryDelegationSnapshot;
    const canonical = canonicalDelegationSnapshot(parsed);
    return canonical === value ? Object.freeze(parsed) : undefined;
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
    snapshot.hostFactsRevision.trim() &&
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
  actorEvidenceJson: string;
  delegationSnapshotJson: string;
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
  const factsInserted = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("memory_preoutput_exposure_authorization_facts")
      .values({
        exposure_set_id: snapshot.exposureSetId,
        actor_evidence_json: params.actorEvidenceJson,
        delegation_snapshot_json: params.delegationSnapshotJson,
        host_facts_revision: snapshot.hostFactsRevision,
        created_at: snapshot.createdAt,
      })
      .onConflict((conflict) => conflict.column("exposure_set_id").doNothing()),
  );
  if (factsInserted.numAffectedRows !== 1n) {
    throw new Error("memory exposure revision already has durable authorization facts");
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
  const actorEvidenceJson = canonicalActorEvidence(snapshot.actorEvidence);
  const delegationSnapshotJson = canonicalDelegationSnapshot(snapshot.delegationSnapshot);
  if (
    !isDurableSnapshot(snapshot) ||
    !sourcePolicySetIdsJson ||
    !exposedResourceRevisionsJson ||
    !exposureReceiptIdsJson ||
    !egressReceiptIdsJson ||
    !deliveryAudiencesJson ||
    !actorEvidenceJson ||
    !delegationSnapshotJson
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
  const actorEvidenceJson = canonicalActorEvidence(snapshot.actorEvidence);
  const delegationSnapshotJson = canonicalDelegationSnapshot(snapshot.delegationSnapshot);
  if (
    database.agentId !== snapshot.agentId ||
    !isDurableSnapshot(snapshot) ||
    !sourcePolicySetIdsJson ||
    !exposedResourceRevisionsJson ||
    !exposureReceiptIdsJson ||
    !egressReceiptIdsJson ||
    !deliveryAudiencesJson ||
    !actorEvidenceJson ||
    !delegationSnapshotJson
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
        actorEvidenceJson,
        delegationSnapshotJson,
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

/**
 * Reads the ledger's durable tail for a delivery decision.  Absence is distinct from an
 * unreadable/corrupt ledger: an unexposed run may reply, but a scoped run never guesses.
 */
export function readLatestDurableMemoryRunExposure(params: {
  agentId: string;
  sessionId: string;
  runId: string;
}): DurableMemoryRunExposureLookup {
  try {
    const database = openOpenClawAgentDatabase({ agentId: params.agentId });
    ensureMemoryPreoutputExposureLedgerSchemaInTransaction(database.db);
    const snapshot = readDurableMemoryRunExposureOrThrow({
      database,
      sessionId: params.sessionId,
      runId: params.runId,
    });
    return snapshot
      ? Object.freeze({ kind: "current", snapshot })
      : Object.freeze({ kind: "absent" });
  } catch {
    logMemoryExposureLedgerDiagnostic("hydrate-failed");
    return Object.freeze({ kind: "unavailable" });
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
    const facts = executeSqliteQueryTakeFirstSync(
      params.database.db,
      db
        .selectFrom("memory_preoutput_exposure_authorization_facts")
        .select([
          "actor_evidence_json",
          "delegation_snapshot_json",
          "host_facts_revision",
          "created_at",
        ])
        .where("exposure_set_id", "=", row.exposure_set_id)
        .limit(1),
    );
    const actorEvidence = facts && parseCanonicalActorEvidence(facts.actor_evidence_json);
    const delegationSnapshot =
      facts && parseCanonicalDelegationSnapshot(facts.delegation_snapshot_json);
    if (
      !sourcePolicySetIds ||
      !exposedResourceRevisions ||
      !exposureReceiptIds ||
      !egressReceiptIds ||
      !deliveryAudiences ||
      !actorEvidence ||
      !delegationSnapshot ||
      !facts?.host_facts_revision.trim() ||
      facts.created_at !== row.created_at ||
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
      actorEvidence,
      delegationSnapshot,
      hostFactsRevision: facts.host_facts_revision,
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
