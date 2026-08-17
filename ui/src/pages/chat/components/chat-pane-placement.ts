import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

export function renderChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementMoving?: boolean;
  placementMoveDisabledReason?: string;
  placementReclaimDisabledReason?: string;
  onPlacementMove?: () => void;
  onPlacementReclaim?: () => void;
}): TemplateResult | typeof nothing {
  const placementState = props.session?.placement?.state;
  if (!isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const placementMove = props.session?.placementMove;
  const moveTarget =
    placementMove?.target.kind === "gateway"
      ? t("sessionsView.moveSessionGatewayTarget")
      : placementMove?.target.kind === "profile"
        ? placementMove.target.profileId
        : placementMove?.target.kind === "device"
          ? placementMove.target.deviceId
          : undefined;
  const label = placementMove?.error
    ? t("sessionsView.moveSessionFailed")
    : placementMove && moveTarget
      ? t("sessionsView.movingSession", { target: moveTarget })
      : props.placementMoving
        ? t("sessionsView.movingSessionGeneric")
        : t("newSession.runsOn", { place: t("newSession.cloud") });
  const moveDisabledReason = props.placementMoveDisabledReason;
  const reclaimDisabledReason = props.placementReclaimDisabledReason;
  const age = formatRelativeTimestamp(props.session?.placement?.stateChangedAtMs, {
    fallback: "",
  });
  const exceptionState = placementMove?.error
    ? placementMove.error
    : placementState === "active"
      ? nothing
      : `${placementState}${age ? ` · ${age}` : ""}`;
  return html`
    <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
      <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
      ${exceptionState === nothing
        ? nothing
        : html`<div class="chat-pane__placement-state">${exceptionState}</div>`}
      <wa-dropdown-item
        class="session-menu__item chat-pane__placement-move"
        ?disabled=${Boolean(moveDisabledReason)}
        title=${moveDisabledReason ?? nothing}
        @click=${() => !moveDisabledReason && props.onPlacementMove?.()}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.monitor}</span>
        <span class="session-menu__text">${t("sessionsView.moveSession")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item
        class="session-menu__item session-menu__item--destructive chat-pane__placement-reclaim"
        variant="danger"
        ?disabled=${Boolean(reclaimDisabledReason)}
        title=${reclaimDisabledReason ?? nothing}
        @click=${() => !reclaimDisabledReason && props.onPlacementReclaim?.()}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.stop}</span>
        <span class="session-menu__text">${t("sessionsView.stopCloudWorker")}</span>
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}
