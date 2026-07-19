import { html, nothing } from "lit";
// Deep import on purpose: the protocol barrel carries typebox and every
// schema, which must stay out of the Control UI startup bundle.
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

export function isStoppableCloudWorkerPlacement(
  placement: GatewaySessionRow["placement"],
): boolean {
  return placement?.state === "active";
}

export function renderSessionRowBadges(params: {
  isChild?: boolean;
  worktreeId?: string;
  hasAutomation: boolean;
  hasApproval?: boolean;
  placementState?: SessionPlacementState;
}) {
  const worktreeId = params.isChild ? undefined : params.worktreeId;
  const hasAutomation = !params.isChild && params.hasAutomation;
  const placementState = params.isChild ? undefined : params.placementState;
  const cloudPlacementState = isCloudWorkerPlacementState(placementState)
    ? placementState
    : undefined;
  if (!worktreeId && !hasAutomation && !params.hasApproval && !cloudPlacementState) {
    return nothing;
  }
  const cloudLabel = cloudPlacementState
    ? t("sessionsView.cloudWorkerPlacement", { state: cloudPlacementState })
    : "";
  return html`<span class="session-row-badges">
    ${worktreeId
      ? html`<span
          class="session-row-badge"
          role="img"
          aria-label=${t("sessionsView.worktreeSession")}
          title=${t("sessionsView.worktreeSession")}
          >${icons.gitBranch}</span
        >`
      : nothing}
    ${hasAutomation
      ? html`<span
          class="session-row-badge"
          role="img"
          aria-label=${t("sessionsView.automationAttached")}
          title=${t("sessionsView.automationAttached")}
          >${icons.clock}</span
        >`
      : nothing}
    ${params.hasApproval
      ? html`<span
          class="session-row-badge session-row-badge--approval"
          role="img"
          aria-label=${t("sessionsView.approvalNeeded")}
          title=${t("sessionsView.approvalNeeded")}
          >${icons.alertTriangle}</span
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
