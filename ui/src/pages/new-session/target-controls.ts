import { html } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import "../../components/agent-select-registration.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

type DraftAgent = GatewayAgentRow;

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  agentIdentity?: AgentIdentityCapability;
  disabled: boolean;
  onSelect: (agentId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  return html`
    <span class="new-session-page__select new-session-page__select--agent">
      <openclaw-agent-select
        class="agent-select--compact"
        .options=${params.agents.map((agent) => ({
          value: normalizeAgentId(agent.id),
          label: normalizeAgentTargetLabel(agent, params.agentIdentity?.get(agent.id)),
          agent,
        }))}
        .value=${selectedId}
        .accessibleLabel=${t("newSession.agent")}
        .menuLabel=${t("newSession.agents")}
        .disabled=${params.disabled}
        .onSelect=${params.onSelect}
        @wa-show=${() => params.onOpenChange(true)}
        @wa-hide=${() => params.onOpenChange(false)}
      ></openclaw-agent-select>
    </span>
  `;
}
