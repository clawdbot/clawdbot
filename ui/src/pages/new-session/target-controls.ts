import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderSessionMenuItem } from "./cloud-target.ts";

type DraftAgent = {
  id: string;
  name?: string;
  identity?: { name?: string };
};

function agentDisplayName(agent: DraftAgent): string {
  return agent.identity?.name ?? agent.name ?? agent.id;
}

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  disabled: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverOpenChange: (open: boolean) => void;
  onPopoverHidingChange: (hiding: boolean) => void;
  onRestoreTrigger: () => void;
  onSelect: (agentId: string) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  const active = params.agents.find((agent) => normalizeAgentId(agent.id) === selectedId);
  const activeLabel = active ? agentDisplayName(active) : params.agentId;
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-agent-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.agent")}
        aria-label="${t("newSession.agent")}: ${activeLabel}"
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.disabled}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.bot}</span>
        <span class="new-session-page__trigger-label">${activeLabel}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__agent-popover"
      for="new-session-agent-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${() => params.onPopoverOpenChange(true)}
      @wa-hide=${() => {
        params.onPopoverOpenChange(false);
        params.onPopoverHidingChange(true);
      }}
      @wa-after-hide=${() => {
        params.onPopoverHidingChange(false);
        params.onRestoreTrigger();
      }}
    >
      <div class="new-session-page__menu-title">${t("newSession.agent")}</div>
      ${params.agents.map((option) =>
        renderSessionMenuItem(
          {
            value: normalizeAgentId(option.id),
            label: agentDisplayName(option),
            checked: normalizeAgentId(option.id) === selectedId,
            onSelect: () => params.onSelect(normalizeAgentId(option.id)),
          },
          params.disabled,
        ),
      )}
    </wa-popover>
  `;
}
