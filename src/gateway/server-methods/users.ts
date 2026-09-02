// Gateway methods for durable user profile administration.
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateUsersLinkEmailParams,
  validateUsersListParams,
  validateUsersPrefsGetParams,
  validateUsersPrefsSetParams,
  validateUsersSelfParams,
  validateUsersSetAvatarParams,
  validateUsersSetDisplayNameParams,
  validateUsersSetRoleParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getUserPreferences, setUserPreferences } from "../../state/user-preferences.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem,
  linkEmail,
  listProfiles,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { usersGitHubHandlers } from "./users-github.js";
import { assertValidParams } from "./validation.js";

function refreshConnectedProfile(
  context: GatewayRequestHandlerOptions["context"],
  profile: { id: string; updatedAt: number },
): ReturnType<typeof getUserProfileDisplay> {
  const display = getUserProfileDisplay(profile.id);
  context.refreshConnectedUserProfile?.({
    ...display,
    updatedAt: profile.updatedAt,
  });
  return display;
}

function decodeBase64(value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(trimmed)
  ) {
    return undefined;
  }
  return Buffer.from(trimmed, "base64");
}

function profileError(error: unknown) {
  if (error instanceof UserProfileNotFoundError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
}

function resolveAuthenticatedProfileId(
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  if (client?.authenticatedUserProfile?.profileId) {
    return resolveUserProfileId(client.authenticatedUserProfile.profileId);
  }
  if (client?.authenticatedGitHubIdentitySync) {
    return undefined;
  }
  const authenticatedUserId = client?.authenticatedUserId;
  if (!authenticatedUserId) {
    return undefined;
  }
  // A failed Tailscale profile snapshot must not recreate its provider login
  // through the legacy email resolver on a later self-profile request.
  if (client.authenticatedUserIsTailscaleProvider) {
    return undefined;
  }
  return ensureProfileForEmail(authenticatedUserId).id;
}

function canMutateProfile(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
): boolean {
  if (client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const authenticatedProfileId = resolveAuthenticatedProfileId(client);
  return (
    authenticatedProfileId !== undefined &&
    authenticatedProfileId === resolveUserProfileId(profileId)
  );
}

function requireProfileMutationAccess(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  // These methods are write-scoped so an identified caller can edit only its own profile;
  // edits targeting any other profile remain admin-only.
  if (canMutateProfile(client, profileId)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "profile edits require the owning user or operator.admin"),
  );
  return false;
}

export const usersHandlers: GatewayRequestHandlers = {
  ...usersGitHubHandlers,
  "users.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateUsersListParams, "users.list", respond)) {
      return;
    }
    respond(true, { profiles: listProfiles() });
  },
  "users.self": async ({ client, params, respond }) => {
    if (!assertValidParams(params, validateUsersSelfParams, "users.self", respond)) {
      return;
    }
    if (!client?.authenticatedUserId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "users.self requires an authenticated user"),
      );
      return;
    }
    try {
      if (client.authenticatedGitHubIdentitySync) {
        try {
          await client.authenticatedGitHubIdentitySync();
        } catch {
          // A previously attached immutable profile stays usable; unresolved aliases stay hidden.
        }
      }
      const profileId = resolveAuthenticatedProfileId(client);
      if (!profileId) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { profile: getUserProfileListItem(profileId) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.get": ({ client, params, respond }) => {
    if (!assertValidParams(params, validateUsersPrefsGetParams, "users.prefs.get", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const canonicalProfileId = resolveUserProfileId(profileId);
      if (!canonicalProfileId) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(
        true,
        { status: "ok", entries: getUserPreferences(canonicalProfileId, params.keys) },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.set": ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateUsersPrefsSetParams, "users.prefs.set", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const canonicalProfileId = resolveUserProfileId(profileId);
      if (!canonicalProfileId) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      const result = setUserPreferences(canonicalProfileId, params.entries);
      if (!result.ok) {
        if (result.error.code === "profile-key-limit") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `users.prefs.set exceeds the ${result.error.limit}-key profile limit (current count: ${result.error.currentCount})`,
              {
                details: {
                  code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
                  limit: result.error.limit,
                  currentCount: result.error.currentCount,
                },
              },
            ),
          );
          return;
        }
        const key = "key" in result.error ? ` for ${result.error.key}` : "";
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid users.prefs.set entry${key}: ${result.error.code}`,
          ),
        );
        return;
      }
      respond(true, { status: "ok" }, undefined);
      const keys = Object.keys(params.entries);
      if (keys.length === 0) {
        return;
      }
      const connIds = context.getClientConnIds?.((connectedClient) => {
        const connectedProfileId = connectedClient.authenticatedUserProfile?.profileId;
        return Boolean(
          connectedProfileId &&
          (connectedProfileId === canonicalProfileId ||
            resolveUserProfileId(connectedProfileId) === canonicalProfileId),
        );
      });
      if (connIds?.size) {
        context.broadcastToConnIds(
          "users.prefs.changed",
          { profileId: canonicalProfileId, keys },
          connIds,
        );
      }
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.linkEmail": ({ context, params, respond }) => {
    if (!assertValidParams(params, validateUsersLinkEmailParams, "users.linkEmail", respond)) {
      return;
    }
    const email = params.email.trim();
    if (!email) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "email must not be empty"));
      return;
    }
    try {
      const profile = linkEmail(email, params.targetProfileId);
      refreshConnectedProfile(context, profile);
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setDisplayName": ({ client, context, params, respond }) => {
    if (
      !assertValidParams(params, validateUsersSetDisplayNameParams, "users.setDisplayName", respond)
    ) {
      return;
    }
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      const profile = setDisplayName(params.profileId, params.displayName);
      refreshConnectedProfile(context, profile);
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setRole": ({ context, params, respond }) => {
    if (!assertValidParams(params, validateUsersSetRoleParams, "users.setRole", respond)) {
      return;
    }
    const roleDefinitions = context.getRuntimeConfig().gateway?.roles?.definitions;
    if (
      params.role !== null &&
      (!roleDefinitions || !Object.hasOwn(roleDefinitions, params.role))
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown operator role "${params.role}"; define it under gateway.roles.definitions before assigning it`,
        ),
      );
      return;
    }
    try {
      const profile = setUserProfileRole(params.profileId, params.role);
      invalidateOperatorRolePolicy(profile.id);
      context.disconnectClientsForUserProfile?.(profile.id);
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setAvatar": ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateUsersSetAvatarParams, "users.setAvatar", respond)) {
      return;
    }
    const bytes = decodeBase64(params.avatarBase64);
    if (!bytes) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "avatarBase64 must be base64"),
      );
      return;
    }
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      const result = setAvatar(params.profileId, bytes, params.mime);
      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error.code));
        return;
      }
      const display = refreshConnectedProfile(context, result.value);
      respond(true, { profile: result.value, avatarRevision: display.avatarRevision });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
};
