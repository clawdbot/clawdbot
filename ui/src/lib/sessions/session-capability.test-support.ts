import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createSessionCapability } from "./index.ts";
import type { SessionGateway } from "./session-capability.ts";

export function createTestSessionCapability(gateway: SessionGateway, selectedId = "main") {
  return createSessionCapability(gateway, {
    state: { selectedId },
    subscribe: () => () => undefined,
  });
}

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

export function runningSessionsResult(): SessionsListResult {
  return sessionsResult(
    [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        status: "running",
        startedAt: 1,
      },
    ],
    1,
  );
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
  return { sessions: createTestSessionCapability(gateway), emitEvent };
}

export function createSubscriptionHydrationHarness(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  savedAgentId: string | null = null,
) {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    client: null as GatewayBrowserClient | null,
    phase: "reconnecting" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: null as string | null,
    hello: null as GatewayHelloOk | null,
  };
  const gatewayListeners = new Set<(next: typeof snapshot) => void>();
  const publish = () => gatewayListeners.forEach((listener) => listener(snapshot));
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.example.test" },
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: typeof snapshot) => void) {
      gatewayListeners.add(listener);
      return () => gatewayListeners.delete(listener);
    },
    subscribeEvents: () => () => undefined,
    setSessionKey(sessionKey: string) {
      snapshot = { ...snapshot, sessionKey };
      publish();
    },
  };
  const selection = createAgentSelectionCapability(
    gateway,
    {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", kind: "agent" },
            { id: "writer", kind: "agent" },
          ],
        },
      },
      subscribe: () => () => undefined,
    },
    { load: () => savedAgentId, save: () => undefined },
  );
  const sessions = createSessionCapability(gateway, selection);
  return {
    client,
    gateway,
    selection,
    sessions,
    connect: () => {
      snapshot = { ...snapshot, client, phase: "connected", assistantAgentId: "main" };
      publish();
    },
    disconnect: () => {
      snapshot = { ...snapshot, phase: "reconnecting" };
      publish();
    },
  };
}
