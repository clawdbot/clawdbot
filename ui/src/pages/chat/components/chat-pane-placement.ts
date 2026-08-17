import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

export function renderChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementReclaimDisabledReason?: string;
  onPlacementReclaim?: () => void;
}): TemplateResult | typeof nothing {
  const placementState = props.session?.placement?.state;
  if (!isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const label = t("newSession.runsOn", { place: t("newSession.cloud") });
  const disabledReason = props.placementReclaimDisabledReason;
  const age = formatRelativeTimestamp(props.session?.placement?.stateChangedAtMs, {
    fallback: "",
  });
  const exceptionState =
    placementState === "active" ? nothing : `${placementState}${age ? ` · ${age}` : ""}`;
  return html`
    <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
      <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
      ${exceptionState === nothing
        ? nothing
        : html`<div class="chat-pane__placement-state">${exceptionState}</div>`}
      <wa-dropdown-item
        class="session-menu__item session-menu__item--destructive chat-pane__placement-reclaim"
        variant="danger"
        ?disabled=${Boolean(disabledReason)}
        title=${disabledReason ?? nothing}
        @click=${() => !disabledReason && props.onPlacementReclaim?.()}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.stop}</span>
        <span class="session-menu__text">${t("sessionsView.stopCloudWorker")}</span>
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}
