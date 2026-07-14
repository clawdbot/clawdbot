import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";

type AgentIdentityGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

type AgentIdentityGateway = {
  readonly snapshot: AgentIdentityGatewaySnapshot;
  subscribe: (listener: (snapshot: AgentIdentityGatewaySnapshot) => void) => () => void;
};

export type AgentIdentityCapability = {
  get: (agentId: string | null | undefined) => AgentIdentityResult | null;
  entries: () => AgentIdentityResult[];
  ensure: (agentIds: readonly (string | null | undefined)[]) => Promise<void>;
  invalidate: (agentIds: readonly (string | null | undefined)[]) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createAgentIdentityCapability(
  gateway: AgentIdentityGateway,
): AgentIdentityCapability {
  let cachedClient: GatewayBrowserClient | null = gateway.snapshot.client;
  let cachedConnected = gateway.snapshot.connected;
  let connectionGeneration = 0;
  const identities = new Map<string, AgentIdentityResult>();
  const inFlight = new Map<string, Promise<AgentIdentityResult | null>>();
  const invalidationEpochs = new Map<string, number>();
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const resetForGateway = (snapshot: AgentIdentityGatewaySnapshot) => {
    if (snapshot.client === cachedClient && snapshot.connected === cachedConnected) {
      return;
    }
    const hadIdentities = identities.size > 0;
    cachedClient = snapshot.client;
    cachedConnected = snapshot.connected;
    connectionGeneration += 1;
    identities.clear();
    inFlight.clear();
    invalidationEpochs.clear();
    if (hadIdentities) {
      publish();
    }
  };

  gateway.subscribe(resetForGateway);

  const normalizeIds = (agentIds: readonly (string | null | undefined)[]) => [
    ...new Set(
      agentIds
        .map((agentId) => agentId?.trim())
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ];

  const fetchIdentity = (
    client: GatewayBrowserClient,
    agentId: string,
  ): Promise<AgentIdentityResult | null> => {
    const active = inFlight.get(agentId);
    if (active) {
      return active;
    }
    const request = client
      .request<AgentIdentityResult | null>("agent.identity.get", { agentId })
      .catch(() => null)
      .finally(() => {
        if (inFlight.get(agentId) === request) {
          inFlight.delete(agentId);
        }
      });
    inFlight.set(agentId, request);
    return request;
  };

  return {
    get(agentId) {
      const normalized = agentId?.trim();
      return normalized ? (identities.get(normalized) ?? null) : null;
    },
    entries() {
      return [...identities.values()];
    },
    async ensure(agentIds) {
      const snapshot = gateway.snapshot;
      resetForGateway(snapshot);
      const client = snapshot.client;
      if (!client || !snapshot.connected) {
        return;
      }
      const generation = connectionGeneration;
      const missing = normalizeIds(agentIds).filter((agentId) => !identities.has(agentId));
      if (missing.length === 0) {
        return;
      }
      const results = await Promise.all(
        missing.map(async (agentId) => {
          const invalidationEpoch = invalidationEpochs.get(agentId) ?? 0;
          return [agentId, invalidationEpoch, await fetchIdentity(client, agentId)] as const;
        }),
      );
      if (
        connectionGeneration !== generation ||
        gateway.snapshot.client !== client ||
        !gateway.snapshot.connected
      ) {
        return;
      }
      let changed = false;
      for (const [agentId, invalidationEpoch, identity] of results) {
        if (identity && invalidationEpoch === (invalidationEpochs.get(agentId) ?? 0)) {
          identities.set(agentId, identity);
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    invalidate(agentIds) {
      let changed = false;
      for (const agentId of normalizeIds(agentIds)) {
        invalidationEpochs.set(agentId, (invalidationEpochs.get(agentId) ?? 0) + 1);
        if (identities.delete(agentId)) {
          changed = true;
        }
        inFlight.delete(agentId);
      }
      if (changed) {
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
