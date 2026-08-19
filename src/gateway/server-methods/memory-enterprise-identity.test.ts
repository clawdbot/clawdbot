import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  start: vi.fn(),
  listAudit: vi.fn(),
  listPolicyDriftAlerts: vi.fn(),
  listEvidenceTransitionImpacts: vi.fn(),
  revokeProfileEvidence: vi.fn(),
  unlinkProfile: vi.fn(),
  resolvePrincipal: vi.fn(),
  resolveProfileId: vi.fn((profileId: string) => profileId),
}));

vi.mock("../memory-enterprise-oidc-transaction.js", () => ({
  completeGatewayEnterpriseIdentityAuthorization: mocks.complete,
  startGatewayEnterpriseIdentityAuthorization: mocks.start,
}));

vi.mock("../../state/memory-enterprise-access-audit.js", () => ({
  listMemoryEnterpriseAccessDecisionAudit: mocks.listAudit,
  listMemoryEnterprisePolicyDriftAlerts: mocks.listPolicyDriftAlerts,
}));

vi.mock("../../state/memory-enterprise-revocation-impact.js", () => ({
  listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal:
    mocks.listEvidenceTransitionImpacts,
}));

vi.mock("../../state/memory-enterprise-identity.js", () => ({
  revokeMemoryEnterpriseProfileEvidence: mocks.revokeProfileEvidence,
  unlinkMemoryEnterpriseProfile: mocks.unlinkProfile,
}));

vi.mock("../../state/memory-identity.js", () => ({
  resolveMemoryPrincipalForUserProfile: mocks.resolvePrincipal,
}));

vi.mock("../../state/user-profiles.js", () => ({
  resolveUserProfileId: mocks.resolveProfileId,
}));

import { memoryEnterpriseIdentityHandlers } from "./memory-enterprise-identity.js";

async function invoke(
  method: keyof typeof memoryEnterpriseIdentityHandlers,
  params: Record<string, unknown>,
  client: Record<string, unknown> | null = {
    authenticatedUserProfile: { profileId: "profile-alice" },
  },
) {
  const respond = vi.fn();
  const handler = expectDefined(memoryEnterpriseIdentityHandlers[method], "handler test invariant");
  await handler({ params, client, respond } as unknown as Parameters<typeof handler>[0]);
  return respond;
}

describe("memory enterprise identity Gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfileId.mockImplementation((profileId: string) => profileId);
  });

  it("starts only a caller-bound provider transaction", async () => {
    mocks.start.mockResolvedValue({
      state: "state",
      authorizationUrl: "https://issuer.example/authorize?state=state",
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    const respond = await invoke("memory.enterpriseIdentity.authorization.start", {
      providerPrefix: "entra",
    });

    expect(mocks.start).toHaveBeenCalledWith({
      client: { authenticatedUserProfile: { profileId: "profile-alice" } },
      providerPrefix: "entra",
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ state: "state" }));
  });

  it("rejects profile selection and raw-token input before dispatch", async () => {
    const start = await invoke("memory.enterpriseIdentity.authorization.start", {
      providerPrefix: "entra",
      targetProfileId: "profile-bob",
    });
    const complete = await invoke("memory.enterpriseIdentity.authorization.complete", {
      providerPrefix: "entra",
      state: "state",
      code: "code",
      idToken: "bearer-token",
    });

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]).toBe(false);
    expect(complete.mock.calls[0]?.[0]).toBe(false);
  });

  it("does not dispatch an unauthenticated completion", async () => {
    const respond = await invoke(
      "memory.enterpriseIdentity.authorization.complete",
      { providerPrefix: "entra", state: "state", code: "code" },
      null,
    );

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("returns only a redacted operator audit page for the selected Gateway profile", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.listAudit.mockReturnValue([
      { eventId: "event:one", tenantRef: "hmac:tenant", ruleRef: "hmac:role" },
    ]);

    const respond = await invoke("memory.enterpriseIdentity.accessAudit.list", {
      userProfileId: "profile-alice",
      providerId: "entra",
      limit: 10,
    });

    expect(mocks.resolvePrincipal).toHaveBeenCalledWith({ userProfileId: "profile-alice" });
    expect(mocks.listAudit).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      decisions: [
        {
          eventId: "event:one",
          tenantRef: "hmac:tenant",
          ruleRef: "hmac:role",
          storeKind: "role",
          collaboration: "not-applicable",
        },
      ],
    });
  });

  it("permits a caller whose profile reference and selected reference have the same merge head", async () => {
    mocks.resolveProfileId.mockReturnValue("profile-canonical");
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.listAudit.mockReturnValue([]);

    const respond = await invoke("memory.enterpriseIdentity.accessAudit.list", {
      userProfileId: "profile-alice-old",
    });

    expect(mocks.resolveProfileId).toHaveBeenNthCalledWith(1, "profile-alice");
    expect(mocks.resolveProfileId).toHaveBeenNthCalledWith(2, "profile-alice-old");
    expect(mocks.resolvePrincipal).toHaveBeenCalledWith({ userProfileId: "profile-alice-old" });
    expect(respond).toHaveBeenCalledWith(true, { decisions: [] });
  });

  it("rejects a cross-profile audit lookup unless the caller has operator.admin", async () => {
    vi.clearAllMocks();
    const respond = await invoke("memory.enterpriseIdentity.accessAudit.list", {
      userProfileId: "profile-bob",
    });

    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.listAudit).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("allows an operator.admin to inspect another profile's redacted audit page", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:bob" });
    mocks.listAudit.mockReturnValue([]);

    const respond = await invoke(
      "memory.enterpriseIdentity.accessAudit.list",
      { userProfileId: "profile-bob" },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.resolvePrincipal).toHaveBeenCalledWith({ userProfileId: "profile-bob" });
    expect(mocks.listAudit).toHaveBeenCalledWith({ subjectPrincipalId: "principal:bob" });
    expect(respond).toHaveBeenCalledWith(true, { decisions: [] });
  });

  it("exports one bounded redacted audit record for its owning profile", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.listAudit.mockReturnValue([
      { eventId: "event:one", tenantRef: "hmac:tenant", ruleRef: "hmac:role" },
    ]);
    mocks.listPolicyDriftAlerts.mockReturnValue([
      { alertId: "alert:one", tenantRef: "hmac:tenant", ruleRef: "hmac:role" },
    ]);
    mocks.listEvidenceTransitionImpacts.mockReturnValue([
      {
        providerId: "entra",
        kind: "revoke",
        revokedAt: 1_000,
        snapshotCount: 2,
        exposureCount: 3,
        complete: true,
      },
    ]);

    const respond = await invoke("memory.enterpriseIdentity.accessAudit.export", {
      userProfileId: "profile-alice",
      providerId: "entra",
      limit: 10,
    });

    expect(mocks.listAudit).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(mocks.listPolicyDriftAlerts).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(mocks.listEvidenceTransitionImpacts).toHaveBeenCalledWith({
      userPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      decisions: [
        {
          eventId: "event:one",
          tenantRef: "hmac:tenant",
          ruleRef: "hmac:role",
          storeKind: "role",
          collaboration: "not-applicable",
        },
      ],
      alerts: [
        {
          alertId: "alert:one",
          tenantRef: "hmac:tenant",
          ruleRef: "hmac:role",
          storeKind: "role",
          collaboration: "not-applicable",
        },
      ],
      transitions: [
        {
          providerId: "entra",
          kind: "revoke",
          revokedAt: 1_000,
          snapshotCount: 2,
          exposureCount: 3,
          complete: true,
        },
      ],
    });
  });

  it("allows an operator.admin to export another profile's redacted audit record", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:bob" });
    mocks.listAudit.mockReturnValue([]);
    mocks.listPolicyDriftAlerts.mockReturnValue([]);
    mocks.listEvidenceTransitionImpacts.mockReturnValue([]);

    const respond = await invoke(
      "memory.enterpriseIdentity.accessAudit.export",
      { userProfileId: "profile-bob" },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.listAudit).toHaveBeenCalledWith({ subjectPrincipalId: "principal:bob" });
    expect(mocks.listPolicyDriftAlerts).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:bob",
    });
    expect(mocks.listEvidenceTransitionImpacts).toHaveBeenCalledWith({
      userPrincipalId: "principal:bob",
    });
    expect(respond).toHaveBeenCalledWith(true, { decisions: [], alerts: [], transitions: [] });
  });

  it("lets an owner unlink only their own enterprise identity without exposing IDs", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.unlinkProfile.mockReturnValue({
      providerId: "entra",
      kind: "unlink",
      affectedIdentityCount: 1,
      affectedSnapshotCount: 0,
    });

    const respond = await invoke("memory.enterpriseIdentity.unlink", {
      userProfileId: "profile-alice",
      providerId: "entra",
    });

    expect(mocks.unlinkProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrincipalId: "principal:alice",
        actorPrincipalId: "principal:alice",
        providerId: "entra",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        kind: "unlinked",
        providerId: "entra",
        affectedIdentityCount: 1,
        affectedSnapshotCount: 0,
      }),
    );
  });

  it("lets an attributed operator.admin revoke another profile's enterprise evidence", async () => {
    mocks.resolvePrincipal.mockImplementation(({ userProfileId }: { userProfileId: string }) =>
      userProfileId === "profile-admin"
        ? { principalId: "principal:admin" }
        : { principalId: "principal:bob" },
    );
    mocks.revokeProfileEvidence.mockReturnValue({
      providerId: "entra",
      kind: "revoke",
      affectedIdentityCount: 1,
      affectedSnapshotCount: 2,
    });

    const respond = await invoke(
      "memory.enterpriseIdentity.evidence.revoke",
      { userProfileId: "profile-bob", providerId: "entra" },
      {
        connect: { scopes: ["operator.admin"] },
        authenticatedUserProfile: { profileId: "profile-admin" },
      },
    );

    expect(mocks.revokeProfileEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrincipalId: "principal:bob",
        actorPrincipalId: "principal:admin",
        providerId: "entra",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        kind: "revoked",
        providerId: "entra",
        affectedIdentityCount: 1,
        affectedSnapshotCount: 2,
      }),
    );
  });

  it("rejects profile-less administrators before an enterprise mutation can be attributed", async () => {
    const respond = await invoke(
      "memory.enterpriseIdentity.unlink",
      { userProfileId: "profile-bob", providerId: "entra" },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.unlinkProfile).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("returns only redacted selected-policy drift alerts for the selected Gateway profile", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.listPolicyDriftAlerts.mockReturnValue([
      { alertId: "alert:one", tenantRef: "hmac:tenant", ruleRef: "hmac:role" },
    ]);

    const respond = await invoke("memory.enterpriseIdentity.policyDriftAlerts.list", {
      userProfileId: "profile-alice",
      providerId: "entra",
      limit: 10,
    });

    expect(mocks.listPolicyDriftAlerts).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      alerts: [
        {
          alertId: "alert:one",
          tenantRef: "hmac:tenant",
          ruleRef: "hmac:role",
          storeKind: "role",
          collaboration: "not-applicable",
        },
      ],
    });
  });

  it("applies the same cross-profile boundary to policy-drift alerts", async () => {
    vi.clearAllMocks();
    const respond = await invoke("memory.enterpriseIdentity.policyDriftAlerts.list", {
      userProfileId: "profile-bob",
    });

    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.listPolicyDriftAlerts).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("allows an operator.admin to inspect another profile's redacted policy-drift alerts", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:bob" });
    mocks.listPolicyDriftAlerts.mockReturnValue([]);

    const respond = await invoke(
      "memory.enterpriseIdentity.policyDriftAlerts.list",
      { userProfileId: "profile-bob" },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.resolvePrincipal).toHaveBeenCalledWith({ userProfileId: "profile-bob" });
    expect(mocks.listPolicyDriftAlerts).toHaveBeenCalledWith({
      subjectPrincipalId: "principal:bob",
    });
    expect(respond).toHaveBeenCalledWith(true, { alerts: [] });
  });

  it("returns only bounded redacted evidence transition counts for the selected profile", async () => {
    mocks.resolvePrincipal.mockReturnValue({ principalId: "principal:alice" });
    mocks.listEvidenceTransitionImpacts.mockReturnValue([
      {
        providerId: "entra",
        kind: "refresh",
        revokedAt: 1_000,
        snapshotCount: 2,
        exposureCount: 3,
        complete: true,
      },
    ]);

    const respond = await invoke("memory.enterpriseIdentity.evidenceTransitions.list", {
      userProfileId: "profile-alice",
      providerId: "entra",
      limit: 10,
    });

    expect(mocks.listEvidenceTransitionImpacts).toHaveBeenCalledWith({
      userPrincipalId: "principal:alice",
      providerId: "entra",
      limit: 10,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      transitions: [
        {
          providerId: "entra",
          kind: "refresh",
          revokedAt: 1_000,
          snapshotCount: 2,
          exposureCount: 3,
          complete: true,
        },
      ],
    });
  });

  it("applies the same cross-profile boundary to evidence transition history", async () => {
    const respond = await invoke("memory.enterpriseIdentity.evidenceTransitions.list", {
      userProfileId: "profile-bob",
    });

    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.listEvidenceTransitionImpacts).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
});
