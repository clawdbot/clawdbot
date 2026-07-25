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

export function renderStartAsDraftToggle(params: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return html`<label class="new-session-page__trigger new-session-page__draft-toggle">
    <input
      type="checkbox"
      .checked=${params.checked}
      ?disabled=${params.disabled}
      @change=${(event: Event) =>
        params.onChange((event.currentTarget as HTMLInputElement).checked)}
    />
    <span aria-hidden="true">👻</span>
    <span>${t("newSession.startAsDraft")}</span>
  </label>`;
}
