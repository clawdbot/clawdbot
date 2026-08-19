import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecureUuid } from "../infra/secure-random.js";
import { persistMemoryRunExposureBeforeContentInDatabase } from "../plugins/memory-run-exposure-ledger.js";
import {
  clearMemoryRunExposureForTest,
  prepareMemoryRunExposure,
} from "../plugins/memory-run-exposure.js";
import {
  linkMemoryEnterpriseProfile,
  persistMemoryEnterpriseIdentity,
} from "./memory-enterprise-identity.js";
import { listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal } from "./memory-enterprise-revocation-impact.js";
import { invalidateRegisteredAgentDatabasesMemo } from "./openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-impact-"));
  roots.push(root);
  return { root, env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function persistExposure(params: {
  agentId: string;
  sessionId: string;
  snapshotIds: readonly string[];
  env: NodeJS.ProcessEnv;
}) {
  const snapshot = prepareMemoryRunExposure({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: `agent:${params.agentId}:direct:${params.sessionId}`,
    runId: `run:${params.sessionId}`,
    contextFingerprint: `context:${params.sessionId}`,
    planId: `plan:${params.sessionId}`,
    memoryPolicyRevision: "policy-1",
    sourcePolicySetIds: ["policy-set-1"],
    exposedResourceRevisions: ["resource-revision-1"],
    exposureReceiptIds: ["exposure-receipt-1"],
    egressReceiptIds: ["egress-receipt-1"],
    enterpriseMembershipSnapshotIds: params.snapshotIds,
    deliveryAudiences: [{ kind: "user", id: "alice" }],
    deliveryRevision: "delivery-1",
    egressRegistryRevision: "egress-1",
    sessionIdentityRevision: "identity-1",
    subjectRevision: "subject-1",
    actorEvidence: {
      version: 1,
      kind: "principal",
      actorKind: "human",
      principalId: "principal:user",
      assurance: "gateway-profile",
      evidenceRevision: "identity-1",
    },
    delegationSnapshot: { version: 1, kind: "none" },
    hostFactsRevision: "host-facts-1",
  });
  expect(
    persistMemoryRunExposureBeforeContentInDatabase({
      database: openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env }),
      snapshot,
    }),
  ).toBe(true);
  return snapshot;
}

afterEach(() => {
  clearMemoryRunExposureForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("enterprise memory revocation impact", () => {
  it("counts historical exposure sets across agent ledgers without exposing identifiers", () => {
    const { env, root } = fixture();
    const now = Date.now();
    const first = persistMemoryEnterpriseIdentity({
      verified: {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
        tenant: "tenant",
        subject: "alice",
        evidenceRevision: "revision-1",
        observedAt: now,
        expiresAt: now + 60_000,
      },
      groups: ["writers", "reviewers"],
      options: { env },
    });
    const state = openOpenClawStateDatabase({ env }).db;
    for (const [principalId, profileId] of [
      ["principal:user", "profile:alice"],
      ["principal:operator", "profile:operator"],
    ] satisfies readonly (readonly [string, string])[]) {
      state
        .prepare(
          `INSERT INTO memory_principals
            (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
           VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
        )
        .run(principalId, profileId, generateSecureUuid(), now);
    }
    linkMemoryEnterpriseProfile({
      enterprisePrincipalId: first.principal.principalId,
      providerId: "entra",
      userPrincipalId: "principal:user",
      createdByPrincipalId: "principal:operator",
      now,
      options: { env },
    });
    persistExposure({
      agentId: "main",
      sessionId: "main-session",
      snapshotIds: first.memberships.map((membership) => membership.snapshotId),
      env,
    });
    persistExposure({
      agentId: "worker",
      sessionId: "worker-session",
      snapshotIds: [first.memberships[0]!.snapshotId],
      env,
    });
    persistMemoryEnterpriseIdentity({
      verified: {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
        tenant: "tenant",
        subject: "alice",
        evidenceRevision: "revision-2",
        observedAt: now + 1_000,
        expiresAt: now + 61_000,
      },
      groups: ["writers"],
      options: { env },
    });

    expect(
      listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal({
        userPrincipalId: "principal:user",
        providerId: "entra",
        options: { env },
      }),
    ).toEqual([
      {
        providerId: "entra",
        kind: "refresh",
        revokedAt: now + 1_000,
        snapshotCount: 2,
        exposureCount: 2,
        complete: true,
      },
    ]);

    state
      .prepare(
        `INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        "missing",
        path.join(root, "agents", "missing", "agent", "openclaw-agent.sqlite"),
        OPENCLAW_AGENT_SCHEMA_VERSION,
        now,
      );
    invalidateRegisteredAgentDatabasesMemo({ env });

    const incomplete = listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal({
      userPrincipalId: "principal:user",
      providerId: "entra",
      options: { env },
    });
    expect(incomplete).toEqual([
      {
        providerId: "entra",
        kind: "refresh",
        revokedAt: now + 1_000,
        snapshotCount: 2,
        exposureCount: 2,
        complete: false,
      },
    ]);
    expect(JSON.stringify(incomplete)).not.toContain(first.memberships[0]!.snapshotId);
  });
});
