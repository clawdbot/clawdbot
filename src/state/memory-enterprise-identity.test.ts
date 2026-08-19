import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  ensureMemoryEnterprisePrincipal,
  listMemoryEnterpriseEvidenceTransitionsForUserPrincipal,
  persistMemoryEnterpriseIdentity,
  readCurrentMemoryEnterpriseMembership,
  recheckMemoryEnterprisePrincipal,
  recheckMemoryEnterpriseProfileLink,
  revokeMemoryEnterpriseProfileEvidence,
  revokeMemoryEnterpriseMembershipSnapshot,
  linkMemoryEnterpriseProfile,
  unlinkMemoryEnterpriseProfile,
  writeMemoryEnterpriseMembershipSnapshot,
} from "./memory-enterprise-identity.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-identity-"));
  roots.push(root);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function verifiedPrincipal(
  overrides: Partial<Parameters<typeof ensureMemoryEnterprisePrincipal>[0]> = {},
) {
  return {
    providerId: "entra",
    issuer: "https://login.microsoftonline.com/tenant-raw/v2.0",
    tenant: "tenant-raw",
    subject: "subject-alice-raw",
    evidenceRevision: "principal-revision-1",
    observedAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("enterprise memory identity state", () => {
  it("returns only bounded redacted refresh and revocation lifecycle counts for a linked user", () => {
    const { env } = fixture();
    const now = Date.now();
    const first = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({ observedAt: now, expiresAt: now + 60_000 }),
      groups: ["writers", "reviewers"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    for (const principalId of ["principal:user", "principal:operator"]) {
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      ).run(principalId, `${principalId}:profile`, generateSecureUuid(), now);
    }
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: first.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:operator",
      now,
      options: { env },
    });
    persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({
        evidenceRevision: "principal-revision-2",
        observedAt: now + 1_000,
        expiresAt: now + 61_000,
      }),
      groups: ["writers"],
      options: { env },
    });

    expect(
      listMemoryEnterpriseEvidenceTransitionsForUserPrincipal({
        userPrincipalId: "principal:user",
        providerId: "entra",
        limit: 10,
        options: { env },
      }),
    ).toEqual([
      {
        providerId: "entra",
        kind: "refresh",
        revokedAt: now + 1_000,
        snapshotCount: 2,
      },
    ]);
    expect(
      listMemoryEnterpriseEvidenceTransitionsForUserPrincipal({
        userPrincipalId: "principal:operator",
        options: { env },
      }),
    ).toEqual([]);
  });

  it("keeps lifecycle evidence with the profile linked when the event occurred", () => {
    const { env } = fixture();
    const now = Date.now();
    const first = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({ observedAt: now, expiresAt: now + 60_000 }),
      groups: ["writers"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    for (const principalId of ["principal:user-a", "principal:user-b", "principal:operator"]) {
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      ).run(principalId, `${principalId}:profile`, generateSecureUuid(), now);
    }
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: first.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user-a",
      createdByPrincipalId: "principal:operator",
      now,
      options: { env },
    });
    persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({
        evidenceRevision: "principal-revision-2",
        observedAt: now + 1_000,
        expiresAt: now + 61_000,
      }),
      groups: ["writers"],
      options: { env },
    });
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: first.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user-b",
      createdByPrincipalId: "principal:operator",
      now: now + 2_000,
      options: { env },
    });

    expect(
      listMemoryEnterpriseEvidenceTransitionsForUserPrincipal({
        userPrincipalId: "principal:user-a",
        options: { env },
      }),
    ).toEqual([
      {
        providerId: "entra",
        kind: "refresh",
        revokedAt: now + 1_000,
        snapshotCount: 1,
      },
    ]);
    expect(
      listMemoryEnterpriseEvidenceTransitionsForUserPrincipal({
        userPrincipalId: "principal:user-b",
        options: { env },
      }),
    ).toEqual([]);
  });

  it("atomically replaces a verified group snapshot and durably revokes every superseded membership", () => {
    const { env } = fixture();
    const first = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal(),
      groups: ["writers", "reviewers"],
      options: { env },
    });
    const refreshed = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({
        evidenceRevision: "principal-revision-2",
        observedAt: 1_100,
        expiresAt: 2_100,
      }),
      groups: ["writers", "operators"],
      options: { env },
    });

    expect(refreshed.principal).toMatchObject({
      principalId: first.principal.principalId,
      evidenceRevision: "principal-revision-2",
    });
    expect(refreshed.memberships.map((membership) => membership.evidenceRevision)).toEqual([
      "principal-revision-2",
      "principal-revision-2",
    ]);
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: first.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "reviewers",
        now: 1_200,
        options: { env },
      }),
    ).toBeUndefined();
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: first.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: 1_200,
        options: { env },
      }),
    ).toMatchObject({ evidenceRevision: "principal-revision-2" });
    const db = openOpenClawStateDatabase({ env }).db;
    const prior = db
      .prepare(
        "SELECT snapshot_id, evidence_revision, revoked_at FROM memory_enterprise_membership_snapshots WHERE evidence_revision = ? ORDER BY snapshot_id",
      )
      .all("principal-revision-1") as Array<{
      snapshot_id: string;
      evidence_revision: string;
      revoked_at: number | null;
    }>;
    expect(prior).toHaveLength(2);
    expect(prior.every((snapshot) => snapshot.evidence_revision === "principal-revision-1")).toBe(
      true,
    );
    expect(prior.every((snapshot) => snapshot.revoked_at === 1_100)).toBe(true);
    const refreshTransition = db
      .prepare(
        `SELECT transition_id, principal_id, provider_id, kind, revoked_at
           FROM memory_enterprise_evidence_transitions
          WHERE kind = 'refresh'`,
      )
      .get() as {
      transition_id: string;
      principal_id: string;
      provider_id: string;
      kind: string;
      revoked_at: number;
    };
    expect(refreshTransition).toMatchObject({
      principal_id: first.principal.principalId,
      provider_id: "entra",
      kind: "refresh",
      revoked_at: 1_100,
    });
    expect(
      db
        .prepare(
          `SELECT snapshot_id FROM memory_enterprise_evidence_transition_memberships
            WHERE transition_id = ? ORDER BY snapshot_id`,
        )
        .all(refreshTransition.transition_id),
    ).toEqual(prior.map((snapshot) => ({ snapshot_id: snapshot.snapshot_id })));

    const removed = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({
        evidenceRevision: "principal-revision-3",
        observedAt: 1_200,
        expiresAt: 2_200,
      }),
      groups: [],
      options: { env },
    });
    expect(removed.memberships).toEqual([]);
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: first.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: 1_300,
        options: { env },
      }),
    ).toBeUndefined();
  });

  it("rolls back the principal refresh and prior-membership revocation if the replacement snapshot cannot persist", () => {
    const { env } = fixture();
    const first = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal(),
      groups: ["writers", "reviewers"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    db.exec(`
      CREATE TRIGGER reject_enterprise_refresh
      BEFORE INSERT ON memory_enterprise_membership_snapshots
      WHEN NEW.evidence_revision = 'principal-revision-2'
      BEGIN SELECT RAISE(ABORT, 'test-only refresh rejection'); END;
    `);

    expect(() =>
      persistMemoryEnterpriseIdentity({
        verified: verifiedPrincipal({
          evidenceRevision: "principal-revision-2",
          observedAt: 1_100,
          expiresAt: 2_100,
        }),
        groups: ["writers", "operators"],
        options: { env },
      }),
    ).toThrow("test-only refresh rejection");
    expect(
      recheckMemoryEnterprisePrincipal({
        principalId: first.principal.principalId,
        providerId: "entra",
        now: 1_200,
        options: { env },
      }),
    ).toMatchObject({ evidenceRevision: "principal-revision-1" });
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: first.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: 1_200,
        options: { env },
      }),
    ).toMatchObject({ evidenceRevision: "principal-revision-1" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_enterprise_membership_snapshots WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM memory_enterprise_evidence_transitions").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_enterprise_evidence_transition_memberships")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("canonicalizes a verified enterprise principal without persisting upstream identifiers", () => {
    const { env } = fixture();
    const first = ensureMemoryEnterprisePrincipal(verifiedPrincipal(), { env });
    const refreshed = ensureMemoryEnterprisePrincipal(
      verifiedPrincipal({
        evidenceRevision: "principal-revision-2",
        observedAt: 1_100,
        expiresAt: 2_100,
      }),
      { env },
    );

    expect(refreshed).toMatchObject({
      principalId: first.principalId,
      evidenceRevision: "principal-revision-2",
    });
    expect(
      ensureMemoryEnterprisePrincipal(
        verifiedPrincipal({ tenant: "tenant-other", subject: "subject-alice-raw" }),
        { env },
      ).principalId,
    ).not.toBe(first.principalId);
    const db = openOpenClawStateDatabase({ env }).db;
    const stored = JSON.stringify(
      db.prepare("SELECT * FROM memory_enterprise_principal_evidence").all(),
    );
    expect(stored).not.toContain("tenant-raw");
    expect(stored).not.toContain("subject-alice-raw");
    expect(stored).not.toContain("login.microsoftonline.com");
  });

  it("refuses conflicting active canonical evidence and leaves unknown principals unbound", () => {
    const { env } = fixture();
    const principal = ensureMemoryEnterprisePrincipal(verifiedPrincipal(), { env });
    expect(
      recheckMemoryEnterprisePrincipal({
        principalId: "principal:unknown",
        providerId: "entra",
        now: 1_100,
        options: { env },
      }),
    ).toBeUndefined();

    const db = openOpenClawStateDatabase({ env }).db;
    const evidence = db
      .prepare(
        `SELECT provider_id, issuer_ref, tenant_ref, subject_ref
           FROM memory_enterprise_principal_evidence
          WHERE principal_id = ?`,
      )
      .get(principal.principalId) as {
      provider_id: string;
      issuer_ref: string;
      tenant_ref: string;
      subject_ref: string;
    };
    db.exec("DROP INDEX idx_memory_enterprise_principal_evidence_active_subject");
    db.prepare(
      `INSERT INTO memory_principals
       (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
       VALUES (?, 'enterprise', NULL, ?, 'active', ?, ?, NULL)`,
    ).run("principal:conflict", "hmac-sha256:v1:conflicting-principal", "revision:conflict", 1_100);
    db.prepare(
      `INSERT INTO memory_enterprise_principal_evidence
       (principal_id, provider_id, issuer_ref, tenant_ref, subject_ref, assurance, evidence_revision, observed_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'oidc', ?, ?, ?, NULL)`,
    ).run(
      "principal:conflict",
      evidence.provider_id,
      evidence.issuer_ref,
      evidence.tenant_ref,
      evidence.subject_ref,
      "principal-revision-conflict",
      1_100,
      2_100,
    );

    expect(() => ensureMemoryEnterprisePrincipal(verifiedPrincipal(), { env })).toThrow(
      "enterprise principal evidence has conflicting active canonical bindings",
    );
  });

  it("reads only current membership evidence and fails closed for expiry, revocation, and selector mismatches", () => {
    const { env } = fixture();
    const principal = ensureMemoryEnterprisePrincipal(verifiedPrincipal(), { env });
    const snapshot = writeMemoryEnterpriseMembershipSnapshot(
      {
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        evidenceRevision: "principal-revision-1",
        observedAt: 1_100,
        expiresAt: 1_500,
      },
      { env },
    );

    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        now: 1_200,
        options: { env },
      }),
    ).toMatchObject({ snapshotId: snapshot.snapshotId, evidenceRevision: "principal-revision-1" });
    const storedMembership = JSON.stringify(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT * FROM memory_enterprise_membership_snapshots WHERE snapshot_id = ?")
        .get(snapshot.snapshotId),
    );
    expect(storedMembership).not.toContain("tenant-raw");
    expect(storedMembership).not.toContain("engineering-raw");
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: principal.principalId,
        providerId: "other",
        tenant: "tenant-raw",
        group: "engineering-raw",
        now: 1_200,
        options: { env },
      }),
    ).toBeUndefined();
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-other",
        group: "engineering-raw",
        now: 1_200,
        options: { env },
      }),
    ).toBeUndefined();
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        now: 1_500,
        options: { env },
      }),
    ).toBeUndefined();
    revokeMemoryEnterpriseMembershipSnapshot({
      snapshotId: snapshot.snapshotId,
      revokedAt: 1_250,
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    const revocation = db
      .prepare(
        `SELECT transition_id, kind, principal_id, provider_id, revoked_at
           FROM memory_enterprise_evidence_transitions`,
      )
      .get() as {
      transition_id: string;
      kind: string;
      principal_id: string;
      provider_id: string;
      revoked_at: number;
    };
    expect(revocation).toMatchObject({
      kind: "revoke",
      principal_id: principal.principalId,
      provider_id: "entra",
      revoked_at: 1_250,
    });
    expect(
      db
        .prepare(
          "SELECT snapshot_id FROM memory_enterprise_evidence_transition_memberships WHERE transition_id = ?",
        )
        .all(revocation.transition_id),
    ).toEqual([{ snapshot_id: snapshot.snapshotId }]);
    revokeMemoryEnterpriseMembershipSnapshot({
      snapshotId: snapshot.snapshotId,
      revokedAt: 1_260,
      options: { env },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM memory_enterprise_evidence_transitions").get(),
    ).toEqual({ count: 1 });
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        now: 1_300,
        options: { env },
      }),
    ).toBeUndefined();
    expect(
      recheckMemoryEnterprisePrincipal({
        principalId: principal.principalId,
        providerId: "entra",
        now: 2_000,
        options: { env },
      }),
    ).toBeUndefined();
  });

  it("links an enterprise principal to one active Gateway user without creating session membership", () => {
    const { env } = fixture();
    const now = Date.now();
    const enterprise = ensureMemoryEnterprisePrincipal(
      verifiedPrincipal({ observedAt: now, expiresAt: now + 60_000 }),
      { env },
    );
    const db = openOpenClawStateDatabase({ env }).db;
    for (const principalId of ["principal:user", "principal:operator"]) {
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      ).run(principalId, `${principalId}:profile`, generateSecureUuid(), now);
    }
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: enterprise.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:operator",
      options: { env },
    });

    expect(
      recheckMemoryEnterpriseProfileLink({
        enterprisePrincipalId: enterprise.principalId,
        userPrincipalId: "principal:user",
        providerId: "entra",
        now: now + 100,
        options: { env },
      }),
    ).toEqual(link);
    db.prepare("UPDATE memory_enterprise_profile_links SET revoked_at = ? WHERE link_id = ?").run(
      now + 200,
      link.linkId,
    );
    expect(
      recheckMemoryEnterpriseProfileLink({
        enterprisePrincipalId: enterprise.principalId,
        userPrincipalId: "principal:user",
        providerId: "entra",
        now: now + 300,
        options: { env },
      }),
    ).toBeUndefined();
  });

  it("unlinks only the selected profile/provider and records a redacted immutable action", () => {
    const { env } = fixture();
    const now = Date.now();
    const enterprise = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({ observedAt: now, expiresAt: now + 60_000 }),
      groups: ["writers"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    for (const principalId of ["principal:user", "principal:admin"]) {
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      ).run(principalId, `${principalId}:profile`, generateSecureUuid(), now);
    }
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: enterprise.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:user",
      now,
      options: { env },
    });

    expect(
      unlinkMemoryEnterpriseProfile({
        userPrincipalId: "principal:user",
        providerId: "entra",
        actorPrincipalId: "principal:admin",
        now: now + 1,
        options: { env },
      }),
    ).toEqual({
      providerId: "entra",
      kind: "unlink",
      affectedIdentityCount: 1,
      affectedSnapshotCount: 0,
    });
    expect(
      recheckMemoryEnterpriseProfileLink({
        enterprisePrincipalId: enterprise.principal.principalId,
        providerId: "entra",
        userPrincipalId: "principal:user",
        now: now + 2,
        options: { env },
      }),
    ).toBeUndefined();
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: enterprise.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: now + 2,
        options: { env },
      }),
    ).toMatchObject({ evidenceRevision: "principal-revision-1" });
    expect(
      db
        .prepare(
          `SELECT target_user_principal_id, actor_principal_id, provider_id, kind,
                affected_identity_count, affected_snapshot_count, occurred_at
           FROM memory_enterprise_identity_actions`,
        )
        .all(),
    ).toEqual([
      {
        target_user_principal_id: "principal:user",
        actor_principal_id: "principal:admin",
        provider_id: "entra",
        kind: "unlink",
        affected_identity_count: 1,
        affected_snapshot_count: 0,
        occurred_at: now + 1,
      },
    ]);
    expect(() =>
      db
        .prepare(
          "DELETE FROM memory_enterprise_identity_actions WHERE target_user_principal_id = ?",
        )
        .run("principal:user"),
    ).toThrow("enterprise identity actions cannot be deleted");
    expect(
      db
        .prepare("SELECT revoked_at FROM memory_enterprise_profile_links WHERE link_id = ?")
        .get(link.linkId),
    ).toEqual({ revoked_at: now + 1 });
  });

  it("revokes current evidence before unlinking, preserves lifecycle provenance, and permits later reauthentication", () => {
    const { env } = fixture();
    const now = Date.now();
    const enterprise = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({ observedAt: now, expiresAt: now + 60_000 }),
      groups: ["writers", "reviewers"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    for (const principalId of ["principal:user", "principal:admin"]) {
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      ).run(principalId, `${principalId}:profile`, generateSecureUuid(), now);
    }
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: enterprise.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:user",
      now,
      options: { env },
    });

    expect(
      revokeMemoryEnterpriseProfileEvidence({
        userPrincipalId: "principal:user",
        providerId: "entra",
        actorPrincipalId: "principal:admin",
        now: now + 1,
        options: { env },
      }),
    ).toEqual({
      providerId: "entra",
      kind: "revoke",
      affectedIdentityCount: 1,
      affectedSnapshotCount: 2,
    });
    expect(
      listMemoryEnterpriseEvidenceTransitionsForUserPrincipal({
        userPrincipalId: "principal:user",
        providerId: "entra",
        options: { env },
      }),
    ).toEqual([{ providerId: "entra", kind: "revoke", revokedAt: now + 1, snapshotCount: 2 }]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_enterprise_membership_snapshots WHERE revoked_at = ?",
        )
        .get(now + 1),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_enterprise_evidence_transition_profile_links",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: enterprise.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: now + 2,
        options: { env },
      }),
    ).toBeUndefined();
    expect(() =>
      linkMemoryEnterpriseProfile({
        enterprisePrincipalId: enterprise.principal.principalId,
        providerId: "entra",
        userPrincipalId: "principal:user",
        createdByPrincipalId: "principal:user",
        now: now + 2,
        options: { env },
      }),
    ).toThrow("enterprise profile link requires current enterprise evidence");

    const refreshed = persistMemoryEnterpriseIdentity({
      verified: verifiedPrincipal({
        evidenceRevision: "principal-revision-2",
        observedAt: now + 3,
        expiresAt: now + 60_003,
      }),
      groups: ["writers"],
      options: { env },
    });
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: refreshed.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:user",
      now: now + 3,
      options: { env },
    });
    expect(
      readCurrentMemoryEnterpriseMembership({
        principalId: refreshed.principal.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "writers",
        now: now + 4,
        options: { env },
      }),
    ).toMatchObject({ evidenceRevision: "principal-revision-2" });
  });
});
