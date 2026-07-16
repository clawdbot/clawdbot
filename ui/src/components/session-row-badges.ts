import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type CloudPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export function isStoppableCloudWorkerPlacement(
  placement: GatewaySessionRow["placement"],
): boolean {
  return placement?.state === "active";
}

export function renderSessionRowBadges(params: {
  worktreeId?: string;
  hasAutomation: boolean;
  placementState?: CloudPlacementState;
}) {
  if (!params.worktreeId && !params.hasAutomation && !params.placementState) {
    return nothing;
  }
  const cloudLabel = params.placementState
    ? t("sessionsView.cloudWorkerPlacement", { state: params.placementState })
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
    ${params.placementState
      ? html`<span
          class="session-row-badge session-row-badge--cloud"
          data-placement-state=${params.placementState}
          role="img"
          aria-label=${cloudLabel}
          title=${cloudLabel}
          >${icons.server}</span
        >`
      : nothing}
  </span>`;
}
