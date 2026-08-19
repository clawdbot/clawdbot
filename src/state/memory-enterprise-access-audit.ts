import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import { readCurrentMemoryEnterpriseMembershipForAudit } from "./memory-enterprise-identity.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_enterprise_access_decisions (";
const SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_state_events (";
const MAX_AUDIT_DECISIONS = 100;
const ensuredDatabases = new WeakSet<DatabaseSync>();

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end <= start) {
    throw new Error("canonical enterprise memory access audit schema markers are missing");
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

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return MAX_AUDIT_DECISIONS;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_AUDIT_DECISIONS);
}

/** Canonical lazy shared schema for redacted enterprise memory decisions. */
export const MEMORY_ENTERPRISE_ACCESS_AUDIT_SCHEMA_SQL = extractSchema();

/**
 * An audit event contains only canonical ids and versioned opaque references.
 * Verifiers must HMAC tenant and rule material before calling this boundary.
 */
export type MemoryEnterpriseAccessDecisionAuditEntry = Readonly<{
  eventId: string;
  providerId: string;
  tenantRef: string;
  actorPrincipalId: string;
  subjectPrincipalId: string;
  operation: string;
  decision: "allowed" | "denied" | "unavailable";
  reasonCode: string;
  ruleRef: string;
  policyRevision: string;
  principalEvidenceRevision: string;
  membershipEvidenceRevision: string | null;
  occurredAt: number;
  receivedAt: number;
}>;

export type MemoryEnterpriseAccessDecisionAuditQuery = Readonly<{
  providerId?: string;
  tenantRef?: string;
  subjectPrincipalId?: string;
  limit?: number;
}>;

export type MemoryEnterprisePolicyDriftAlert = Readonly<{
  alertId: string;
  providerId: string;
  tenantRef: string;
  subjectPrincipalId: string;
  ruleRef: string;
  policyId: string;
  operation: string;
  previousPolicyRevision: string;
  previousDecision: "allowed" | "denied";
  policyRevision: string;
  decision: "allowed" | "denied";
  detectedAt: number;
}>;

export type MemoryEnterprisePolicyDriftAlertQuery = Readonly<{
  providerId?: string;
  subjectPrincipalId?: string;
  limit?: number;
}>;

/** The memory backend may report only redacted role-store policy outcomes. */
export type MemoryEnterpriseRoleAccessDecision = Readonly<{
  groupId: string;
  policyId: string;
  decision: "allowed" | "denied" | "unavailable";
  reasonCode: string;
  policyRevision: string;
}>;

type MemoryEnterpriseAccessAuditDatabase = {
  memory_enterprise_access_decisions: {
    event_id: string;
    provider_id: string;
    tenant_ref: string;
    actor_principal_id: string;
    subject_principal_id: string;
    operation: string;
    decision: "allowed" | "denied" | "unavailable";
    reason_code: string;
    rule_ref: string;
    policy_revision: string;
    principal_evidence_revision: string;
    membership_evidence_revision: string | null;
    occurred_at: number;
    received_at: number;
  };
  memory_enterprise_role_policy_observations: {
    provider_id: string;
    tenant_ref: string;
    subject_principal_id: string;
    rule_ref: string;
    policy_id: string;
    operation: string;
    policy_revision: string;
    decision: "allowed" | "denied" | "unavailable";
    observed_at: number;
  };
  memory_enterprise_policy_drift_alerts: {
    alert_id: string;
    provider_id: string;
    tenant_ref: string;
    subject_principal_id: string;
    rule_ref: string;
    policy_id: string;
    operation: string;
    previous_policy_revision: string;
    previous_decision: "allowed" | "denied";
    policy_revision: string;
    decision: "allowed" | "denied";
    detected_at: number;
  };
};

function toEntry(
  row: MemoryEnterpriseAccessAuditDatabase["memory_enterprise_access_decisions"],
): MemoryEnterpriseAccessDecisionAuditEntry {
  return Object.freeze({
    eventId: row.event_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    actorPrincipalId: row.actor_principal_id,
    subjectPrincipalId: row.subject_principal_id,
    operation: row.operation,
    decision: row.decision,
    reasonCode: row.reason_code,
    ruleRef: row.rule_ref,
    policyRevision: row.policy_revision,
    principalEvidenceRevision: row.principal_evidence_revision,
    membershipEvidenceRevision: row.membership_evidence_revision,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  });
}

function toPolicyDriftAlert(
  row: MemoryEnterpriseAccessAuditDatabase["memory_enterprise_policy_drift_alerts"],
): MemoryEnterprisePolicyDriftAlert {
  return Object.freeze({
    alertId: row.alert_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    subjectPrincipalId: row.subject_principal_id,
    ruleRef: row.rule_ref,
    policyId: row.policy_id,
    operation: row.operation,
    previousPolicyRevision: row.previous_policy_revision,
    previousDecision: row.previous_decision,
    policyRevision: row.policy_revision,
    decision: row.decision,
    detectedAt: row.detected_at,
  });
}

/** Install the additive audit ledger only when an enterprise decision is retained. */
export function ensureMemoryEnterpriseAccessAuditSchema(database: DatabaseSync): void {
  if (ensuredDatabases.has(database)) {
    return;
  }
  const ensure = () => {
    database.exec(MEMORY_ENTERPRISE_ACCESS_AUDIT_SCHEMA_SQL); // sqlite-allow-raw -- canonical additive DDL.
  };
  if (database.isTransaction) {
    ensure();
  } else {
    runSqliteImmediateTransactionSync(database, ensure);
  }
  ensuredDatabases.add(database);
}

/** Idempotently retain a redacted decision after policy evaluation completes. */
export function writeMemoryEnterpriseAccessDecisionAudit(
  entry: MemoryEnterpriseAccessDecisionAuditEntry,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const checked = {
    eventId: requireText(entry.eventId, "eventId"),
    providerId: requireText(entry.providerId, "providerId"),
    tenantRef: requireText(entry.tenantRef, "tenantRef"),
    actorPrincipalId: requireText(entry.actorPrincipalId, "actorPrincipalId"),
    subjectPrincipalId: requireText(entry.subjectPrincipalId, "subjectPrincipalId"),
    operation: requireText(entry.operation, "operation"),
    reasonCode: requireText(entry.reasonCode, "reasonCode"),
    ruleRef: requireText(entry.ruleRef, "ruleRef"),
    policyRevision: requireText(entry.policyRevision, "policyRevision"),
    principalEvidenceRevision: requireText(
      entry.principalEvidenceRevision,
      "principalEvidenceRevision",
    ),
    membershipEvidenceRevision:
      entry.membershipEvidenceRevision === null
        ? null
        : requireText(entry.membershipEvidenceRevision, "membershipEvidenceRevision"),
  };
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      insertMemoryEnterpriseAccessDecisionAuditInTransaction(
        database,
        Object.freeze({
          ...checked,
          decision: entry.decision,
          occurredAt: entry.occurredAt,
          receivedAt: entry.receivedAt,
        }),
      );
    },
    options,
    { operationLabel: "memory-enterprise-audit.decision.write" },
  );
}

function auditEventId(parts: readonly string[]): string {
  return `mea1_${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
}

function insertMemoryEnterpriseAccessDecisionAuditInTransaction(
  database: DatabaseSync,
  entry: MemoryEnterpriseAccessDecisionAuditEntry,
): void {
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("memory_enterprise_access_decisions")
      .values({
        event_id: entry.eventId,
        provider_id: entry.providerId,
        tenant_ref: entry.tenantRef,
        actor_principal_id: entry.actorPrincipalId,
        subject_principal_id: entry.subjectPrincipalId,
        operation: entry.operation,
        decision: entry.decision,
        reason_code: entry.reasonCode,
        rule_ref: entry.ruleRef,
        policy_revision: entry.policyRevision,
        principal_evidence_revision: entry.principalEvidenceRevision,
        membership_evidence_revision: entry.membershipEvidenceRevision,
        occurred_at: entry.occurredAt,
        received_at: entry.receivedAt,
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing()),
  );
}

// The selected memory plugin owns policy evaluation. This ledger only compares
// the plugin-reported opaque revision/decision pairs so alert suppression stays
// atomic with redacted audit persistence; it cannot select a policy or store.
function recordMemoryEnterprisePolicyDriftInTransaction(params: {
  database: DatabaseSync;
  entry: MemoryEnterpriseAccessDecisionAuditEntry;
  policyId: string;
}): void {
  const { database, entry } = params;
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  const policyId = requireText(params.policyId, "policyId");
  const baseline = executeSqliteQuerySync(
    database,
    db
      .selectFrom("memory_enterprise_role_policy_observations")
      .select(["policy_revision", "decision"])
      .where("provider_id", "=", entry.providerId)
      .where("tenant_ref", "=", entry.tenantRef)
      .where("subject_principal_id", "=", entry.subjectPrincipalId)
      .where("rule_ref", "=", entry.ruleRef)
      .where("policy_id", "=", policyId)
      .where("operation", "=", entry.operation)
      .limit(1),
  ).rows[0];
  if (!baseline) {
    executeSqliteQuerySync(
      database,
      db.insertInto("memory_enterprise_role_policy_observations").values({
        provider_id: entry.providerId,
        tenant_ref: entry.tenantRef,
        subject_principal_id: entry.subjectPrincipalId,
        rule_ref: entry.ruleRef,
        policy_id: policyId,
        operation: entry.operation,
        policy_revision: entry.policyRevision,
        decision: entry.decision,
        observed_at: entry.occurredAt,
      }),
    );
    return;
  }
  if (baseline.policy_revision === entry.policyRevision) {
    return;
  }
  if (
    (baseline.decision === "allowed" || baseline.decision === "denied") &&
    (entry.decision === "allowed" || entry.decision === "denied") &&
    baseline.decision !== entry.decision
  ) {
    executeSqliteQuerySync(
      database,
      db
        .insertInto("memory_enterprise_policy_drift_alerts")
        .values({
          alert_id: auditEventId([
            "policy-drift",
            entry.providerId,
            entry.tenantRef,
            entry.subjectPrincipalId,
            entry.ruleRef,
            policyId,
            entry.operation,
            baseline.policy_revision,
            baseline.decision,
            entry.policyRevision,
            entry.decision,
          ]),
          provider_id: entry.providerId,
          tenant_ref: entry.tenantRef,
          subject_principal_id: entry.subjectPrincipalId,
          rule_ref: entry.ruleRef,
          policy_id: policyId,
          operation: entry.operation,
          previous_policy_revision: baseline.policy_revision,
          previous_decision: baseline.decision,
          policy_revision: entry.policyRevision,
          decision: entry.decision,
          detected_at: entry.occurredAt,
        })
        .onConflict((conflict) => conflict.column("alert_id").doNothing()),
    );
  }
  executeSqliteQuerySync(
    database,
    db
      .updateTable("memory_enterprise_role_policy_observations")
      .set({
        policy_revision: entry.policyRevision,
        decision: entry.decision,
        observed_at: entry.occurredAt,
      })
      .where("provider_id", "=", entry.providerId)
      .where("tenant_ref", "=", entry.tenantRef)
      .where("subject_principal_id", "=", entry.subjectPrincipalId)
      .where("rule_ref", "=", entry.ruleRef)
      .where("policy_id", "=", policyId)
      .where("operation", "=", entry.operation),
  );
}

/**
 * Core derives every durable field from the current verified context and
 * identity store. A backend can report a role-policy outcome but cannot name
 * a tenant, subject, or redacted audit reference of its choosing.
 */
export function recordMemoryEnterpriseRoleAccessDecisions(params: {
  context: MemoryAccessContext;
  decisions: readonly MemoryEnterpriseRoleAccessDecision[];
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  if (params.context.subject.kind !== "user" || params.decisions.length === 0) {
    return;
  }
  const now = params.now ?? Date.now();
  const actorPrincipalId =
    params.context.actor.kind === "principal"
      ? params.context.actor.principalId
      : params.context.subject.principalId;
  const unique = new Map<string, MemoryEnterpriseRoleAccessDecision>();
  for (const decision of params.decisions) {
    const groupId = requireText(decision.groupId, "decision.groupId");
    const policyId = requireText(decision.policyId, "decision.policyId");
    const reasonCode = requireText(decision.reasonCode, "decision.reasonCode");
    const policyRevision = requireText(decision.policyRevision, "decision.policyRevision");
    unique.set(
      `${groupId}\0${policyId}\0${decision.decision}\0${reasonCode}\0${policyRevision}`,
      Object.freeze({ groupId, policyId, decision: decision.decision, reasonCode, policyRevision }),
    );
  }
  const entries: Array<
    Readonly<{ entry: MemoryEnterpriseAccessDecisionAuditEntry; policyId: string }>
  > = [];
  for (const decision of unique.values()) {
    for (const membership of params.context.verifiedMemberships) {
      if (
        membership.principalId !== params.context.subject.principalId ||
        membership.groupId !== decision.groupId ||
        Date.parse(membership.observedAt) > now ||
        Date.parse(membership.expiresAt) <= now
      ) {
        continue;
      }
      const snapshot = readCurrentMemoryEnterpriseMembershipForAudit({
        principalId: membership.sourcePrincipalId,
        providerId: membership.provider,
        group: membership.groupId,
        now,
        options: params.options,
      });
      if (
        !snapshot ||
        snapshot.evidenceRevision !== membership.evidenceRevision ||
        snapshot.expiresAt <= now
      ) {
        continue;
      }
      entries.push(
        Object.freeze({
          entry: Object.freeze({
            eventId: auditEventId([
              params.context.requestId,
              params.context.operation,
              membership.sourcePrincipalId,
              membership.provider,
              snapshot.groupRef,
              decision.decision,
              decision.reasonCode,
              decision.policyId,
              decision.policyRevision,
            ]),
            providerId: membership.provider,
            tenantRef: snapshot.tenantRef,
            actorPrincipalId,
            subjectPrincipalId: params.context.subject.principalId,
            operation: params.context.operation,
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            // The reduced group ref identifies the authorization rule without
            // retaining a role display name or any memory resource identifier.
            ruleRef: snapshot.groupRef,
            policyRevision: decision.policyRevision,
            principalEvidenceRevision: membership.evidenceRevision,
            membershipEvidenceRevision: snapshot.evidenceRevision,
            occurredAt: now,
            receivedAt: Date.now(),
          }),
          policyId: decision.policyId,
        }),
      );
    }
  }
  if (entries.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      for (const { entry, policyId } of entries) {
        insertMemoryEnterpriseAccessDecisionAuditInTransaction(database, entry);
        recordMemoryEnterprisePolicyDriftInTransaction({ database, entry, policyId });
      }
    },
    params.options ?? {},
    { operationLabel: "memory-enterprise-audit.role-decision.write" },
  );
}

/** List at most one small page of redacted decision evidence for one subject. */
export function listMemoryEnterpriseAccessDecisionAudit(
  query: MemoryEnterpriseAccessDecisionAuditQuery,
  options: OpenClawStateDatabaseOptions = {},
): readonly MemoryEnterpriseAccessDecisionAuditEntry[] {
  const subjectPrincipalId = requireText(query.subjectPrincipalId ?? "", "subjectPrincipalId");
  const database = openOpenClawStateDatabase(options).db;
  ensureMemoryEnterpriseAccessAuditSchema(database);
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  let statement = db
    .selectFrom("memory_enterprise_access_decisions")
    .selectAll()
    .where("subject_principal_id", "=", subjectPrincipalId);
  if (query.providerId !== undefined) {
    statement = statement.where("provider_id", "=", requireText(query.providerId, "providerId"));
  }
  if (query.tenantRef !== undefined) {
    statement = statement.where("tenant_ref", "=", requireText(query.tenantRef, "tenantRef"));
  }
  const rows = executeSqliteQuerySync(
    database,
    statement
      .orderBy("occurred_at", "desc")
      .orderBy("event_id", "desc")
      .limit(boundedLimit(query.limit)),
  );
  return Object.freeze(rows.rows.map(toEntry));
}

/** List a bounded redacted page of actual selected-plugin allow/deny policy flips. */
export function listMemoryEnterprisePolicyDriftAlerts(
  query: MemoryEnterprisePolicyDriftAlertQuery,
  options: OpenClawStateDatabaseOptions = {},
): readonly MemoryEnterprisePolicyDriftAlert[] {
  const subjectPrincipalId = requireText(query.subjectPrincipalId ?? "", "subjectPrincipalId");
  const database = openOpenClawStateDatabase(options).db;
  ensureMemoryEnterpriseAccessAuditSchema(database);
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  let statement = db
    .selectFrom("memory_enterprise_policy_drift_alerts")
    .selectAll()
    .where("subject_principal_id", "=", subjectPrincipalId);
  if (query.providerId !== undefined) {
    statement = statement.where("provider_id", "=", requireText(query.providerId, "providerId"));
  }
  const rows = executeSqliteQuerySync(
    database,
    statement
      .orderBy("detected_at", "desc")
      .orderBy("alert_id", "desc")
      .limit(boundedLimit(query.limit)),
  );
  return Object.freeze(rows.rows.map(toPolicyDriftAlert));
}
