// Projects prepared connection identity into user-turn attribution fields.
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.types.js";
import type { GatewayClient } from "./shared-types.js";

export function isGatewayClientProfilePending(client: GatewayClient | null): boolean {
  return Boolean(client?.authenticatedGitHubIdentitySync && !client.authenticatedUserProfile);
}

export function authenticatedProfileUnavailableError(
  message = "Authenticated profile verification is unavailable. Retry shortly; if this continues, contact a gateway administrator.",
): ErrorShape {
  return errorShape(ErrorCodes.UNAVAILABLE, message, {
    retryable: true,
    retryAfterMs: 1_000,
    details: { code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE },
  });
}

export function gatewayClientSenderFields(client: GatewayClient | null): {
  sender?: NonNullable<UserTurnInput["sender"]>;
} {
  if (client?.internal?.senderAttribution) {
    return { sender: client.internal.senderAttribution };
  }
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return {
      sender: {
        id: profile.profileId,
        ...(!client?.internal?.syntheticClient
          ? { identity: { type: "profile" as const, id: profile.profileId } }
          : {}),
        ...(profile.displayName ? { name: profile.displayName } : {}),
      },
    };
  }
  if (client?.authenticatedGitHubIdentitySync) {
    return {};
  }
  return client?.authenticatedUserId ? { sender: { id: client.authenticatedUserId } } : {};
}

/** Returns the same durable human profile identity used for session creation attribution. */
export function gatewayClientSessionCreator(client: GatewayClient | null) {
  const profile = client?.authenticatedUserProfile;
  return profile
    ? {
        type: "human" as const,
        id: profile.profileId,
        ...(profile.displayName ? { label: profile.displayName } : {}),
      }
    : undefined;
}
