import { html } from "lit";
import type { GatewayAgentRow } from "../api/types.ts";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
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
  const selected = params.selectedId ?? params.selection.state.scopeId ?? "";
  const allowAll = params.allowAll !== false;
  const agentsById = new Map(
    params.agents.map((agent) => {
      const agentId = normalizeAgentId(agent.id);
      return [agentId, agentId === agent.id ? agent : { ...agent, id: agentId }] as const;
    }),
  );
  for (const value of params.additionalAgentIds ?? []) {
    if (!value.trim()) {
      continue;
    }
    const agentId = normalizeAgentId(value);
    if (!agentsById.has(agentId)) {
      agentsById.set(agentId, { id: agentId });
    }
  }
  if (selected && !agentsById.has(selected)) {
    agentsById.set(selected, { id: selected });
  }
  const agents = [...agentsById.values()].toSorted((left, right) =>
    normalizeAgentLabel(left).localeCompare(normalizeAgentLabel(right)),
  );
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
