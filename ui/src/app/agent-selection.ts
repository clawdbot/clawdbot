import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

type AgentSelectionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    assistantAgentId: string | null;
  };
  subscribe: (listener: (snapshot: AgentSelectionGateway["snapshot"]) => void) => () => void;
};

type AgentSelectionRoster = {
  readonly state: { agentsList: AgentsListResult | null };
  subscribe: (listener: () => void) => () => void;
};

type AgentSelectionState = {
  selectedId: string | null;
  /** Agent filter shared by agent-owned pages; null exposes all agents. */
  scopeId: string | null;
};

export type AgentSelectionCapability = {
  readonly state: AgentSelectionState;
  set: (agentId: string | null) => void;
  setScope: (agentId: string | null) => void;
  subscribe: (listener: (state: AgentSelectionState) => void) => () => void;
};

export function createAgentSelectionCapability(
  gateway: AgentSelectionGateway,
  roster: AgentSelectionRoster,
): AgentSelectionCapability {
  const resolveScopeId = (value: string | null): string | null => {
    const scopeId = value?.trim() ? normalizeAgentId(value) : null;
    // System agents remain valid concrete chat targets, but never become shared page filters.
    const isSystem = roster.state.agentsList?.agents.some(
      (agent) => agent.kind === "system" && normalizeAgentId(agent.id) === scopeId,
    );
    return isSystem ? null : scopeId;
  };
  const initialId = gateway.snapshot.assistantAgentId
    ? normalizeAgentId(gateway.snapshot.assistantAgentId)
    : null;
  let state: AgentSelectionState = {
    selectedId: initialId,
    scopeId: resolveScopeId(initialId),
  };
  let client = gateway.snapshot.client;
  const listeners = new Set<(next: AgentSelectionState) => void>();

  const publish = (next: AgentSelectionState) => {
    const reconciled = { ...next, scopeId: resolveScopeId(next.scopeId) };
    if (state.selectedId === reconciled.selectedId && state.scopeId === reconciled.scopeId) {
      return;
    }
    state = reconciled;
    for (const listener of listeners) {
      listener(state);
    }
  };

  gateway.subscribe((next) => {
    if (next.client !== client) {
      client = next.client;
      const selectedId = next.assistantAgentId ? normalizeAgentId(next.assistantAgentId) : null;
      publish({ selectedId, scopeId: selectedId });
    }
  });
  roster.subscribe(() => publish(state));

  return {
    get state() {
      return state;
    },
    set(agentId) {
      const selectedId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      // A chip/chat switch establishes a new global page scope. The separate
      // scope field lets page controls expose all agents without losing the
      // concrete agent required by chat and new-session flows.
      publish({ selectedId, scopeId: selectedId });
    },
    setScope(agentId) {
      const scopeId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      publish({ ...state, scopeId });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
