import type { SystemPresence } from "../infra/system-presence.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";

type AuthenticatedPresenceProfile = {
  profileId: string;
  displayName: string | null;
  avatarRevision: string;
};

export function buildAuthenticatedPresenceUser(params: {
  authenticatedUserId?: string;
  authenticatedUserIsTailscaleProvider?: boolean;
  authenticatedUserProfile?: AuthenticatedPresenceProfile;
}): SystemPresence["user"] | undefined {
  if (!params.authenticatedUserId) {
    return undefined;
  }
  if (!params.authenticatedUserProfile) {
    return {
      id: params.authenticatedUserId,
      ...(params.authenticatedUserIsTailscaleProvider ? {} : { email: params.authenticatedUserId }),
    };
  }
  return {
    id: params.authenticatedUserProfile.profileId,
    ...(params.authenticatedUserIsTailscaleProvider ? {} : { email: params.authenticatedUserId }),
    ...(params.authenticatedUserProfile.displayName
      ? { name: params.authenticatedUserProfile.displayName }
      : {}),
    // This authenticated route resolves uploaded avatars first and then the
    // gateway-side Gravatar proxy, so it remains present without an upload.
    avatarUrl: buildControlUiUserAvatarPath(
      params.authenticatedUserProfile.profileId,
      params.authenticatedUserProfile.avatarRevision,
    ),
  };
}
