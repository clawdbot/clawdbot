import { html, nothing } from "lit";
// Deep import on purpose: the protocol barrel carries typebox and every
// schema, which must stay out of the Control UI startup bundle.
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
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

function pullRequestStateLabel(state: SessionCatalogPullRequestSummary["state"]): string {
  switch (state) {
    case "open":
      return t("chat.pullRequests.open");
    case "draft":
      return t("chat.pullRequests.draft");
    case "merged":
      return t("chat.pullRequests.merged");
    case "closed":
      return t("chat.pullRequests.closed");
    default:
      return state satisfies never;
  }
}

function formatSessionPullRequestSummary(summary: SessionCatalogPullRequestSummary): string {
  const numbers = summary.numbers.map((number) => `#${number}`).join(", ");
  return `${numbers} · ${pullRequestStateLabel(summary.state)}`;
}

export function renderSessionRowBadges(params: {
  isChild?: boolean;
  hasAutomation: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  hasApproval?: boolean;
  placementState?: SessionPlacementState;
  workspaceConflictCount?: number;
}) {
  const hasAutomation = !params.isChild && params.hasAutomation;
  const pullRequestLabel = params.pullRequest
    ? formatSessionPullRequestSummary(params.pullRequest)
    : undefined;
  const pullRequestState = params.pullRequest?.state;
  const placementState = params.isChild ? undefined : params.placementState;
  const cloudPlacementState = isCloudWorkerPlacementState(placementState)
    ? placementState
    : undefined;
  const workspaceConflictCount = Math.max(0, Math.floor(params.workspaceConflictCount ?? 0));
  // Child rows suppress ordinary placement chrome, but a retained conflict must stay discoverable.
  const conflictPlacementState = workspaceConflictCount > 0 ? params.placementState : undefined;
  const displayedPlacementState = cloudPlacementState ?? conflictPlacementState;
  const hasWorkspaceConflict = workspaceConflictCount > 0;
  if (
    !hasAutomation &&
    !pullRequestLabel &&
    !params.hasApproval &&
    !displayedPlacementState &&
    !hasWorkspaceConflict
  ) {
    return nothing;
  }
  const cloudLabel = hasWorkspaceConflict
    ? displayedPlacementState
      ? t(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerPlacementConflict"
            : "sessionsView.cloudWorkerPlacementConflicts",
          {
            state: displayedPlacementState,
            count: String(workspaceConflictCount),
          },
        )
      : t(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerDescendantConflict"
            : "sessionsView.cloudWorkerDescendantConflicts",
          { count: String(workspaceConflictCount) },
        )
    : displayedPlacementState
      ? t("sessionsView.cloudWorkerPlacement", { state: displayedPlacementState })
      : "";
  return html`<span class="session-row-badges">
    ${hasAutomation
      ? html`<span
          class="session-row-badge"
          role="img"
          aria-label=${t("sessionsView.automationAttached")}
          title=${t("sessionsView.automationAttached")}
          >${icons.clock}</span
        >`
      : nothing}
    ${pullRequestLabel
      ? html`<span
          class="session-row-badge session-row-badge--pull-request"
          data-pull-request-state=${pullRequestState ?? nothing}
          role="img"
          aria-label=${pullRequestLabel}
          title=${pullRequestLabel}
          >${icons.gitPullRequest}</span
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
    ${displayedPlacementState || hasWorkspaceConflict
      ? html`<span
          class="session-row-badge session-row-badge--cloud"
          data-placement-state=${displayedPlacementState ?? nothing}
          data-workspace-conflicts=${hasWorkspaceConflict
            ? String(workspaceConflictCount)
            : nothing}
          role="img"
          aria-label=${cloudLabel}
          title=${cloudLabel}
          >${icons.globe}</span
        >`
      : nothing}
  </span>`;
}
