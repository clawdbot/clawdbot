// Gateway Protocol schemas for a user linking their own verified enterprise identity.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const EnterpriseProviderPrefixSchema = Type.String({ minLength: 1, maxLength: 128 });
const EnterpriseAuthorizationStateSchema = Type.String({ minLength: 1, maxLength: 256 });
const EnterpriseAuthorizationCodeSchema = Type.String({ minLength: 1, maxLength: 8_192 });
const EnterpriseAuditLimitSchema = Type.Integer({ minimum: 1, maximum: 100 });

/** Starts a Gateway-bound OIDC authorization-code + PKCE transaction. */
export const MemoryEnterpriseIdentityAuthorizationStartParamsSchema = closedObject({
  providerPrefix: EnterpriseProviderPrefixSchema,
});

export const MemoryEnterpriseIdentityAuthorizationStartResultSchema = closedObject({
  state: EnterpriseAuthorizationStateSchema,
  authorizationUrl: Type.String({ minLength: 1, maxLength: 8_192 }),
  expiresAt: NonEmptyString,
});

/** Completes only the caller's one-use Gateway-bound authorization transaction. */
export const MemoryEnterpriseIdentityAuthorizationCompleteParamsSchema = closedObject({
  providerPrefix: EnterpriseProviderPrefixSchema,
  state: EnterpriseAuthorizationStateSchema,
  code: EnterpriseAuthorizationCodeSchema,
});

export const MemoryEnterpriseIdentityAuthorizationCompleteResultSchema = Type.Union([
  closedObject({
    kind: Type.Literal("linked"),
    providerId: NonEmptyString,
    expiresAt: NonEmptyString,
  }),
  closedObject({
    kind: Type.Literal("denied"),
    reason: Type.String({
      enum: ["transaction-invalid", "provider-unavailable", "identity-verification-failed"],
    }),
  }),
]);

export type MemoryEnterpriseIdentityAuthorizationStartParams = Static<
  typeof MemoryEnterpriseIdentityAuthorizationStartParamsSchema
>;
export type MemoryEnterpriseIdentityAuthorizationStartResult = Static<
  typeof MemoryEnterpriseIdentityAuthorizationStartResultSchema
>;
export type MemoryEnterpriseIdentityAuthorizationCompleteParams = Static<
  typeof MemoryEnterpriseIdentityAuthorizationCompleteParamsSchema
>;
export type MemoryEnterpriseIdentityAuthorizationCompleteResult = Static<
  typeof MemoryEnterpriseIdentityAuthorizationCompleteResultSchema
>;

/**
 * Redacted explanation for a Gateway profile's enterprise role decisions.
 * The Gateway admits only the named profile or an `operator.admin` caller.
 */
export const MemoryEnterpriseIdentityAccessAuditListParamsSchema = closedObject({
  userProfileId: Type.String({ minLength: 1, maxLength: 256 }),
  providerId: Type.Optional(EnterpriseProviderPrefixSchema),
  limit: Type.Optional(EnterpriseAuditLimitSchema),
});

const MemoryEnterpriseIdentityAccessAuditEntrySchema = closedObject({
  eventId: NonEmptyString,
  providerId: NonEmptyString,
  tenantRef: NonEmptyString,
  actorPrincipalId: NonEmptyString,
  subjectPrincipalId: NonEmptyString,
  operation: NonEmptyString,
  decision: Type.Union([
    Type.Literal("allowed"),
    Type.Literal("denied"),
    Type.Literal("unavailable"),
  ]),
  reasonCode: NonEmptyString,
  ruleRef: NonEmptyString,
  policyRevision: NonEmptyString,
  principalEvidenceRevision: NonEmptyString,
  membershipEvidenceRevision: Type.Union([NonEmptyString, Type.Null()]),
  occurredAt: Type.Integer({ minimum: 0 }),
  receivedAt: Type.Integer({ minimum: 0 }),
  // Enterprise evidence currently authorizes only role stores, never a
  // Gateway collaboration session. Keep this explicit in the operator view.
  storeKind: Type.Literal("role"),
  collaboration: Type.Literal("not-applicable"),
});

export const MemoryEnterpriseIdentityAccessAuditListResultSchema = closedObject({
  decisions: Type.Array(MemoryEnterpriseIdentityAccessAuditEntrySchema, { maxItems: 100 }),
});

/** Redacted policy changes, with the same owner-or-operator.admin boundary. */
export const MemoryEnterpriseIdentityPolicyDriftAlertListParamsSchema =
  MemoryEnterpriseIdentityAccessAuditListParamsSchema;

const MemoryEnterpriseIdentityPolicyDriftAlertSchema = closedObject({
  alertId: NonEmptyString,
  providerId: NonEmptyString,
  tenantRef: NonEmptyString,
  subjectPrincipalId: NonEmptyString,
  ruleRef: NonEmptyString,
  policyId: NonEmptyString,
  operation: NonEmptyString,
  previousPolicyRevision: NonEmptyString,
  previousDecision: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
  policyRevision: NonEmptyString,
  decision: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
  detectedAt: Type.Integer({ minimum: 0 }),
  storeKind: Type.Literal("role"),
  collaboration: Type.Literal("not-applicable"),
});

export const MemoryEnterpriseIdentityPolicyDriftAlertListResultSchema = closedObject({
  alerts: Type.Array(MemoryEnterpriseIdentityPolicyDriftAlertSchema, { maxItems: 100 }),
});

/** Redacted refresh/removal history for the same owner-or-operator.admin boundary. */
export const MemoryEnterpriseIdentityEvidenceTransitionListParamsSchema =
  MemoryEnterpriseIdentityAccessAuditListParamsSchema;

const MemoryEnterpriseIdentityEvidenceTransitionSchema = closedObject({
  providerId: NonEmptyString,
  kind: Type.Union([Type.Literal("refresh"), Type.Literal("revoke")]),
  revokedAt: Type.Integer({ minimum: 0 }),
  // This count supports lifecycle review without revealing groups, snapshot
  // IDs, resources, sessions, or historical run/exposure identifiers.
  snapshotCount: Type.Integer({ minimum: 1, maximum: 1_000 }),
  // Count-only impact preserves the historical revocation signal without
  // turning the audit API into a resource, run, or exposure enumerator.
  exposureCount: Type.Integer({ minimum: 0 }),
  // A missing, incompatible, or unreadable registered agent DB cannot be
  // treated as zero historical exposure.
  complete: Type.Boolean(),
});

export const MemoryEnterpriseIdentityEvidenceTransitionListResultSchema = closedObject({
  transitions: Type.Array(MemoryEnterpriseIdentityEvidenceTransitionSchema, { maxItems: 100 }),
});

/**
 * Bounded, redacted export of one enterprise identity audit record. The Gateway
 * admits only the profile owner or an `operator.admin` caller.
 */
export const MemoryEnterpriseIdentityAccessAuditExportParamsSchema =
  MemoryEnterpriseIdentityAccessAuditListParamsSchema;

export const MemoryEnterpriseIdentityAccessAuditExportResultSchema = closedObject({
  decisions: Type.Array(MemoryEnterpriseIdentityAccessAuditEntrySchema, { maxItems: 100 }),
  alerts: Type.Array(MemoryEnterpriseIdentityPolicyDriftAlertSchema, { maxItems: 100 }),
  transitions: Type.Array(MemoryEnterpriseIdentityEvidenceTransitionSchema, { maxItems: 100 }),
});

const MemoryEnterpriseIdentityMutationParamsSchema = closedObject({
  userProfileId: Type.String({ minLength: 1, maxLength: 256 }),
  providerId: EnterpriseProviderPrefixSchema,
});

const MemoryEnterpriseIdentityMutationCountSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

/** Removes one provider link without exposing the affected enterprise identity. */
export const MemoryEnterpriseIdentityUnlinkParamsSchema =
  MemoryEnterpriseIdentityMutationParamsSchema;

export const MemoryEnterpriseIdentityUnlinkResultSchema = closedObject({
  kind: Type.Literal("unlinked"),
  providerId: NonEmptyString,
  affectedIdentityCount: MemoryEnterpriseIdentityMutationCountSchema,
  affectedSnapshotCount: MemoryEnterpriseIdentityMutationCountSchema,
  occurredAt: Type.Integer({ minimum: 0 }),
});

/** Revokes one provider's evidence without exposing snapshot or transition identifiers. */
export const MemoryEnterpriseIdentityEvidenceRevokeParamsSchema =
  MemoryEnterpriseIdentityMutationParamsSchema;

export const MemoryEnterpriseIdentityEvidenceRevokeResultSchema = closedObject({
  kind: Type.Literal("revoked"),
  providerId: NonEmptyString,
  affectedIdentityCount: MemoryEnterpriseIdentityMutationCountSchema,
  affectedSnapshotCount: MemoryEnterpriseIdentityMutationCountSchema,
  occurredAt: Type.Integer({ minimum: 0 }),
});

export type MemoryEnterpriseIdentityAccessAuditListParams = Static<
  typeof MemoryEnterpriseIdentityAccessAuditListParamsSchema
>;
export type MemoryEnterpriseIdentityAccessAuditListResult = Static<
  typeof MemoryEnterpriseIdentityAccessAuditListResultSchema
>;
export type MemoryEnterpriseIdentityPolicyDriftAlertListParams = Static<
  typeof MemoryEnterpriseIdentityPolicyDriftAlertListParamsSchema
>;
export type MemoryEnterpriseIdentityPolicyDriftAlertListResult = Static<
  typeof MemoryEnterpriseIdentityPolicyDriftAlertListResultSchema
>;
export type MemoryEnterpriseIdentityEvidenceTransitionListParams = Static<
  typeof MemoryEnterpriseIdentityEvidenceTransitionListParamsSchema
>;
export type MemoryEnterpriseIdentityEvidenceTransitionListResult = Static<
  typeof MemoryEnterpriseIdentityEvidenceTransitionListResultSchema
>;
export type MemoryEnterpriseIdentityAccessAuditExportParams = Static<
  typeof MemoryEnterpriseIdentityAccessAuditExportParamsSchema
>;
export type MemoryEnterpriseIdentityAccessAuditExportResult = Static<
  typeof MemoryEnterpriseIdentityAccessAuditExportResultSchema
>;
export type MemoryEnterpriseIdentityUnlinkParams = Static<
  typeof MemoryEnterpriseIdentityUnlinkParamsSchema
>;
export type MemoryEnterpriseIdentityUnlinkResult = Static<
  typeof MemoryEnterpriseIdentityUnlinkResultSchema
>;
export type MemoryEnterpriseIdentityEvidenceRevokeParams = Static<
  typeof MemoryEnterpriseIdentityEvidenceRevokeParamsSchema
>;
export type MemoryEnterpriseIdentityEvidenceRevokeResult = Static<
  typeof MemoryEnterpriseIdentityEvidenceRevokeResultSchema
>;
