import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

export function sessionsResult(
  sessions: SessionsListResult["sessions"],
  ts: number,
): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

export function createGatewayHarness(
  client: GatewayBrowserClient,
  featureMethods?: string[],
  options?: { selfUser?: { readonly id: string } | null },
) {
  let snapshot: {
    client: GatewayBrowserClient | null;
    phase: "connected" | "reconnecting";
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
    selfUser: { readonly id: string } | null;
  } = {
    client,
    phase: "connected" as const,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello:
      featureMethods === undefined
        ? null
        : ({ features: { methods: featureMethods } } as GatewayHelloOk),
    selfUser: options?.selfUser ?? null,
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    emitEvent: (event: GatewayEventFrame) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    publish: (connected: boolean, nextClient: GatewayBrowserClient | null = snapshot.client) => {
      snapshot = {
        ...snapshot,
        client: nextClient,
        phase: connected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

export function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: { sessionKey: key, reason: "create", key, kind: "direct", updatedAt: 1 },
  };
}

export function createSessionCapabilityHarness(
  request: GatewayBrowserClient["request"],
  options?: { ownerId?: string },
) {
  const { gateway, emitEvent } = createGatewayHarness(
    { request } as GatewayBrowserClient,
    undefined,
    {
      selfUser: options?.ownerId ? { id: options.ownerId } : null,
    },
  );
  return { sessions: createSessionCapability(gateway), emitEvent };
}
