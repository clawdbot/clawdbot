import type { DatabaseSync } from "node:sqlite";
import { pseudonymizeExecutionIdentityRef } from "../audit/audit-identity.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { ensureMemoryIdentitySchema } from "./memory-identity.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_enterprise_principal_evidence (";
const SCHEMA_END = "CREATE TABLE IF NOT EXISTS memory_access_audit (";
const MAX_EVIDENCE_TRANSITIONS = 100;
const SQLITE_IN_VALUES_LIMIT = 900;
const ensuredDatabases = new WeakSet<DatabaseSync>();

type EnterpriseIdentityDatabase = {
  audit_identity_keys: {
    id: number;
    key_id: string;
    key: Uint8Array;
    created_at: number;
  };
  memory_principals: {
    principal_id: string;
    principal_kind: "user" | "enterprise" | "service" | "agent" | "system" | "conversation";
    user_profile_id: string | null;
    principal_lookup_hmac: string | null;
    state: "active" | "revoked";
    revision: string;
    created_at: number;
    revoked_at: number | null;
  };
  memory_enterprise_principal_evidence: {
    principal_id: string;
    provider_id: string;
    issuer_ref: string;
    tenant_ref: string;
    subject_ref: string;
    assurance: "oidc";
    evidence_revision: string;
    observed_at: number;
    expires_at: number;
    revoked_at: number | null;
  };
  memory_enterprise_membership_snapshots: {
    snapshot_id: string;
    principal_id: string;
    provider_id: string;
    tenant_ref: string;
    group_ref: string;
    evidence_revision: string;
    observed_at: number;
    expires_at: number;
    revoked_at: number | null;
    created_at: number;
  };
  memory_enterprise_evidence_transitions: {
    transition_id: string;
    principal_id: string;
    provider_id: string;
    kind: "refresh" | "revoke";
    revoked_at: number;
    created_at: number;
  };
  memory_enterprise_evidence_transition_memberships: {
    transition_id: string;
    snapshot_id: string;
    created_at: number;
  };
  memory_enterprise_evidence_transition_profile_links: {
    transition_id: string;
    link_id: string;
    user_principal_id: string;
    created_at: number;
  };
  memory_enterprise_profile_links: {
    link_id: string;
    enterprise_principal_id: string;
    user_principal_id: string;
    created_by_principal_id: string;
    created_at: number;
    revoked_at: number | null;
    revision: string;
  };
  memory_enterprise_identity_actions: {
    action_id: string;
    target_user_principal_id: string;
    actor_principal_id: string;
    provider_id: string;
    kind: "unlink" | "revoke";
    affected_identity_count: number;
    affected_snapshot_count: number;
    occurred_at: number;
  };
};

type EnterprisePrincipalEvidenceRow =
  EnterpriseIdentityDatabase["memory_enterprise_principal_evidence"] & {
    principal_revision: string;
    principal_state: "active" | "revoked";
  };

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end <= start) {
    throw new Error("canonical enterprise memory identity schema markers are missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end).trim();
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedEvidenceTransitionLimit(value: number | undefined): number {
  if (value === undefined) {
    return MAX_EVIDENCE_TRANSITIONS;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(value, MAX_EVIDENCE_TRANSITIONS);
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function ensureFutureExpiry(observedAt: number, expiresAt: number): void {
  if (expiresAt <= observedAt) {
    throw new TypeError("expiresAt must be after observedAt");
  }
}

function validateVerifiedEnterprisePrincipal(verified: VerifiedEnterprisePrincipal): void {
  requireText(verified.providerId, "providerId");
  requireText(verified.issuer, "issuer");
  requireText(verified.tenant, "tenant");
  requireText(verified.subject, "subject");
  requireText(verified.evidenceRevision, "evidenceRevision");
  ensureFutureExpiry(
    requireTimestamp(verified.observedAt, "observedAt"),
    requireTimestamp(verified.expiresAt, "expiresAt"),
  );
}

function enterpriseRef(db: DatabaseSync, providerId: string, kind: string, value: string): string {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind: "principal",
    scope: `memory-enterprise:${kind}:v1:${providerId}`,
    value,
  });
}

function enterprisePrincipalLookup(
  db: DatabaseSync,
  providerId: string,
  issuer: string,
  tenant: string,
  subject: string,
): string {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind: "principal",
    scope: `memory-enterprise:principal:v1:${providerId}`,
    value: `${issuer}\u0000${tenant}\u0000${subject}`,
  });
}

function toPrincipal(row: EnterprisePrincipalEvidenceRow): MemoryEnterprisePrincipal {
  return Object.freeze({
    principalId: row.principal_id,
    providerId: row.provider_id,
    evidenceRevision: row.evidence_revision,
    revision: row.principal_revision,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  });
}

function toMembership(
  row: EnterpriseIdentityDatabase["memory_enterprise_membership_snapshots"],
): MemoryEnterpriseMembershipSnapshot {
  return Object.freeze({
    snapshotId: row.snapshot_id,
    principalId: row.principal_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    groupRef: row.group_ref,
    evidenceRevision: row.evidence_revision,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  });
}

/** Canonical lazy DDL for enterprise identities and revisioned memberships. */
export const MEMORY_ENTERPRISE_IDENTITY_SCHEMA_SQL = extractSchema();

export type MemoryEnterprisePrincipal = Readonly<{
  principalId: string;
  providerId: string;
  evidenceRevision: string;
  revision: string;
  observedAt: number;
  expiresAt: number;
}>;

export type MemoryEnterpriseMembershipSnapshot = Readonly<{
  snapshotId: string;
  principalId: string;
  providerId: string;
  tenantRef: string;
  groupRef: string;
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}>;

export type MemoryEnterpriseProfileLink = Readonly<{
  linkId: string;
  enterprisePrincipalId: string;
  userPrincipalId: string;
  revision: string;
}>;

/** Count-only outcome of an explicit redacted enterprise identity control. */
export type MemoryEnterpriseIdentityActionResult = Readonly<{
  providerId: string;
  kind: "unlink" | "revoke";
  affectedIdentityCount: number;
  affectedSnapshotCount: number;
}>;

/** Redacted lifecycle evidence for an identity link's refresh or removal. */
export type MemoryEnterpriseEvidenceTransition = Readonly<{
  providerId: string;
  kind: "refresh" | "revoke";
  revokedAt: number;
  snapshotCount: number;
}>;

/** Internal transition inputs for the content-free revocation-impact projection. */
export type MemoryEnterpriseEvidenceTransitionImpactInput = Readonly<{
  transition: MemoryEnterpriseEvidenceTransition;
  snapshotIds: readonly string[];
}>;

/**
 * The future core verifier is the only caller permitted to pass upstream ids.
 * This state owner reduces them before any durable write and exposes only refs.
 */
export type VerifiedEnterprisePrincipal = Readonly<{
  providerId: string;
  issuer: string;
  tenant: string;
  subject: string;
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
  principalId?: string;
}>;

export type VerifiedEnterpriseMembership = Readonly<{
  principalId: string;
  providerId: string;
  tenant: string;
  group: string;
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
  snapshotId?: string;
}>;

export type PersistedMemoryEnterpriseIdentity = Readonly<{
  principal: MemoryEnterprisePrincipal;
  memberships: readonly MemoryEnterpriseMembershipSnapshot[];
}>;

/** Create the additive enterprise tables only on their first use. */
export function ensureMemoryEnterpriseIdentitySchema(
  options: OpenClawStateDatabaseOptions = {},
): void {
  ensureMemoryIdentitySchema(options);
  const database = openOpenClawStateDatabase(options).db;
  if (ensuredDatabases.has(database)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => db.exec(MEMORY_ENTERPRISE_IDENTITY_SCHEMA_SQL),
    options,
    { operationLabel: "memory-enterprise-identity.schema.ensure" },
  );
  ensuredDatabases.add(database);
}

function ensureSchemaInTransaction(database: DatabaseSync): void {
  if (ensuredDatabases.has(database)) {
    return;
  }
  database.exec(MEMORY_ENTERPRISE_IDENTITY_SCHEMA_SQL); // sqlite-allow-raw -- canonical additive DDL.
  ensuredDatabases.add(database);
}

function selectEvidence(
  database: DatabaseSync,
  providerId: string,
  tenantRef: string,
  subjectRef: string,
): EnterprisePrincipalEvidenceRow | undefined {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("memory_enterprise_principal_evidence")
      .innerJoin(
        "memory_principals",
        "memory_principals.principal_id",
        "memory_enterprise_principal_evidence.principal_id",
      )
      .select([
        "memory_enterprise_principal_evidence.principal_id",
        "memory_enterprise_principal_evidence.provider_id",
        "memory_enterprise_principal_evidence.issuer_ref",
        "memory_enterprise_principal_evidence.tenant_ref",
        "memory_enterprise_principal_evidence.subject_ref",
        "memory_enterprise_principal_evidence.assurance",
        "memory_enterprise_principal_evidence.evidence_revision",
        "memory_enterprise_principal_evidence.observed_at",
        "memory_enterprise_principal_evidence.expires_at",
        "memory_enterprise_principal_evidence.revoked_at",
        "memory_principals.revision as principal_revision",
        "memory_principals.state as principal_state",
      ])
      .where("memory_enterprise_principal_evidence.provider_id", "=", providerId)
      .where("memory_enterprise_principal_evidence.tenant_ref", "=", tenantRef)
      .where("memory_enterprise_principal_evidence.subject_ref", "=", subjectRef),
  ).rows as EnterprisePrincipalEvidenceRow[];
  if (rows.length > 1) {
    // The partial unique index prevents this under normal writes. A damaged
    // database must not let whichever row SQLite happens to return become authority.
    throw new Error("enterprise principal evidence has conflicting active canonical bindings");
  }
  return rows[0];
}

function selectCurrentPrincipal(
  database: DatabaseSync,
  principalId: string,
  providerId: string,
  now: number,
): EnterprisePrincipalEvidenceRow | undefined {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_principal_evidence")
      .innerJoin(
        "memory_principals",
        "memory_principals.principal_id",
        "memory_enterprise_principal_evidence.principal_id",
      )
      .select([
        "memory_enterprise_principal_evidence.principal_id",
        "memory_enterprise_principal_evidence.provider_id",
        "memory_enterprise_principal_evidence.issuer_ref",
        "memory_enterprise_principal_evidence.tenant_ref",
        "memory_enterprise_principal_evidence.subject_ref",
        "memory_enterprise_principal_evidence.assurance",
        "memory_enterprise_principal_evidence.evidence_revision",
        "memory_enterprise_principal_evidence.observed_at",
        "memory_enterprise_principal_evidence.expires_at",
        "memory_enterprise_principal_evidence.revoked_at",
        "memory_principals.revision as principal_revision",
        "memory_principals.state as principal_state",
      ])
      .where("memory_enterprise_principal_evidence.principal_id", "=", principalId)
      .where("memory_enterprise_principal_evidence.provider_id", "=", providerId)
      .where("memory_enterprise_principal_evidence.revoked_at", "is", null)
      .where("memory_principals.state", "=", "active")
      .where("memory_enterprise_principal_evidence.observed_at", "<=", now)
      .where("memory_enterprise_principal_evidence.expires_at", ">", now),
  ) as EnterprisePrincipalEvidenceRow | undefined;
}

function hasAuditIdentityKey(database: DatabaseSync): boolean {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database,
      db.selectFrom("audit_identity_keys").select("id").where("id", "=", 1),
    ),
  );
}

function ensureMemoryEnterprisePrincipalInTransaction(
  database: DatabaseSync,
  verified: VerifiedEnterprisePrincipal,
): MemoryEnterprisePrincipal {
  validateVerifiedEnterprisePrincipal(verified);
  const providerId = requireText(verified.providerId, "providerId");
  const issuer = requireText(verified.issuer, "issuer");
  const tenant = requireText(verified.tenant, "tenant");
  const subject = requireText(verified.subject, "subject");
  const evidenceRevision = requireText(verified.evidenceRevision, "evidenceRevision");
  const observedAt = requireTimestamp(verified.observedAt, "observedAt");
  const expiresAt = requireTimestamp(verified.expiresAt, "expiresAt");
  ensureFutureExpiry(observedAt, expiresAt);
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const issuerRef = enterpriseRef(database, providerId, "issuer", issuer);
  const tenantRef = enterpriseRef(database, providerId, "tenant", tenant);
  const subjectRef = enterpriseRef(database, providerId, "subject", subject);
  const existing = selectEvidence(database, providerId, tenantRef, subjectRef);
  if (existing) {
    if (existing.issuer_ref !== issuerRef || existing.principal_state !== "active") {
      throw new Error("enterprise principal evidence conflicts with the canonical binding");
    }
    executeSqliteQuerySync(
      database,
      db
        .updateTable("memory_enterprise_principal_evidence")
        .set({
          evidence_revision: evidenceRevision,
          observed_at: observedAt,
          expires_at: expiresAt,
          revoked_at: null,
        })
        .where("principal_id", "=", existing.principal_id),
    );
    return Object.freeze({
      ...toPrincipal(existing),
      evidenceRevision,
      observedAt,
      expiresAt,
    });
  }
  const principalId = verified.principalId
    ? requireText(verified.principalId, "principalId")
    : generateSecureUuid();
  const principal = {
    principal_id: principalId,
    principal_kind: "enterprise" as const,
    user_profile_id: null,
    principal_lookup_hmac: enterprisePrincipalLookup(database, providerId, issuer, tenant, subject),
    state: "active" as const,
    revision: generateSecureUuid(),
    created_at: Date.now(),
    revoked_at: null,
  };
  executeSqliteQuerySync(database, db.insertInto("memory_principals").values(principal));
  executeSqliteQuerySync(
    database,
    db.insertInto("memory_enterprise_principal_evidence").values({
      principal_id: principalId,
      provider_id: providerId,
      issuer_ref: issuerRef,
      tenant_ref: tenantRef,
      subject_ref: subjectRef,
      assurance: "oidc",
      evidence_revision: evidenceRevision,
      observed_at: observedAt,
      expires_at: expiresAt,
      revoked_at: null,
    }),
  );
  return Object.freeze({
    principalId,
    providerId,
    evidenceRevision,
    revision: principal.revision,
    observedAt,
    expiresAt,
  });
}

function writeMemoryEnterpriseMembershipSnapshotInTransaction(
  database: DatabaseSync,
  verified: VerifiedEnterpriseMembership,
): MemoryEnterpriseMembershipSnapshot {
  const providerId = requireText(verified.providerId, "providerId");
  const observedAt = requireTimestamp(verified.observedAt, "observedAt");
  const expiresAt = requireTimestamp(verified.expiresAt, "expiresAt");
  ensureFutureExpiry(observedAt, expiresAt);
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const principalId = requireText(verified.principalId, "principalId");
  const principal = selectCurrentPrincipal(database, principalId, providerId, observedAt);
  if (!principal) {
    throw new Error("enterprise membership snapshot requires current principal evidence");
  }
  if (principal.evidence_revision !== requireText(verified.evidenceRevision, "evidenceRevision")) {
    throw new Error(
      "enterprise membership snapshot must bind the current principal evidence revision",
    );
  }
  const tenantRef = enterpriseRef(
    database,
    providerId,
    "tenant",
    requireText(verified.tenant, "tenant"),
  );
  const groupRef = enterpriseRef(
    database,
    providerId,
    "group",
    requireText(verified.group, "group"),
  );
  const snapshot = {
    snapshot_id: verified.snapshotId
      ? requireText(verified.snapshotId, "snapshotId")
      : generateSecureUuid(),
    principal_id: principalId,
    provider_id: providerId,
    tenant_ref: tenantRef,
    group_ref: groupRef,
    evidence_revision: principal.evidence_revision,
    observed_at: observedAt,
    expires_at: expiresAt,
    revoked_at: null,
    created_at: Date.now(),
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("memory_enterprise_membership_snapshots")
      .values(snapshot)
      .onConflict((conflict) =>
        conflict
          .columns(["principal_id", "provider_id", "tenant_ref", "group_ref", "evidence_revision"])
          .doNothing(),
      ),
  );
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_membership_snapshots")
      .selectAll()
      .where("principal_id", "=", snapshot.principal_id)
      .where("provider_id", "=", snapshot.provider_id)
      .where("tenant_ref", "=", snapshot.tenant_ref)
      .where("group_ref", "=", snapshot.group_ref)
      .where("evidence_revision", "=", snapshot.evidence_revision),
  );
  if (!stored) {
    throw new Error("enterprise membership snapshot could not be persisted");
  }
  return toMembership(stored);
}

function recordMemoryEnterpriseEvidenceTransitionInTransaction(params: {
  database: DatabaseSync;
  principalId: string;
  providerId: string;
  kind: "refresh" | "revoke";
  revokedAt: number;
  snapshotIds: readonly string[];
}): void {
  const snapshotIds = [
    ...new Set(params.snapshotIds.map((snapshotId) => requireText(snapshotId, "snapshotId"))),
  ].toSorted();
  if (snapshotIds.length === 0) {
    return;
  }
  const transition = {
    transition_id: generateSecureUuid(),
    principal_id: requireText(params.principalId, "principalId"),
    provider_id: requireText(params.providerId, "providerId"),
    kind: params.kind,
    revoked_at: requireTimestamp(params.revokedAt, "revokedAt"),
    created_at: params.revokedAt,
  };
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(params.database);
  executeSqliteQuerySync(
    params.database,
    db.insertInto("memory_enterprise_evidence_transitions").values(transition),
  );
  executeSqliteQuerySync(
    params.database,
    db.insertInto("memory_enterprise_evidence_transition_memberships").values(
      snapshotIds.map((snapshotId) => ({
        transition_id: transition.transition_id,
        snapshot_id: snapshotId,
        created_at: transition.created_at,
      })),
    ),
  );
  const profileLink = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_enterprise_profile_links")
      .select(["link_id", "user_principal_id"])
      .where("enterprise_principal_id", "=", transition.principal_id)
      .where("revoked_at", "is", null),
  );
  if (profileLink) {
    // Preserve the link that owned this event. Querying the current link would
    // disclose historic lifecycle metadata after a profile relink.
    executeSqliteQuerySync(
      params.database,
      db.insertInto("memory_enterprise_evidence_transition_profile_links").values({
        transition_id: transition.transition_id,
        link_id: profileLink.link_id,
        user_principal_id: profileLink.user_principal_id,
        created_at: transition.created_at,
      }),
    );
  }
}

/** Create or refresh one canonical principal from verifier-owned enterprise evidence. */
export function ensureMemoryEnterprisePrincipal(
  verified: VerifiedEnterprisePrincipal,
  options: OpenClawStateDatabaseOptions = {},
): MemoryEnterprisePrincipal {
  validateVerifiedEnterprisePrincipal(verified);
  ensureMemoryEnterpriseIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      return ensureMemoryEnterprisePrincipalInTransaction(database, verified);
    },
    options,
    { operationLabel: "memory-enterprise-identity.principal.ensure" },
  );
}

/** Recheck current principal evidence; unavailable, expired, revoked, and unknown all fail closed. */
export function recheckMemoryEnterprisePrincipal(params: {
  principalId: string;
  providerId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryEnterprisePrincipal | undefined {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const database = openOpenClawStateDatabase(options).db;
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_principal_evidence")
      .innerJoin(
        "memory_principals",
        "memory_principals.principal_id",
        "memory_enterprise_principal_evidence.principal_id",
      )
      .select([
        "memory_enterprise_principal_evidence.principal_id",
        "memory_enterprise_principal_evidence.provider_id",
        "memory_enterprise_principal_evidence.issuer_ref",
        "memory_enterprise_principal_evidence.tenant_ref",
        "memory_enterprise_principal_evidence.subject_ref",
        "memory_enterprise_principal_evidence.assurance",
        "memory_enterprise_principal_evidence.evidence_revision",
        "memory_enterprise_principal_evidence.observed_at",
        "memory_enterprise_principal_evidence.expires_at",
        "memory_enterprise_principal_evidence.revoked_at",
        "memory_principals.revision as principal_revision",
        "memory_principals.state as principal_state",
      ])
      .where(
        "memory_enterprise_principal_evidence.principal_id",
        "=",
        requireText(params.principalId, "principalId"),
      )
      .where(
        "memory_enterprise_principal_evidence.provider_id",
        "=",
        requireText(params.providerId, "providerId"),
      )
      .where("memory_enterprise_principal_evidence.revoked_at", "is", null)
      .where("memory_principals.state", "=", "active")
      .where("memory_enterprise_principal_evidence.observed_at", "<=", now)
      .where("memory_enterprise_principal_evidence.expires_at", ">", now),
  ) as EnterprisePrincipalEvidenceRow | undefined;
  return row ? toPrincipal(row) : undefined;
}

/**
 * Associate current enterprise evidence with one Gateway user principal. This
 * is an explicit operator-owned identity link, never a `session_members`
 * write and never a substitute for current provider evidence.
 */
export function linkMemoryEnterpriseProfile(params: {
  enterprisePrincipalId: string;
  providerId: string;
  userPrincipalId: string;
  createdByPrincipalId: string;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}): MemoryEnterpriseProfileLink {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const enterprisePrincipalId = requireText(params.enterprisePrincipalId, "enterprisePrincipalId");
  const providerId = requireText(params.providerId, "providerId");
  const userPrincipalId = requireText(params.userPrincipalId, "userPrincipalId");
  const createdByPrincipalId = requireText(params.createdByPrincipalId, "createdByPrincipalId");
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      const now = params.now ?? Date.now();
      if (!selectCurrentPrincipal(database, enterprisePrincipalId, providerId, now)) {
        throw new Error("enterprise profile link requires current enterprise evidence");
      }
      const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
      const user = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_principals")
          .select(["principal_id", "principal_kind", "state"])
          .where("principal_id", "=", userPrincipalId)
          .where("principal_kind", "=", "user")
          .where("state", "=", "active"),
      );
      const operator = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_principals")
          .select(["principal_id", "principal_kind", "state"])
          .where("principal_id", "=", createdByPrincipalId)
          .where("principal_kind", "=", "user")
          .where("state", "=", "active"),
      );
      if (!user || !operator) {
        throw new Error("enterprise profile link requires active Gateway user principals");
      }
      const existing = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_enterprise_profile_links")
          .selectAll()
          .where("enterprise_principal_id", "=", enterprisePrincipalId)
          .where("revoked_at", "is", null),
      );
      if (existing?.user_principal_id === userPrincipalId) {
        return Object.freeze({
          linkId: existing.link_id,
          enterprisePrincipalId,
          userPrincipalId,
          revision: existing.revision,
        });
      }
      if (existing) {
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_enterprise_profile_links")
            .set({ revoked_at: now })
            .where("link_id", "=", existing.link_id)
            .where("revoked_at", "is", null),
        );
      }
      const link = {
        link_id: generateSecureUuid(),
        enterprise_principal_id: enterprisePrincipalId,
        user_principal_id: userPrincipalId,
        created_by_principal_id: createdByPrincipalId,
        created_at: now,
        revoked_at: null,
        revision: generateSecureUuid(),
      };
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_enterprise_profile_links").values(link),
      );
      return Object.freeze({
        linkId: link.link_id,
        enterprisePrincipalId,
        userPrincipalId,
        revision: link.revision,
      });
    },
    options,
    { operationLabel: "memory-enterprise-identity.profile-link" },
  );
}

/** Recheck the explicit profile association and current provider evidence together. */
export function recheckMemoryEnterpriseProfileLink(params: {
  enterprisePrincipalId: string;
  userPrincipalId: string;
  providerId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryEnterpriseProfileLink | undefined {
  const options = params.options ?? {};
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const enterprisePrincipalId = requireText(params.enterprisePrincipalId, "enterprisePrincipalId");
  const userPrincipalId = requireText(params.userPrincipalId, "userPrincipalId");
  const providerId = requireText(params.providerId, "providerId");
  ensureMemoryEnterpriseIdentitySchema(options);
  const database = openOpenClawStateDatabase(options).db;
  if (!selectCurrentPrincipal(database, enterprisePrincipalId, providerId, now)) {
    return undefined;
  }
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_profile_links")
      .innerJoin(
        "memory_principals as users",
        "users.principal_id",
        "memory_enterprise_profile_links.user_principal_id",
      )
      .select([
        "memory_enterprise_profile_links.link_id",
        "memory_enterprise_profile_links.enterprise_principal_id",
        "memory_enterprise_profile_links.user_principal_id",
        "memory_enterprise_profile_links.revision",
      ])
      .where("memory_enterprise_profile_links.enterprise_principal_id", "=", enterprisePrincipalId)
      .where("memory_enterprise_profile_links.user_principal_id", "=", userPrincipalId)
      .where("memory_enterprise_profile_links.revoked_at", "is", null)
      .where("users.principal_kind", "=", "user")
      .where("users.state", "=", "active"),
  );
  return row
    ? Object.freeze({
        linkId: row.link_id,
        enterprisePrincipalId: row.enterprise_principal_id,
        userPrincipalId: row.user_principal_id,
        revision: row.revision,
      })
    : undefined;
}

/** Persist one immutable membership snapshot from a verified provider response. */
export function writeMemoryEnterpriseMembershipSnapshot(
  verified: VerifiedEnterpriseMembership,
  options: OpenClawStateDatabaseOptions = {},
): MemoryEnterpriseMembershipSnapshot {
  requireText(verified.providerId, "providerId");
  ensureFutureExpiry(
    requireTimestamp(verified.observedAt, "observedAt"),
    requireTimestamp(verified.expiresAt, "expiresAt"),
  );
  ensureMemoryEnterpriseIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      return writeMemoryEnterpriseMembershipSnapshotInTransaction(database, verified);
    },
    options,
    { operationLabel: "memory-enterprise-identity.membership.write" },
  );
}

/**
 * Atomically replace verifier-owned enterprise evidence. Superseded membership
 * snapshots are revoked before the new principal revision can become readable.
 */
export function persistMemoryEnterpriseIdentity(params: {
  verified: VerifiedEnterprisePrincipal;
  groups: readonly string[];
  options?: OpenClawStateDatabaseOptions;
}): PersistedMemoryEnterpriseIdentity {
  const options = params.options ?? {};
  const verified = params.verified;
  const providerId = requireText(verified.providerId, "providerId");
  const evidenceRevision = requireText(verified.evidenceRevision, "evidenceRevision");
  const observedAt = requireTimestamp(verified.observedAt, "observedAt");
  const expiresAt = requireTimestamp(verified.expiresAt, "expiresAt");
  validateVerifiedEnterprisePrincipal(verified);
  const groups = [...new Set(params.groups.map((group) => requireText(group, "group")))].toSorted();
  if (groups.length > 1_000) {
    throw new RangeError("enterprise membership snapshot exceeds 1000 groups");
  }
  ensureMemoryEnterpriseIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      const principal = ensureMemoryEnterprisePrincipalInTransaction(database, verified);
      const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
      const supersededSnapshotIds = executeSqliteQuerySync(
        database,
        db
          .selectFrom("memory_enterprise_membership_snapshots")
          .select("snapshot_id")
          .where("principal_id", "=", principal.principalId)
          .where("provider_id", "=", providerId)
          .where("evidence_revision", "!=", evidenceRevision)
          .where("revoked_at", "is", null)
          .orderBy("snapshot_id", "asc"),
      ).rows.map((snapshot) => snapshot.snapshot_id);
      executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_enterprise_membership_snapshots")
          .set({ revoked_at: observedAt })
          .where("principal_id", "=", principal.principalId)
          .where("provider_id", "=", providerId)
          .where("evidence_revision", "!=", evidenceRevision)
          .where("revoked_at", "is", null),
      );
      recordMemoryEnterpriseEvidenceTransitionInTransaction({
        database,
        principalId: principal.principalId,
        providerId,
        kind: "refresh",
        revokedAt: observedAt,
        snapshotIds: supersededSnapshotIds,
      });
      const memberships = Object.freeze(
        groups.map((group) =>
          writeMemoryEnterpriseMembershipSnapshotInTransaction(database, {
            principalId: principal.principalId,
            providerId,
            tenant: verified.tenant,
            group,
            evidenceRevision,
            observedAt,
            expiresAt,
          }),
        ),
      );
      return Object.freeze({ principal, memberships });
    },
    options,
    { operationLabel: "memory-enterprise-identity.persist" },
  );
}

/** Revoke one snapshot immediately; its immutable evidence remains auditable but unusable. */
export function revokeMemoryEnterpriseMembershipSnapshot(params: {
  snapshotId: string;
  revokedAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
      const snapshotId = requireText(params.snapshotId, "snapshotId");
      const revokedAt = requireTimestamp(params.revokedAt ?? Date.now(), "revokedAt");
      const snapshot = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_enterprise_membership_snapshots")
          .select(["snapshot_id", "principal_id", "provider_id"])
          .where("snapshot_id", "=", snapshotId)
          .where("revoked_at", "is", null)
          .limit(1),
      );
      if (!snapshot) {
        return;
      }
      const revoked = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_enterprise_membership_snapshots")
          .set({ revoked_at: revokedAt })
          .where("snapshot_id", "=", snapshot.snapshot_id)
          .where("revoked_at", "is", null),
      );
      if (revoked.numAffectedRows !== 1n) {
        throw new Error("enterprise membership snapshot changed during revocation");
      }
      recordMemoryEnterpriseEvidenceTransitionInTransaction({
        database,
        principalId: snapshot.principal_id,
        providerId: snapshot.provider_id,
        kind: "revoke",
        revokedAt,
        snapshotIds: [snapshot.snapshot_id],
      });
    },
    options,
    { operationLabel: "memory-enterprise-identity.membership.revoke" },
  );
}

function requireEnterpriseIdentityActionPrincipalsInTransaction(params: {
  database: DatabaseSync;
  userPrincipalId: string;
  actorPrincipalId: string;
}): void {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(params.database);
  const target = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_principals")
      .select(["principal_kind"])
      .where("principal_id", "=", params.userPrincipalId),
  );
  if (target?.principal_kind !== "user") {
    throw new Error("enterprise identity action requires a Gateway user principal target");
  }
  const actor = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_principals")
      .select(["principal_kind", "state"])
      .where("principal_id", "=", params.actorPrincipalId),
  );
  if (actor?.principal_kind !== "user" || actor.state !== "active") {
    throw new Error("enterprise identity action requires an active Gateway user principal actor");
  }
}

function listActiveEnterpriseProfileLinksInTransaction(params: {
  database: DatabaseSync;
  userPrincipalId: string;
  providerId: string;
}): readonly Readonly<{ linkId: string; enterprisePrincipalId: string }>[] {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(params.database);
  return Object.freeze(
    executeSqliteQuerySync(
      params.database,
      db
        .selectFrom("memory_enterprise_profile_links as link")
        .innerJoin(
          "memory_enterprise_principal_evidence as evidence",
          "evidence.principal_id",
          "link.enterprise_principal_id",
        )
        .select(["link.link_id as linkId", "link.enterprise_principal_id as enterprisePrincipalId"])
        .where("link.user_principal_id", "=", params.userPrincipalId)
        .where("link.revoked_at", "is", null)
        .where("evidence.provider_id", "=", params.providerId)
        .orderBy("link.link_id", "asc"),
    ).rows,
  );
}

function writeMemoryEnterpriseIdentityActionInTransaction(params: {
  database: DatabaseSync;
  userPrincipalId: string;
  actorPrincipalId: string;
  providerId: string;
  kind: "unlink" | "revoke";
  affectedIdentityCount: number;
  affectedSnapshotCount: number;
  occurredAt: number;
}): void {
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(params.database);
  executeSqliteQuerySync(
    params.database,
    db.insertInto("memory_enterprise_identity_actions").values({
      action_id: generateSecureUuid(),
      target_user_principal_id: params.userPrincipalId,
      actor_principal_id: params.actorPrincipalId,
      provider_id: params.providerId,
      kind: params.kind,
      affected_identity_count: params.affectedIdentityCount,
      affected_snapshot_count: params.affectedSnapshotCount,
      occurred_at: params.occurredAt,
    }),
  );
}

function revokeEnterpriseProfileLinksInTransaction(params: {
  database: DatabaseSync;
  links: readonly Readonly<{ linkId: string; enterprisePrincipalId: string }>[];
  revokedAt: number;
}): void {
  if (params.links.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(params.database);
  for (const linkIds of chunks(
    params.links.map((link) => link.linkId),
    SQLITE_IN_VALUES_LIMIT,
  )) {
    const updated = executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_enterprise_profile_links")
        .set({ revoked_at: params.revokedAt })
        .where("link_id", "in", linkIds)
        .where("revoked_at", "is", null),
    );
    if (updated.numAffectedRows !== BigInt(linkIds.length)) {
      throw new Error("enterprise profile link changed during revocation");
    }
  }
}

function enterpriseIdentityActionResult(params: {
  providerId: string;
  kind: "unlink" | "revoke";
  affectedIdentityCount: number;
  affectedSnapshotCount: number;
}): MemoryEnterpriseIdentityActionResult {
  return Object.freeze(params);
}

/**
 * Remove one profile's current association with a provider without erasing
 * verified evidence, lifecycle history, access audit, or prior exposure.
 */
export function unlinkMemoryEnterpriseProfile(params: {
  userPrincipalId: string;
  providerId: string;
  actorPrincipalId: string;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}): MemoryEnterpriseIdentityActionResult {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const userPrincipalId = requireText(params.userPrincipalId, "userPrincipalId");
  const providerId = requireText(params.providerId, "providerId");
  const actorPrincipalId = requireText(params.actorPrincipalId, "actorPrincipalId");
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      requireEnterpriseIdentityActionPrincipalsInTransaction({
        database,
        userPrincipalId,
        actorPrincipalId,
      });
      const links = listActiveEnterpriseProfileLinksInTransaction({
        database,
        userPrincipalId,
        providerId,
      });
      revokeEnterpriseProfileLinksInTransaction({ database, links, revokedAt: now });
      const result = enterpriseIdentityActionResult({
        providerId,
        kind: "unlink",
        affectedIdentityCount: links.length,
        affectedSnapshotCount: 0,
      });
      writeMemoryEnterpriseIdentityActionInTransaction({
        database,
        userPrincipalId,
        actorPrincipalId,
        ...result,
        occurredAt: now,
      });
      return result;
    },
    options,
    { operationLabel: "memory-enterprise-identity.profile.unlink" },
  );
}

/**
 * Revoke current provider evidence and unlink its profile association. Every
 * transition captures its active link before that link is revoked, preserving
 * historic lifecycle ownership without retaining any claim or memory content.
 */
export function revokeMemoryEnterpriseProfileEvidence(params: {
  userPrincipalId: string;
  providerId: string;
  actorPrincipalId: string;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}): MemoryEnterpriseIdentityActionResult {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const userPrincipalId = requireText(params.userPrincipalId, "userPrincipalId");
  const providerId = requireText(params.providerId, "providerId");
  const actorPrincipalId = requireText(params.actorPrincipalId, "actorPrincipalId");
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureSchemaInTransaction(database);
      requireEnterpriseIdentityActionPrincipalsInTransaction({
        database,
        userPrincipalId,
        actorPrincipalId,
      });
      const links = listActiveEnterpriseProfileLinksInTransaction({
        database,
        userPrincipalId,
        providerId,
      });
      const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
      const snapshotIdsByPrincipal = new Map<string, string[]>();
      for (const principalIds of chunks(
        links.map((link) => link.enterprisePrincipalId),
        SQLITE_IN_VALUES_LIMIT,
      )) {
        for (const snapshot of executeSqliteQuerySync(
          database,
          db
            .selectFrom("memory_enterprise_membership_snapshots")
            .select(["snapshot_id", "principal_id"])
            .where("principal_id", "in", principalIds)
            .where("provider_id", "=", providerId)
            .where("revoked_at", "is", null)
            .orderBy("principal_id", "asc")
            .orderBy("snapshot_id", "asc"),
        ).rows) {
          const snapshotIds = snapshotIdsByPrincipal.get(snapshot.principal_id) ?? [];
          snapshotIds.push(snapshot.snapshot_id);
          snapshotIdsByPrincipal.set(snapshot.principal_id, snapshotIds);
        }
      }
      const snapshotIds = [...snapshotIdsByPrincipal.values()].flat();
      for (const link of links) {
        // This must precede link revocation: transition provenance is the
        // historic profile ownership, not whichever profile may link later.
        recordMemoryEnterpriseEvidenceTransitionInTransaction({
          database,
          principalId: link.enterprisePrincipalId,
          providerId,
          kind: "revoke",
          revokedAt: now,
          snapshotIds: snapshotIdsByPrincipal.get(link.enterprisePrincipalId) ?? [],
        });
      }
      for (const chunk of chunks(snapshotIds, SQLITE_IN_VALUES_LIMIT)) {
        const updated = executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_enterprise_membership_snapshots")
            .set({ revoked_at: now })
            .where("snapshot_id", "in", chunk)
            .where("revoked_at", "is", null),
        );
        if (updated.numAffectedRows !== BigInt(chunk.length)) {
          throw new Error(
            "enterprise membership snapshot changed during profile evidence revocation",
          );
        }
      }
      for (const principalIds of chunks(
        links.map((link) => link.enterprisePrincipalId),
        SQLITE_IN_VALUES_LIMIT,
      )) {
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_enterprise_principal_evidence")
            .set({ revoked_at: now })
            .where("principal_id", "in", principalIds)
            .where("provider_id", "=", providerId)
            .where("revoked_at", "is", null),
        );
      }
      revokeEnterpriseProfileLinksInTransaction({ database, links, revokedAt: now });
      const result = enterpriseIdentityActionResult({
        providerId,
        kind: "revoke",
        affectedIdentityCount: links.length,
        affectedSnapshotCount: snapshotIds.length,
      });
      writeMemoryEnterpriseIdentityActionInTransaction({
        database,
        userPrincipalId,
        actorPrincipalId,
        ...result,
        occurredAt: now,
      });
      return result;
    },
    options,
    { operationLabel: "memory-enterprise-identity.profile-evidence.revoke" },
  );
}

/**
 * Return only lifecycle counts owned by the selected user principal when the
 * event occurred. Group, snapshot, and transition identifiers stay in the
 * state store: even an opaque identifier would let an operator correlate a
 * person's enterprise evidence outside this bounded explanation surface.
 */
export function listMemoryEnterpriseEvidenceTransitionsForUserPrincipal(params: {
  userPrincipalId: string;
  providerId?: string;
  limit?: number;
  options?: OpenClawStateDatabaseOptions;
}): readonly MemoryEnterpriseEvidenceTransition[] {
  return Object.freeze(
    listMemoryEnterpriseEvidenceTransitionImpactInputsForUserPrincipal(params).map(
      (input) => input.transition,
    ),
  );
}

/**
 * Read lifecycle-owned snapshot sets only for a profile that owned each event.
 * The caller must project these opaque inputs without returning them to an operator.
 */
export function listMemoryEnterpriseEvidenceTransitionImpactInputsForUserPrincipal(params: {
  userPrincipalId: string;
  providerId?: string;
  limit?: number;
  options?: OpenClawStateDatabaseOptions;
}): readonly MemoryEnterpriseEvidenceTransitionImpactInput[] {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const database = openOpenClawStateDatabase(options).db;
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const transitions = executeSqliteQuerySync(
    database,
    db
      .selectFrom("memory_enterprise_evidence_transitions as transition")
      .innerJoin(
        "memory_enterprise_evidence_transition_profile_links as provenance",
        "provenance.transition_id",
        "transition.transition_id",
      )
      .select([
        "transition.transition_id",
        "transition.provider_id",
        "transition.kind",
        "transition.revoked_at",
      ])
      .where(
        "provenance.user_principal_id",
        "=",
        requireText(params.userPrincipalId, "userPrincipalId"),
      )
      .$if(params.providerId !== undefined, (query) =>
        query.where("transition.provider_id", "=", requireText(params.providerId!, "providerId")),
      )
      .orderBy("transition.revoked_at", "desc")
      .orderBy("transition.transition_id", "desc")
      .limit(boundedEvidenceTransitionLimit(params.limit)),
  ).rows;
  if (transitions.length === 0) {
    return Object.freeze([]);
  }
  const transitionIds = transitions.map((transition) => transition.transition_id);
  const memberships = executeSqliteQuerySync(
    database,
    db
      .selectFrom("memory_enterprise_evidence_transition_memberships")
      .select(["transition_id", "snapshot_id"])
      .where("transition_id", "in", transitionIds)
      .orderBy("transition_id", "asc")
      .orderBy("snapshot_id", "asc"),
  ).rows;
  const snapshotIdsByTransition = new Map<string, string[]>();
  for (const membership of memberships) {
    const snapshotIds = snapshotIdsByTransition.get(membership.transition_id) ?? [];
    snapshotIds.push(membership.snapshot_id);
    snapshotIdsByTransition.set(membership.transition_id, snapshotIds);
  }
  return Object.freeze(
    transitions.map((transition) => {
      const snapshotIds = snapshotIdsByTransition.get(transition.transition_id) ?? [];
      return Object.freeze({
        transition: Object.freeze({
          providerId: transition.provider_id,
          kind: transition.kind,
          revokedAt: transition.revoked_at,
          snapshotCount: snapshotIds.length,
        }),
        snapshotIds: Object.freeze(snapshotIds),
      });
    }),
  );
}

/** Return current membership only; a provider outage therefore cannot revive stale evidence. */
export function readCurrentMemoryEnterpriseMembership(params: {
  principalId: string;
  providerId: string;
  tenant: string;
  group: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryEnterpriseMembershipSnapshot | undefined {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const providerId = requireText(params.providerId, "providerId");
  const database = openOpenClawStateDatabase(options).db;
  // A read must never create HMAC key material just to answer an unknown
  // lookup. Missing identity material therefore means no current membership.
  if (!hasAuditIdentityKey(database)) {
    return undefined;
  }
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_membership_snapshots")
      .selectAll()
      .where("principal_id", "=", requireText(params.principalId, "principalId"))
      .where("provider_id", "=", providerId)
      .where(
        "tenant_ref",
        "=",
        enterpriseRef(database, providerId, "tenant", requireText(params.tenant, "tenant")),
      )
      .where(
        "group_ref",
        "=",
        enterpriseRef(database, providerId, "group", requireText(params.group, "group")),
      )
      .where("revoked_at", "is", null)
      .where("observed_at", "<=", now)
      .where("expires_at", ">", now)
      .orderBy("observed_at", "desc")
      .orderBy("snapshot_id", "desc")
      .limit(1),
  );
  return row ? toMembership(row) : undefined;
}

/**
 * Resolve a current membership from a trusted in-process admission without
 * exposing tenant identifiers back to the caller. The returned refs are safe
 * for the redacted decision ledger only.
 */
export function readCurrentMemoryEnterpriseMembershipForAudit(params: {
  principalId: string;
  providerId: string;
  group: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryEnterpriseMembershipSnapshot | undefined {
  const options = params.options ?? {};
  ensureMemoryEnterpriseIdentitySchema(options);
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const providerId = requireText(params.providerId, "providerId");
  const database = openOpenClawStateDatabase(options).db;
  if (!hasAuditIdentityKey(database)) {
    return undefined;
  }
  const principal = selectCurrentPrincipal(
    database,
    requireText(params.principalId, "principalId"),
    providerId,
    now,
  );
  if (!principal) {
    return undefined;
  }
  const db = getNodeSqliteKysely<EnterpriseIdentityDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("memory_enterprise_membership_snapshots")
      .selectAll()
      .where("principal_id", "=", principal.principal_id)
      .where("provider_id", "=", providerId)
      .where("tenant_ref", "=", principal.tenant_ref)
      .where(
        "group_ref",
        "=",
        enterpriseRef(database, providerId, "group", requireText(params.group, "group")),
      )
      .where("evidence_revision", "=", principal.evidence_revision)
      .where("revoked_at", "is", null)
      .where("observed_at", "<=", now)
      .where("expires_at", ">", now)
      .orderBy("observed_at", "desc")
      .orderBy("snapshot_id", "desc")
      .limit(1),
  );
  return row ? toMembership(row) : undefined;
}
