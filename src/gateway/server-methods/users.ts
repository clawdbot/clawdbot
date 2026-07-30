// Gateway methods for durable user profile administration.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateUsersLinkEmailParams,
  validateUsersListParams,
  validateUsersSelfParams,
  validateUsersSetAvatarParams,
  validateUsersSetDisplayNameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  listProfiles,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

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

function invalidParams(name: string, errors: Parameters<typeof formatValidationErrors>[0]) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${name} params: ${formatValidationErrors(errors)}`,
  );
}

function profileError(error: unknown) {
  if (error instanceof UserProfileNotFoundError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
}

function canMutateProfile(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
): boolean {
  if (client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const authenticatedUserId = client?.authenticatedUserId;
  return authenticatedUserId
    ? ensureProfileForEmail(authenticatedUserId).id === resolveUserProfileId(profileId)
    : false;
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
  "users.list": ({ params, respond }) => {
    if (!validateUsersListParams(params)) {
      respond(false, undefined, invalidParams("users.list", validateUsersListParams.errors));
      return;
    }
    respond(true, { profiles: listProfiles() });
  },
  "users.self": ({ client, params, respond }) => {
    if (!validateUsersSelfParams(params)) {
      respond(false, undefined, invalidParams("users.self", validateUsersSelfParams.errors));
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
      const profile = ensureProfileForEmail(client.authenticatedUserId);
      respond(true, { profile: getUserProfileListItem(profile.id) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.linkEmail": ({ params, respond }) => {
    if (!validateUsersLinkEmailParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.linkEmail", validateUsersLinkEmailParams.errors),
      );
      return;
    }
    const email = params.email.trim();
    if (!email) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "email must not be empty"));
      return;
    }
    try {
      respond(true, { profile: linkEmail(email, params.targetProfileId) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setDisplayName": ({ client, params, respond }) => {
    if (!validateUsersSetDisplayNameParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.setDisplayName", validateUsersSetDisplayNameParams.errors),
      );
      return;
    }
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      respond(true, { profile: setDisplayName(params.profileId, params.displayName) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setAvatar": ({ client, params, respond }) => {
    if (!validateUsersSetAvatarParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.setAvatar", validateUsersSetAvatarParams.errors),
      );
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
      respond(true, { profile: result.value });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
};
