import { html } from "lit";
import type { GatewayAgentRow } from "../api/types.ts";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

type AgentScopeControlParams = {
  agents: readonly GatewayAgentRow[];
  additionalAgentIds?: readonly string[];
  selection: AgentSelectionCapability;
};

export function renderAgentScopeControl(params: AgentScopeControlParams) {
  const selected = params.selection.state.scopeId ?? "";
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
  const agents = [...agentsById.values()].toSorted((left, right) =>
    normalizeAgentLabel(left).localeCompare(normalizeAgentLabel(right)),
  );
  const selectedAgentMissing = selected && !agents.some((agent) => agent.id === selected);
  return html`
    <label class="agent-scope-control">
      <span class="agent-scope-control__label">${t("agentScope.label")}</span>
      <select
        class="agent-scope-control__select"
        aria-label=${t("agentScope.label")}
        .value=${selected}
        @change=${(event: Event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          params.selection.setScope(value || null);
        }}
      >
        <option value="">${t("agentScope.allAgents")}</option>
        ${selectedAgentMissing ? html`<option value=${selected}>${selected}</option>` : null}
        ${agents.map(
          (agent) => html`<option value=${agent.id}>${normalizeAgentLabel(agent)}</option>`,
        )}
      </select>
    </label>
  `;
}
