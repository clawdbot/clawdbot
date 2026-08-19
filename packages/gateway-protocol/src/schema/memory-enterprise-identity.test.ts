import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateMemoryEnterpriseIdentityAccessAuditListParams,
  validateMemoryEnterpriseIdentityAccessAuditExportParams,
  validateMemoryEnterpriseIdentityEvidenceRevokeParams,
  validateMemoryEnterpriseIdentityEvidenceTransitionListParams,
  validateMemoryEnterpriseIdentityPolicyDriftAlertListParams,
  validateMemoryEnterpriseIdentityUnlinkParams,
  validateMemoryEnterpriseIdentityAuthorizationCompleteParams,
  validateMemoryEnterpriseIdentityAuthorizationStartParams,
} from "../validator-registry.js";
import {
  MemoryEnterpriseIdentityAccessAuditExportResultSchema,
  MemoryEnterpriseIdentityEvidenceRevokeResultSchema,
  MemoryEnterpriseIdentityUnlinkResultSchema,
} from "./memory-enterprise-identity.js";

describe("memory enterprise identity authorization protocol", () => {
  it("accepts only the provider selected from sealed policy when starting", () => {
    expect(
      validateMemoryEnterpriseIdentityAuthorizationStartParams({ providerPrefix: "entra" }),
    ).toBe(true);
    expect(validateMemoryEnterpriseIdentityAuthorizationStartParams({ providerPrefix: "" })).toBe(
      false,
    );
    expect(
      validateMemoryEnterpriseIdentityAuthorizationStartParams({
        providerPrefix: "entra",
        targetProfileId: "profile-bob",
      }),
    ).toBe(false);
  });

  it("accepts only the one-use receipt and authorization code when completing", () => {
    expect(
      validateMemoryEnterpriseIdentityAuthorizationCompleteParams({
        providerPrefix: "entra",
        state: "gateway-issued-state",
        code: "authorization-code",
      }),
    ).toBe(true);
    expect(
      validateMemoryEnterpriseIdentityAuthorizationCompleteParams({
        providerPrefix: "entra",
        state: "gateway-issued-state",
        code: "authorization-code",
        idToken: "bearer-token",
      }),
    ).toBe(false);
  });

  it("accepts bounded redacted audit lookup parameters only", () => {
    expect(
      validateMemoryEnterpriseIdentityAccessAuditListParams({
        userProfileId: "profile-alice",
        providerId: "entra",
        limit: 25,
      }),
    ).toBe(true);
    expect(
      validateMemoryEnterpriseIdentityAccessAuditListParams({
        userProfileId: "profile-alice",
        subjectPrincipalId: "principal:alice",
      }),
    ).toBe(false);
    expect(
      validateMemoryEnterpriseIdentityAccessAuditListParams({
        userProfileId: "profile-alice",
        limit: 101,
      }),
    ).toBe(false);
  });

  it("uses the same bounded redacted query shape for policy-drift alerts", () => {
    expect(
      validateMemoryEnterpriseIdentityPolicyDriftAlertListParams({
        userProfileId: "profile-alice",
        providerId: "entra",
        limit: 25,
      }),
    ).toBe(true);
    expect(
      validateMemoryEnterpriseIdentityPolicyDriftAlertListParams({
        userProfileId: "profile-alice",
        policyId: "policy:secret",
      }),
    ).toBe(false);
  });

  it("uses the same bounded redacted query shape for evidence transitions", () => {
    expect(
      validateMemoryEnterpriseIdentityEvidenceTransitionListParams({
        userProfileId: "profile-alice",
        providerId: "entra",
        limit: 25,
      }),
    ).toBe(true);
    expect(
      validateMemoryEnterpriseIdentityEvidenceTransitionListParams({
        userProfileId: "profile-alice",
        transitionId: "transition:private",
      }),
    ).toBe(false);
  });

  it("accepts only bounded redacted audit export parameters", () => {
    expect(
      validateMemoryEnterpriseIdentityAccessAuditExportParams({
        userProfileId: "profile-alice",
        providerId: "entra",
        limit: 25,
      }),
    ).toBe(true);
    expect(
      validateMemoryEnterpriseIdentityAccessAuditExportParams({
        userProfileId: "profile-alice",
        actionLedger: true,
      }),
    ).toBe(false);
  });

  it("keeps the export to the existing redacted audit projections", () => {
    const exportRecord = {
      decisions: [
        {
          eventId: "event:one",
          providerId: "entra",
          tenantRef: "hmac:tenant",
          actorPrincipalId: "principal:operator",
          subjectPrincipalId: "principal:alice",
          operation: "memory.read",
          decision: "allowed",
          reasonCode: "membership-current",
          ruleRef: "hmac:rule",
          policyRevision: "policy:v1",
          principalEvidenceRevision: "principal:v1",
          membershipEvidenceRevision: "membership:v1",
          occurredAt: 1,
          receivedAt: 2,
          storeKind: "role",
          collaboration: "not-applicable",
        },
      ],
      alerts: [],
      transitions: [
        {
          providerId: "entra",
          kind: "revoke",
          revokedAt: 3,
          snapshotCount: 1,
          exposureCount: 0,
          complete: true,
        },
      ],
    };

    expect(Value.Check(MemoryEnterpriseIdentityAccessAuditExportResultSchema, exportRecord)).toBe(
      true,
    );
    expect(
      Value.Check(MemoryEnterpriseIdentityAccessAuditExportResultSchema, {
        ...exportRecord,
        actionLedger: [],
      }),
    ).toBe(false);
    expect(
      Value.Check(MemoryEnterpriseIdentityAccessAuditExportResultSchema, {
        ...exportRecord,
        decisions: [{ ...exportRecord.decisions[0], resourceId: "memory:private" }],
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "unlink",
      validate: validateMemoryEnterpriseIdentityUnlinkParams,
      result: MemoryEnterpriseIdentityUnlinkResultSchema,
      kind: "unlinked",
    },
    {
      name: "evidence revocation",
      validate: validateMemoryEnterpriseIdentityEvidenceRevokeParams,
      result: MemoryEnterpriseIdentityEvidenceRevokeResultSchema,
      kind: "revoked",
    },
  ])("accepts only redacted $name mutation records", ({ validate, result, kind }) => {
    expect(validate({ userProfileId: "profile-alice", providerId: "entra" })).toBe(true);
    expect(validate({ userProfileId: "profile-alice" })).toBe(false);
    expect(
      validate({ userProfileId: "profile-alice", providerId: "entra", snapshotId: "private" }),
    ).toBe(false);

    const mutation = {
      kind,
      providerId: "entra",
      affectedIdentityCount: 1,
      affectedSnapshotCount: 2,
      occurredAt: 3,
    };
    expect(Value.Check(result, mutation)).toBe(true);
    expect(Value.Check(result, { ...mutation, identityId: "private" })).toBe(false);
    expect(Value.Check(result, { ...mutation, snapshotIds: ["private"] })).toBe(false);
  });
});
