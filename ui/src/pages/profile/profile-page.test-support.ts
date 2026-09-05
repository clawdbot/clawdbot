import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";

export function createConnectedContext(
  request: GatewayBrowserClient["request"],
  selfUser: AuthenticatedUser | null = null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const subscribe = () => () => undefined;
  const context = {
    runtimeConfig: { subscribe, state: {}, ensureLoaded: async () => undefined },
    gateway: {
      get snapshot() {
        return snapshot;
      },
      connection: {
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      updateSelfUser(patch: Partial<Omit<AuthenticatedUser, "id">>) {
        if (!snapshot.selfUser) {
          return;
        }
        snapshot = { ...snapshot, selfUser: { ...snapshot.selfUser, ...patch } };
        for (const listener of listeners) {
          listener(snapshot);
        }
      },
    },
    agents: {
      state: { agentsList: null },
      ensureList: async () => null,
      subscribe,
    },
    agentIdentity: {
      get: () => null,
      ensure: async () => undefined,
      subscribe,
    },
    config: {
      current: {
        assistantIdentity: {
          name: "OpenClaw",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
      },
      subscribe,
    },
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext<RouteId>;
  return {
    context,
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, phase: connected ? "connected" : "reconnecting" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}
