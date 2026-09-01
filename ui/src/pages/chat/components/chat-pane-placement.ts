import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../../../i18n/locales/en-session-placement.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
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
  const placement = props.session?.placement;
  const placementState = placement?.state;
  if (!isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const placementMove = props.session?.placementMove;
  const workerPlacement =
    placement && placement.state !== "local" && placement.state !== "requested"
      ? placement
      : undefined;
  const providerId = workerPlacement?.providerId;
  const profileId = workerPlacement?.profileId;
  const environmentId = workerPlacement?.environmentId;
  const hasFacts = Boolean(providerId || profileId || environmentId);
  const runner = placement?.state === "active" ? placement.runner : undefined;
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
            : providerId && profileId
              ? `${providerId} · ${profileId}`
              : t("newSession.runsOn", { place: t("newSession.cloud") });
  const moveDisabledReason = props.placementMoveDisabledReason;
  const reclaimDisabledReason = props.placementReclaimDisabledReason;
  const age = formatRelativeTimestamp(placement?.stateChangedAtMs, {
    fallback: "",
  });
  const exceptionState = placementMove?.error
    ? placementMove.error
    : placementState === "active" || hasFacts
      ? nothing
      : `${placementState}${age ? ` · ${age}` : ""}`;
  return html`
    <div class="chat-pane__placement-control">
      <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
        <button slot="trigger" class="chat-pane__placement-chip" type="button">${label}</button>
        ${exceptionState === nothing
          ? nothing
          : html`<div class="chat-pane__placement-state">${exceptionState}</div>`}
        ${hasFacts
          ? html`<dl class="chat-pane__placement-facts">
              ${providerId
                ? html`<dt>${t("sessionsView.placementFactService")}</dt>
                    <dd>${providerId}</dd>`
                : nothing}
              ${profileId
                ? html`<dt>${t("sessionsView.placementFactProfile")}</dt>
                    <dd>${profileId}</dd>`
                : nothing}
              ${environmentId
                ? html`<dt>${t("sessionsView.placementFactMachine")}</dt>
                    <dd>…${environmentId.slice(-6)}</dd>`
                : nothing}
              <dt>${t("sessionsView.placementFactState")}</dt>
              <dd>${placementState}${age ? ` · ${age}` : ""}</dd>
              ${placement?.state === "active" && placement.diskSpace
                ? html`<dt>${t("sessionsView.placementFactDisk")}</dt>
                    <dd>
                      ${t("sessionsView.placementDiskFree", {
                        free: formatBytes(placement.diskSpace.availableBytes),
                      })}
                    </dd>`
                : nothing}
            </dl>`
          : nothing}
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
