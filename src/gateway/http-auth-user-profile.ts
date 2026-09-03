import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
} from "../state/user-profiles.js";
import type { GatewayAuthResult } from "./auth.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { formatForLog } from "./ws-log.js";

const profileLog = createSubsystemLogger("gateway/user-profiles");

type AuthenticatedHttpUserProfile = {
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
};

export function usesSharedSecretGatewayMethod(
  method: GatewayAuthResult["method"] | undefined,
): boolean {
  return method === "token" || method === "password";
}

export async function resolveAuthenticatedHttpUserProfile(params: {
  authResult: GatewayAuthResult;
  cfg: OpenClawConfig;
  req: IncomingMessage;
}): Promise<AuthenticatedHttpUserProfile> {
  const authenticatedUserId = normalizeOptionalString(params.authResult.user);
  const rolesConfigured = Boolean(params.cfg.gateway?.roles);
  if (!authenticatedUserId) {
    if (
      shouldUseGatewayOwnerProfile({
        role: "operator",
        authenticatedUserId,
        authMethod: params.authResult.method,
        rolesConfigured,
      })
    ) {
      try {
        const profile = ensureGatewayOwnerProfile(await resolveHostAccountName());
        // Shared-secret operators retain their existing authority, regardless of profile roles.
        return resolveHttpProfile(profile.id, profile.updatedAt);
      } catch (error) {
        profileLog.warn(`owner profile resolution failed: ${formatForLog(error)}`);
        return {};
      }
    }
    throw new Error("operator role policies require a verified durable user profile");
  }
  try {
    const syncGitHubIdentity = createAuthenticatedGitHubIdentitySync({
      authResult: params.authResult,
      authConfig: params.cfg.gateway?.auth,
      requestHeaders: params.req.headers,
      preferCachedIdentity: !rolesConfigured,
    });
    const profile = syncGitHubIdentity
      ? await syncGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
        : ensureProfileForEmail(authenticatedUserId);
    const profileId = "profileId" in profile ? profile.profileId : profile.id;
    return resolveHttpProfile(profileId, profile.updatedAt, params.cfg);
  } catch (error) {
    // Attribution enriches authenticated requests; only configured roles make
    // durable profile resolution a prerequisite for authorization.
    if (rolesConfigured) {
      throw error;
    }
    return {};
  }
}

export function resolveHttpProfile(profileId: string, updatedAt: number, cfg?: OpenClawConfig) {
  const display = getUserProfileDisplay(profileId);
  const operatorRolePolicy = cfg ? resolveOperatorRolePolicyForProfile(display.id, cfg) : undefined;
  return {
    authenticatedUserProfile: {
      profileId: display.id,
      displayName: display.displayName,
      avatarRevision: display.avatarRevision,
      hasAvatar: display.hasAvatar,
      updatedAt,
    },
    ...(operatorRolePolicy ? { operatorRolePolicy } : {}),
  };
}
