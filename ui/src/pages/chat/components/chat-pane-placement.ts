import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import { icons } from "../../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { resolveChatPaneWorkerPresentation } from "../chat-pane-placement.ts";

export function renderChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementStartupStatus?: Pick<ApplicationPlacementStartupStatus, "phase" | "targetKind"> | null;
  placementMoving?: boolean;
  placementRestarting?: boolean;
  placementMoveDisabledReason?: string;
  placementReclaimDisabledReason?: string;
  placementRestartDisabledReason?: string;
  onPlacementMove?: () => void;
  onPlacementReclaim?: () => void;
  onPlacementRestart?: () => void;
}): TemplateResult | typeof nothing {
  const session = props.session;
  const placement = session?.placement;
  const placementState = placement?.state;
  if (!session || !isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const placementMove = session.placementMove;
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
  const restartable = placement?.state === "failed" && placement.recoveryAction === "restart";
  const worker = resolveChatPaneWorkerPresentation(session, props.placementStartupStatus);
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
      : props.placementRestarting
        ? t("sessionsView.restartingSession")
        : props.placementMoving
          ? t("sessionsView.movingSessionGeneric")
          : deviceOffline
            ? t("sessionsView.deviceOffline")
            : worker.label;
  const moveDisabledReason = props.placementMoveDisabledReason;
  const reclaimDisabledReason = props.placementReclaimDisabledReason;
  const restartDisabledReason = props.placementRestartDisabledReason;
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
        ${
          exceptionState === nothing
            ? nothing
            : html`<div class="chat-pane__placement-state">${exceptionState}</div>`
        }
        ${
          hasFacts
            ? html`<dl class="chat-pane__placement-facts">
                ${
                  providerId
                    ? html`<dt>${t("sessionsView.placementFactService")}</dt>
                        <dd>${providerId}</dd>`
                    : nothing
                }
                ${
                  profileId
                    ? html`<dt>${t("sessionsView.placementFactProfile")}</dt>
                        <dd>${profileId}</dd>`
                    : nothing
                }
                ${
                  environmentId
                    ? html`<dt>${t("sessionsView.placementFactMachine")}</dt>
                        <dd>…${environmentId.slice(-6)}</dd>`
                    : nothing
                }
                <dt>${t("sessionsView.placementFactState")}</dt>
                <dd>${placementState}${age ? ` · ${age}` : ""}</dd>
                ${
                  placement?.state === "active" && placement.diskSpace
                    ? html`<dt>${t("sessionsView.placementFactDisk")}</dt>
                        <dd>
                          ${t("sessionsView.placementDiskFree", {
                            free: formatBytes(placement.diskSpace.availableBytes),
                          })}
                        </dd>`
                    : nothing
                }
              </dl>`
            : nothing
        }
        ${
          placementState === "active"
            ? html`<wa-dropdown-item
                class="session-menu__item chat-pane__placement-move ${
                  deviceOffline ? "session-menu__item--destructive" : ""
                }"
                variant=${deviceOffline ? "danger" : nothing}
                ?disabled=${Boolean(moveDisabledReason)}
                title=${moveDisabledReason ?? nothing}
                @click=${() => !moveDisabledReason && props.onPlacementMove?.()}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <span class="session-menu__text"
                  >${
                    deviceOffline
                      ? t("sessionsView.continueOnGatewayMenu")
                      : t("sessionsView.moveSession")
                  }</span
                >
              </wa-dropdown-item>`
            : nothing
        }
        ${
          restartable
            ? html`<wa-dropdown-item
                class="session-menu__item chat-pane__placement-restart"
                ?disabled=${Boolean(restartDisabledReason)}
                title=${restartDisabledReason ?? nothing}
                @click=${() => !restartDisabledReason && props.onPlacementRestart?.()}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <span class="session-menu__text">${t("sessionsView.restartSession")}</span>
              </wa-dropdown-item>`
            : nothing
        }
        ${
          restartable
            ? nothing
            : html`<wa-dropdown-item
                class="session-menu__item session-menu__item--destructive chat-pane__placement-reclaim"
                variant="danger"
                ?disabled=${Boolean(reclaimDisabledReason)}
                title=${reclaimDisabledReason ?? nothing}
                @click=${() => !reclaimDisabledReason && props.onPlacementReclaim?.()}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.stop}</span>
                <span class="session-menu__text">${worker.stopLabel}</span>
              </wa-dropdown-item>`
        }
      </wa-dropdown>
      ${
        deviceOffline
          ? html`<div class="chat-pane__placement-note" role="status">
              ${t("sessionsView.waitingForDevice")}
            </div>`
          : nothing
      }
    </div>
  `;
}
