import { vi } from "vitest";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function soloClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

export function identifiedClient(
  profileId: string,
  displayName: string | null = null,
): GatewayClient {
  return {
    ...soloClient(),
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

export function sessionSharingTestContext(
  broadcast: ReturnType<typeof vi.fn>,
  runtimeConfig: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => runtimeConfig,
    broadcast,
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}
