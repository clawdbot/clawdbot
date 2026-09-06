import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
} from "../../../state/user-profiles.js";
import type { GatewayAuthResult } from "../../auth.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";

export function resolveAuthenticatedProfile(profileId: string, updatedAt: number) {
  const { id, displayName, avatarRevision, hasAvatar } = getUserProfileDisplay(profileId);
  return { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt };
}

export async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
}) {
  const profile = params.ownerProfileExpected
    ? ensureGatewayOwnerProfile(await resolveHostAccountName())
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
        : ensureProfileForEmail(params.authenticatedUserId!);
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  return resolveAuthenticatedProfile(profileId, profile.updatedAt);
}
