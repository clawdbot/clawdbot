import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../../../i18n/locales/en-session-placement.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

registerSessionPlacementEnglish();

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
  const runner =
    props.session?.placement?.state === "active" ? props.session.placement.runner : undefined;
  const deviceOffline = runner?.kind === "device" && runner.status === "offline";
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
        : deviceOffline
          ? t("sessionsView.deviceOffline")
          : runner?.kind === "device"
            ? t("sessionsView.runsOnDevice")
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
    <div class="chat-pane__placement-control">
      <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
        <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
        ${exceptionState === nothing
          ? nothing
          : html`<div class="chat-pane__placement-state">${exceptionState}</div>`}
        <wa-dropdown-item
          class="session-menu__item chat-pane__placement-move ${deviceOffline
            ? "session-menu__item--destructive"
            : ""}"
          variant=${deviceOffline ? "danger" : nothing}
          ?disabled=${Boolean(moveDisabledReason)}
          title=${moveDisabledReason ?? nothing}
          @click=${() => !moveDisabledReason && props.onPlacementMove?.()}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.monitor}</span>
          <span class="session-menu__text"
            >${deviceOffline
              ? t("sessionsView.continueOnGatewayMenu")
              : t("sessionsView.moveSession")}</span
          >
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item session-menu__item--destructive chat-pane__placement-reclaim"
          variant="danger"
          ?disabled=${Boolean(reclaimDisabledReason)}
          title=${reclaimDisabledReason ?? nothing}
          @click=${() => !reclaimDisabledReason && props.onPlacementReclaim?.()}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.stop}</span>
          <span class="session-menu__text"
            >${runner?.kind === "device"
              ? t("sessionsView.stopDeviceWorker")
              : t("sessionsView.stopCloudWorker")}</span
          >
        </wa-dropdown-item>
      </wa-dropdown>
      ${deviceOffline
        ? html`<div class="chat-pane__placement-note" role="status">
            ${t("sessionsView.waitingForDevice")}
          </div>`
        : nothing}
    </div>
  `;
}
