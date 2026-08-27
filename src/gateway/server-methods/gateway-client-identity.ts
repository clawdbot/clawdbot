// Projects prepared connection identity into user-turn attribution fields.
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "./shared-types.js";

type GatewayClientSender = { id: string; name?: string };

export function isGatewayClientProfilePending(client: GatewayClient | null): boolean {
  return Boolean(client?.authenticatedGitHubIdentitySync && !client.authenticatedUserProfile);
}

export function authenticatedProfileUnavailableError(): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "Authenticated profile verification is unavailable; retry the request.",
    {
      retryable: true,
      retryAfterMs: 1_000,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    },
  );
}

export function gatewayClientSenderFields(client: GatewayClient | null): {
  sender?: GatewayClientSender;
} {
  if (client?.internal?.senderAttribution) {
    return { sender: client.internal.senderAttribution };
  }
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return {
      sender: {
        id: profile.profileId,
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
