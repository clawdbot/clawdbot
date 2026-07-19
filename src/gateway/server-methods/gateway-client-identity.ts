// Projects prepared connection identity into user-turn attribution fields.
import type { GatewayClient } from "./shared-types.js";

type GatewayClientSender = { id: string; name?: string };

export function gatewayClientSenderFields(client: GatewayClient | null): {
  sender?: GatewayClientSender;
} {
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return {
      sender: {
        id: profile.profileId,
        ...(profile.displayName ? { name: profile.displayName } : {}),
      },
    };
  }
  return client?.authenticatedUserId ? { sender: { id: client.authenticatedUserId } } : {};
}
