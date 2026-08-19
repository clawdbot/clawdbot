// Gateway methods for linking the authenticated user's verified enterprise identity.
import {
  ErrorCodes,
  errorShape,
  validateMemoryEnterpriseIdentityAccessAuditExportParams,
  validateMemoryEnterpriseIdentityAccessAuditListParams,
  validateMemoryEnterpriseIdentityEvidenceRevokeParams,
  validateMemoryEnterpriseIdentityEvidenceTransitionListParams,
  validateMemoryEnterpriseIdentityUnlinkParams,
  validateMemoryEnterpriseIdentityPolicyDriftAlertListParams,
  validateMemoryEnterpriseIdentityAuthorizationCompleteParams,
  validateMemoryEnterpriseIdentityAuthorizationStartParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listMemoryEnterpriseAccessDecisionAudit,
  listMemoryEnterprisePolicyDriftAlerts,
} from "../../state/memory-enterprise-access-audit.js";
import {
  revokeMemoryEnterpriseProfileEvidence,
  unlinkMemoryEnterpriseProfile,
} from "../../state/memory-enterprise-identity.js";
import { listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal } from "../../state/memory-enterprise-revocation-impact.js";
import { resolveMemoryPrincipalForUserProfile } from "../../state/memory-identity.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import {
  completeGatewayEnterpriseIdentityAuthorization,
  startGatewayEnterpriseIdentityAuthorization,
} from "../memory-enterprise-oidc-transaction.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function authorizationError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "enterprise identity authorization is unavailable";
  if (message.includes("authenticated Gateway profile")) {
    return errorShape(ErrorCodes.FORBIDDEN, message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, message);
}

function requireEnterpriseAuditAccess(params: {
  client: GatewayRequestHandlerOptions["client"];
  userProfileId: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  if (params.client?.connect?.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const callerProfileId = params.client?.authenticatedUserProfile?.profileId;
  const canonicalCallerProfileId = callerProfileId
    ? resolveUserProfileId(callerProfileId)
    : undefined;
  const canonicalTargetProfileId = resolveUserProfileId(params.userProfileId);
  if (
    // Two unknown profile references must not compare equal and turn into an
    // owner grant; both sides must resolve to the current durable profile.
    canonicalCallerProfileId !== undefined &&
    canonicalTargetProfileId !== undefined &&
    canonicalCallerProfileId === canonicalTargetProfileId
  ) {
    return true;
  }
  // Decision records can reveal tenant, role-rule, and timing metadata. A read
  // scope alone cannot select another person's profile; only its owner or an
  // explicit administrator may inspect it.
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.FORBIDDEN,
      "enterprise memory audit requires the owning profile or operator.admin",
    ),
  );
  return false;
}

function resolveEnterpriseActionPrincipals(params: {
  client: GatewayRequestHandlerOptions["client"];
  userProfileId: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): Readonly<{ actorPrincipalId: string; targetPrincipalId: string }> | undefined {
  if (!requireEnterpriseAuditAccess(params)) {
    return undefined;
  }
  const actorProfileId = params.client?.authenticatedUserProfile?.profileId;
  if (!actorProfileId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "enterprise memory changes require an authenticated Gateway profile for audit attribution",
      ),
    );
    return undefined;
  }
  const actor = resolveMemoryPrincipalForUserProfile({ userProfileId: actorProfileId });
  const target = resolveMemoryPrincipalForUserProfile({ userProfileId: params.userProfileId });
  if (!actor || !target) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "enterprise memory changes require active memory principals for the actor and target profiles",
      ),
    );
    return undefined;
  }
  return Object.freeze({
    actorPrincipalId: actor.principalId,
    targetPrincipalId: target.principalId,
  });
}

export const memoryEnterpriseIdentityHandlers: GatewayRequestHandlers = {
  "memory.enterpriseIdentity.authorization.start": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityAuthorizationStartParams,
        "memory.enterpriseIdentity.authorization.start",
        respond,
      )
    ) {
      return;
    }
    if (!client) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "enterprise identity authorization requires an authenticated Gateway profile",
        ),
      );
      return;
    }
    try {
      // There is deliberately no profile parameter: Gateway binds the receipt to
      // the caller, so another user cannot link or replace this user's evidence.
      respond(
        true,
        await startGatewayEnterpriseIdentityAuthorization({
          client,
          providerPrefix: params.providerPrefix,
        }),
      );
    } catch (error) {
      respond(false, undefined, authorizationError(error));
    }
  },
  "memory.enterpriseIdentity.authorization.complete": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityAuthorizationCompleteParams,
        "memory.enterpriseIdentity.authorization.complete",
        respond,
      )
    ) {
      return;
    }
    if (!client) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "enterprise identity authorization requires an authenticated Gateway profile",
        ),
      );
      return;
    }
    try {
      respond(
        true,
        await completeGatewayEnterpriseIdentityAuthorization({
          client,
          providerPrefix: params.providerPrefix,
          state: params.state,
          code: params.code,
        }),
      );
    } catch (error) {
      respond(false, undefined, authorizationError(error));
    }
  },
  "memory.enterpriseIdentity.accessAudit.list": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityAccessAuditListParams,
        "memory.enterpriseIdentity.accessAudit.list",
        respond,
      )
    ) {
      return;
    }
    if (!requireEnterpriseAuditAccess({ client, userProfileId: params.userProfileId, respond })) {
      return;
    }
    const principal = resolveMemoryPrincipalForUserProfile({ userProfileId: params.userProfileId });
    respond(
      true,
      Object.freeze({
        decisions: principal
          ? listMemoryEnterpriseAccessDecisionAudit({
              subjectPrincipalId: principal.principalId,
              ...(params.providerId ? { providerId: params.providerId } : {}),
              ...(params.limit ? { limit: params.limit } : {}),
            }).map((decision) =>
              Object.freeze({
                ...decision,
                // Enterprise group evidence remains distinct from Gateway
                // session_members, so it can explain only a role-store decision.
                storeKind: "role" as const,
                collaboration: "not-applicable" as const,
              }),
            )
          : [],
      }),
    );
  },
  "memory.enterpriseIdentity.accessAudit.export": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityAccessAuditExportParams,
        "memory.enterpriseIdentity.accessAudit.export",
        respond,
      )
    ) {
      return;
    }
    if (!requireEnterpriseAuditAccess({ client, userProfileId: params.userProfileId, respond })) {
      return;
    }
    const principal = resolveMemoryPrincipalForUserProfile({ userProfileId: params.userProfileId });
    const query = {
      ...(params.providerId ? { providerId: params.providerId } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    };
    respond(
      true,
      Object.freeze({
        decisions: principal
          ? listMemoryEnterpriseAccessDecisionAudit({
              subjectPrincipalId: principal.principalId,
              ...query,
            }).map((decision) =>
              Object.freeze({
                ...decision,
                storeKind: "role" as const,
                collaboration: "not-applicable" as const,
              }),
            )
          : [],
        alerts: principal
          ? listMemoryEnterprisePolicyDriftAlerts({
              subjectPrincipalId: principal.principalId,
              ...query,
            }).map((alert) =>
              Object.freeze({
                ...alert,
                storeKind: "role" as const,
                collaboration: "not-applicable" as const,
              }),
            )
          : [],
        transitions: principal
          ? listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal({
              userPrincipalId: principal.principalId,
              ...query,
            })
          : [],
      }),
    );
  },
  "memory.enterpriseIdentity.unlink": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityUnlinkParams,
        "memory.enterpriseIdentity.unlink",
        respond,
      )
    ) {
      return;
    }
    const principals = resolveEnterpriseActionPrincipals({
      client,
      userProfileId: params.userProfileId,
      respond,
    });
    if (!principals) {
      return;
    }
    try {
      const occurredAt = Date.now();
      const action = unlinkMemoryEnterpriseProfile({
        userPrincipalId: principals.targetPrincipalId,
        providerId: params.providerId,
        actorPrincipalId: principals.actorPrincipalId,
        now: occurredAt,
      });
      respond(
        true,
        Object.freeze({
          ...action,
          kind: "unlinked" as const,
          occurredAt,
        }),
      );
    } catch (error) {
      respond(false, undefined, authorizationError(error));
    }
  },
  "memory.enterpriseIdentity.evidence.revoke": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityEvidenceRevokeParams,
        "memory.enterpriseIdentity.evidence.revoke",
        respond,
      )
    ) {
      return;
    }
    const principals = resolveEnterpriseActionPrincipals({
      client,
      userProfileId: params.userProfileId,
      respond,
    });
    if (!principals) {
      return;
    }
    try {
      const occurredAt = Date.now();
      const action = revokeMemoryEnterpriseProfileEvidence({
        userPrincipalId: principals.targetPrincipalId,
        providerId: params.providerId,
        actorPrincipalId: principals.actorPrincipalId,
        now: occurredAt,
      });
      respond(
        true,
        Object.freeze({
          ...action,
          kind: "revoked" as const,
          occurredAt,
        }),
      );
    } catch (error) {
      respond(false, undefined, authorizationError(error));
    }
  },
  "memory.enterpriseIdentity.policyDriftAlerts.list": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityPolicyDriftAlertListParams,
        "memory.enterpriseIdentity.policyDriftAlerts.list",
        respond,
      )
    ) {
      return;
    }
    if (!requireEnterpriseAuditAccess({ client, userProfileId: params.userProfileId, respond })) {
      return;
    }
    const principal = resolveMemoryPrincipalForUserProfile({ userProfileId: params.userProfileId });
    respond(
      true,
      Object.freeze({
        alerts: principal
          ? listMemoryEnterprisePolicyDriftAlerts({
              subjectPrincipalId: principal.principalId,
              ...(params.providerId ? { providerId: params.providerId } : {}),
              ...(params.limit ? { limit: params.limit } : {}),
            }).map((alert) =>
              Object.freeze({
                ...alert,
                storeKind: "role" as const,
                collaboration: "not-applicable" as const,
              }),
            )
          : [],
      }),
    );
  },
  "memory.enterpriseIdentity.evidenceTransitions.list": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryEnterpriseIdentityEvidenceTransitionListParams,
        "memory.enterpriseIdentity.evidenceTransitions.list",
        respond,
      )
    ) {
      return;
    }
    if (!requireEnterpriseAuditAccess({ client, userProfileId: params.userProfileId, respond })) {
      return;
    }
    const principal = resolveMemoryPrincipalForUserProfile({ userProfileId: params.userProfileId });
    respond(
      true,
      Object.freeze({
        transitions: principal
          ? listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal({
              userPrincipalId: principal.principalId,
              ...(params.providerId ? { providerId: params.providerId } : {}),
              ...(params.limit ? { limit: params.limit } : {}),
            })
          : [],
      }),
    );
  },
};
