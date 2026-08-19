import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecureUuid } from "../infra/secure-random.js";
import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import {
  listMemoryEnterpriseAccessDecisionAudit,
  listMemoryEnterprisePolicyDriftAlerts,
  recordMemoryEnterpriseRoleAccessDecisions,
  writeMemoryEnterpriseAccessDecisionAudit,
} from "./memory-enterprise-access-audit.js";
import {
  ensureMemoryEnterprisePrincipal,
  writeMemoryEnterpriseMembershipSnapshot,
} from "./memory-enterprise-identity.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-audit-"));
  roots.push(root);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function entry(
  subjectPrincipalId: string,
  overrides: Partial<Parameters<typeof writeMemoryEnterpriseAccessDecisionAudit>[0]> = {},
) {
  return {
    eventId: generateSecureUuid(),
    providerId: "entra",
    tenantRef: "hmac-sha256:v1:tenant-a",
    actorPrincipalId: "principal:operator",
    subjectPrincipalId,
    operation: "memory.read",
    decision: "allowed" as const,
    reasonCode: "membership-current",
    ruleRef: "hmac-sha256:v1:rule-a",
    policyRevision: "policy:v4",
    principalEvidenceRevision: "principal:v9",
    membershipEvidenceRevision: "membership:v7",
    occurredAt: 1_000,
    receivedAt: 1_001,
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("enterprise memory access decision audit", () => {
  it("stores only redacted ids, revisions, reasons, and opaque policy references", () => {
    const { env } = fixture();
    const subjectPrincipalId = "principal:alice";
    const recorded = entry(subjectPrincipalId);
    writeMemoryEnterpriseAccessDecisionAudit(recorded, { env });

    const db = openOpenClawStateDatabase({ env }).db;
    const row = db
      .prepare("SELECT * FROM memory_enterprise_access_decisions WHERE event_id = ?")
      .get(recorded.eventId) as Record<string, unknown>;
    expect(row).toEqual({
      event_id: recorded.eventId,
      provider_id: "entra",
      tenant_ref: "hmac-sha256:v1:tenant-a",
      actor_principal_id: "principal:operator",
      subject_principal_id: subjectPrincipalId,
      operation: "memory.read",
      decision: "allowed",
      reason_code: "membership-current",
      rule_ref: "hmac-sha256:v1:rule-a",
      policy_revision: "policy:v4",
      principal_evidence_revision: "principal:v9",
      membership_evidence_revision: "membership:v7",
      occurred_at: 1_000,
      received_at: 1_001,
    });
    expect(Object.keys(row)).not.toContain("claims");
    expect(Object.keys(row)).not.toContain("group_id");
    expect(Object.keys(row)).not.toContain("content");
  });

  it("deduplicates an event and exposes only a bounded subject-scoped page", () => {
    const { env } = fixture();
    const subjectPrincipalId = "principal:subject";
    const first = entry(subjectPrincipalId, { occurredAt: 10 });
    const second = entry(subjectPrincipalId, { occurredAt: 20 });
    writeMemoryEnterpriseAccessDecisionAudit(first, { env });
    writeMemoryEnterpriseAccessDecisionAudit(first, { env });
    writeMemoryEnterpriseAccessDecisionAudit(second, { env });
    writeMemoryEnterpriseAccessDecisionAudit(entry("principal:other"), { env });

    expect(
      listMemoryEnterpriseAccessDecisionAudit({ subjectPrincipalId, limit: 1 }, { env }),
    ).toEqual([expect.objectContaining({ eventId: second.eventId, subjectPrincipalId })]);
    expect(
      listMemoryEnterpriseAccessDecisionAudit(
        { subjectPrincipalId, providerId: "other-provider" },
        { env },
      ),
    ).toEqual([]);
    expect(() =>
      listMemoryEnterpriseAccessDecisionAudit({ subjectPrincipalId, limit: 0 }, { env }),
    ).toThrow("limit must be a positive integer");
  });

  it("derives role decision audit evidence from current reduced membership, never backend input", () => {
    const { env } = fixture();
    const enterprise = ensureMemoryEnterprisePrincipal(
      {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant-raw/v2.0",
        tenant: "tenant-raw",
        subject: "alice-raw",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 3_000,
      },
      { env },
    );
    const membership = writeMemoryEnterpriseMembershipSnapshot(
      {
        principalId: enterprise.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 3_000,
      },
      { env },
    );
    const context = {
      requestId: "request:one",
      operation: "read",
      actor: { kind: "principal", principalId: "principal:user" },
      subject: { kind: "user", principalId: "principal:user" },
      verifiedMemberships: [
        {
          snapshotId: membership.snapshotId,
          principalId: "principal:user",
          sourcePrincipalId: enterprise.principalId,
          provider: "entra",
          groupId: "engineering-raw",
          evidenceRevision: "evidence:v1",
          profileLinkRevision: "profile:v1",
          observedAt: new Date(1_000).toISOString(),
          expiresAt: new Date(3_000).toISOString(),
        },
      ],
    } as unknown as MemoryAccessContext;

    recordMemoryEnterpriseRoleAccessDecisions({
      context,
      decisions: [
        {
          groupId: "engineering-raw",
          policyId: "policy:role-engineering",
          decision: "allowed",
          reasonCode: "allowed",
          policyRevision: "policy:v4",
        },
      ],
      now: 1_500,
      options: { env },
    });
    for (const decision of [
      { policyRevision: "policy:v4", decision: "allowed" as const },
      { policyRevision: "policy:v5", decision: "denied" as const },
      { policyRevision: "policy:v5", decision: "denied" as const },
      { policyRevision: "policy:v6", decision: "denied" as const },
    ]) {
      recordMemoryEnterpriseRoleAccessDecisions({
        context,
        decisions: [
          {
            groupId: "engineering-raw",
            policyId: "policy:role-engineering",
            decision: decision.decision,
            reasonCode: decision.decision === "allowed" ? "allowed" : "policy-denied",
            policyRevision: decision.policyRevision,
          },
        ],
        now: 1_500,
        options: { env },
      });
    }

    const auditEntries = listMemoryEnterpriseAccessDecisionAudit(
      { subjectPrincipalId: "principal:user" },
      { env },
    );
    expect(auditEntries).toHaveLength(3);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "entra",
          tenantRef: membership.tenantRef,
          ruleRef: membership.groupRef,
          decision: "allowed",
          policyRevision: "policy:v4",
        }),
        expect.objectContaining({ decision: "denied", policyRevision: "policy:v5" }),
        expect.objectContaining({ decision: "denied", policyRevision: "policy:v6" }),
      ]),
    );
    const stored = JSON.stringify(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT * FROM memory_enterprise_access_decisions")
        .all(),
    );
    expect(stored).not.toContain("tenant-raw");
    expect(stored).not.toContain("engineering-raw");
    const alerts = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM memory_enterprise_policy_drift_alerts")
      .all() as Array<Record<string, unknown>>;
    expect(alerts).toEqual([
      expect.objectContaining({
        provider_id: "entra",
        tenant_ref: membership.tenantRef,
        subject_principal_id: "principal:user",
        rule_ref: membership.groupRef,
        policy_id: "policy:role-engineering",
        previous_policy_revision: "policy:v4",
        previous_decision: "allowed",
        policy_revision: "policy:v5",
        decision: "denied",
      }),
    ]);
    expect(JSON.stringify(alerts)).not.toContain("engineering-raw");
    expect(
      listMemoryEnterprisePolicyDriftAlerts({ subjectPrincipalId: "principal:user" }, { env }),
    ).toEqual([
      expect.objectContaining({
        previousPolicyRevision: "policy:v4",
        previousDecision: "allowed",
        policyRevision: "policy:v5",
        decision: "denied",
      }),
    ]);
  });
});
