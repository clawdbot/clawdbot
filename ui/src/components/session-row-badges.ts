import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

function isCloudWorkerPlacementState(
  state: SessionPlacementState | undefined,
): state is Exclude<SessionPlacementState, "local" | "reclaimed"> {
  return state !== undefined && state !== "local" && state !== "reclaimed";
}

export function isStoppableCloudWorkerPlacement(
  placement: GatewaySessionRow["placement"],
): boolean {
  return placement?.state === "active";
}

export function renderSessionRowBadges(params: {
  worktreeId?: string;
  hasAutomation: boolean;
  placementState?: SessionPlacementState;
}) {
  const cloudPlacementState = isCloudWorkerPlacementState(params.placementState)
    ? params.placementState
    : undefined;
  if (!params.worktreeId && !params.hasAutomation && !cloudPlacementState) {
    return nothing;
  }
  const cloudLabel = cloudPlacementState
    ? t("sessionsView.cloudWorkerPlacement", { state: cloudPlacementState })
    : "";
  return html`<span class="session-row-badges">
    ${params.worktreeId
      ? html`<span
          class="session-row-badge"
          role="img"
          aria-label=${t("sessionsView.worktreeSession")}
          title=${t("sessionsView.worktreeSession")}
          >${icons.gitBranch}</span
        >`
      : nothing}
    ${params.hasAutomation
      ? html`<span
          class="session-row-badge"
          role="img"
          aria-label=${t("sessionsView.automationAttached")}
          title=${t("sessionsView.automationAttached")}
          >${icons.clock}</span
        >`
      : nothing}
    ${cloudPlacementState
      ? html`<span
          class="session-row-badge session-row-badge--cloud"
          data-placement-state=${cloudPlacementState}
          role="img"
          aria-label=${cloudLabel}
          title=${cloudLabel}
          >${icons.globe}</span
        >`
      : nothing}
  </span>`;
}
