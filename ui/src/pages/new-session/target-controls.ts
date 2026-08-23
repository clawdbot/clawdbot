import { html } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import "../../components/agent-select-registration.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

type DraftAgent = GatewayAgentRow;

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  disabled: boolean;
  onSelect: (agentId: string) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  return html`
    <span class="new-session-page__select new-session-page__select--agent">
      <openclaw-agent-select
        class="agent-select--compact"
        .options=${params.agents.map((agent) => ({
          value: normalizeAgentId(agent.id),
          label: normalizeAgentLabel(agent),
          agent,
        }))}
        .value=${selectedId}
        .accessibleLabel=${t("newSession.agent")}
        .disabled=${params.disabled}
        .onSelect=${params.onSelect}
      ></openclaw-agent-select>
    </span>
  `;
}
