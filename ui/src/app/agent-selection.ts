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
  const reconcileSelectedId = (value: string | null): string | null => {
    const selectedId = value?.trim() ? normalizeAgentId(value) : null;
    const agentsList = roster.state.agentsList;
    if (!agentsList || agentsList.agents.length === 0) {
      return selectedId;
    }
    const defaultId = normalizeAgentId(agentsList.defaultId);
    return !selectedId ||
      !agentsList.agents.some((agent) => normalizeAgentId(agent.id) === selectedId)
      ? defaultId
      : selectedId;
  };
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
  const initialSelectedId = reconcileSelectedId(initialId);
  let state: AgentSelectionState = {
    selectedId: initialSelectedId,
    scopeId: resolveScopeId(initialSelectedId),
  };
  let client = gateway.snapshot.client;
  let assistantAgentId = initialId;
  const listeners = new Set<(next: AgentSelectionState) => void>();

  const publish = (next: AgentSelectionState) => {
    const selectedId = reconcileSelectedId(next.selectedId);
    // Selection and page scope move together when a configured agent vanishes.
    // Otherwise route-derived agent ids keep sending agent-scoped RPCs to a dead target.
    const scopeId = selectedId === next.selectedId ? next.scopeId : selectedId;
    const reconciled = { selectedId, scopeId: resolveScopeId(scopeId) };
    if (state.selectedId === reconciled.selectedId && state.scopeId === reconciled.scopeId) {
      return;
    }
    state = reconciled;
    for (const listener of listeners) {
      listener(state);
    }
  };

  gateway.subscribe((next) => {
    const nextAssistantAgentId = next.assistantAgentId
      ? normalizeAgentId(next.assistantAgentId)
      : null;
    const clientChanged = next.client !== client;
    const assistantChanged = nextAssistantAgentId !== assistantAgentId;
    const followedPreviousDefault = state.selectedId === assistantAgentId;
    client = next.client;
    assistantAgentId = nextAssistantAgentId;
    if (clientChanged || (assistantChanged && (!state.selectedId || followedPreviousDefault))) {
      publish({ selectedId: nextAssistantAgentId, scopeId: nextAssistantAgentId });
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
