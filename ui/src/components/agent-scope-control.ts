import { html } from "lit";
import type { GatewayAgentRow } from "../api/types.ts";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { t } from "../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../lib/agents/display.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { AgentSelectOption } from "./agent-select.ts";
import "./agent-select-registration.ts";
import { icons } from "./icons.ts";

type AgentScopeControlParams = {
  agents: readonly GatewayAgentRow[];
  additionalAgentIds?: readonly string[];
  selection: AgentSelectionCapability;
  allowAll?: boolean;
  selectedId?: string | null;
};

export function renderAgentScopeControl(params: AgentScopeControlParams) {
  const requestedSelected = params.selectedId ?? params.selection.state.scopeId ?? "";
  const selectedId = requestedSelected ? normalizeAgentId(requestedSelected) : "";
  const allowAll = params.allowAll !== false;
  // Do not let historical or selected IDs reintroduce a typed system row.
  const isSystemAgentId = (agentId: string) =>
    params.agents.some(
      (agent) => agent.kind === "system" && normalizeAgentId(agent.id) === agentId,
    );
  const selectableAgents = listSelectableAgents(params.agents);
  const agentsById = new Map(
    selectableAgents.map((agent) => {
      const agentId = normalizeAgentId(agent.id);
      return [agentId, agentId === agent.id ? agent : { ...agent, id: agentId }] as const;
    }),
  );
  for (const value of params.additionalAgentIds ?? []) {
    if (!value.trim()) {
      continue;
    }
    const agentId = normalizeAgentId(value);
    if (!isSystemAgentId(agentId) && !agentsById.has(agentId)) {
      agentsById.set(agentId, { id: agentId });
    }
  }
  if (selectedId && !isSystemAgentId(selectedId) && !agentsById.has(selectedId)) {
    agentsById.set(selectedId, { id: selectedId });
  }
  const agents = [...agentsById.values()].toSorted((left, right) =>
    normalizeAgentLabel(left).localeCompare(normalizeAgentLabel(right)),
  );
  const selected = isSystemAgentId(selectedId)
    ? allowAll
      ? ""
      : (agents[0]?.id ?? "")
    : selectedId;
  const options: AgentSelectOption[] = [
    ...(allowAll ? [{ value: "", label: t("agentScope.allAgents"), icon: icons.users }] : []),
    ...agents.map((agent) => ({
      value: agent.id,
      label: normalizeAgentLabel(agent),
      agent,
    })),
  ];
  return html`
    <label class="agent-scope-control">
      <span class="agent-scope-control__label">${t("agentScope.label")}</span>
      <openclaw-agent-select
        .options=${options}
        .value=${selected}
        .accessibleLabel=${t("agentScope.label")}
        .onSelect=${(value: string) => params.selection.setScope(value || null)}
      ></openclaw-agent-select>
    </label>
  `;
}
