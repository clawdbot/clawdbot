import { html, nothing, type TemplateResult } from "lit";
// Deep import on purpose: the protocol barrel carries typebox and every
// schema, which must stay out of the Control UI startup bundle.
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

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

function renderSessionRowBadge(
  label: string,
  icon: TemplateResult,
  modifier = "",
  count = 0,
  pullRequestState?: SessionCatalogPullRequestSummary["state"],
  placementState?: SessionPlacementState,
  diskSpaceStatus?: SessionPlacementDiskSpace["status"],
  workspaceConflictCount = 0,
) {
  return html`<openclaw-tooltip .content=${label}>
    <span
      class=${`session-row-badge${modifier ? ` ${modifier}` : ""}`}
      data-pull-request-state=${pullRequestState ?? nothing}
      data-placement-state=${placementState ?? nothing}
      data-disk-space-status=${diskSpaceStatus ?? nothing}
      data-workspace-conflicts=${workspaceConflictCount ? String(workspaceConflictCount) : nothing}
      role="img"
      aria-label=${label}
      >${icon}${count ? html`<span aria-hidden="true">${count}</span>` : nothing}</span
    >
  </openclaw-tooltip>`;
}

export function renderSessionRowBadges(params: {
  isChild?: boolean;
  incognito?: boolean;
  hasAutomation: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  hasApproval?: boolean;
  outboxAttentionCount?: number;
  hasComposerDraft?: boolean;
  placementState?: SessionPlacementState;
  diskSpaceStatus?: SessionPlacementDiskSpace["status"];
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
  const diskSpaceStatus = params.isChild ? undefined : params.diskSpaceStatus;
  const diskSpaceLabel =
    diskSpaceStatus === "critical"
      ? t("sessionsView.cloudWorkerDiskCritical")
      : diskSpaceStatus === "warning"
        ? t("sessionsView.cloudWorkerDiskWarning")
        : "";
  const attentionCount = Math.max(0, Math.floor(params.outboxAttentionCount ?? 0));
  const attentionLabel =
    attentionCount > 0
      ? t(
          attentionCount === 1
            ? "sessionsView.messageNeedsAttention"
            : "sessionsView.messagesNeedAttention",
          {
            count: String(attentionCount),
          },
        )
      : "";
  if (
    !params.incognito &&
    !hasAutomation &&
    !pullRequestLabel &&
    !params.hasApproval &&
    attentionCount === 0 &&
    !params.hasComposerDraft &&
    !displayedPlacementState &&
    !hasWorkspaceConflict
  ) {
    return nothing;
  }
  const cloudPlacementLabel = hasWorkspaceConflict
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
  const cloudLabel = [cloudPlacementLabel, diskSpaceLabel].filter(Boolean).join(" · ");
  return html`<span class="session-row-badges">
    ${params.incognito
      ? renderSessionRowBadge(
          t("sessionsView.incognito"),
          icons.lock,
          "session-row-badge--incognito",
        )
      : nothing}
    ${hasAutomation
      ? renderSessionRowBadge(t("sessionsView.automationAttached"), icons.clock)
      : nothing}
    ${pullRequestLabel
      ? renderSessionRowBadge(
          pullRequestLabel,
          icons.gitPullRequest,
          "session-row-badge--pull-request",
          0,
          pullRequestState,
        )
      : nothing}
    ${params.hasApproval
      ? renderSessionRowBadge(
          t("sessionsView.approvalNeeded"),
          icons.alertTriangle,
          "session-row-badge--approval",
        )
      : nothing}
    ${attentionCount > 0
      ? renderSessionRowBadge(
          attentionLabel,
          icons.alertTriangle,
          "session-row-badge--attention",
          attentionCount,
        )
      : nothing}
    ${params.hasComposerDraft
      ? renderSessionRowBadge(
          t("sessionsView.unsentDraft"),
          icons.pencil,
          "session-row-badge--draft",
        )
      : nothing}
    ${displayedPlacementState || hasWorkspaceConflict
      ? renderSessionRowBadge(
          cloudLabel,
          icons.globe,
          "session-row-badge--cloud",
          0,
          undefined,
          displayedPlacementState,
          diskSpaceStatus,
          hasWorkspaceConflict ? workspaceConflictCount : 0,
        )
      : nothing}
  </span>`;
}

export function renderOfflineSidebarStatus(props: {
  queuedOutboxCount: number;
  reconnecting: string;
  title?: string;
  onRetry: () => void;
}) {
  const offline = t("common.offline");
  const count = props.queuedOutboxCount;
  const queued = count ? t("connection.queuedCount", { count: String(count) }) : null;
  return html`<openclaw-tooltip .content=${props.title ?? ""}>
    <button
      type="button"
      class="sidebar-footer-bar__status"
      aria-live="polite"
      aria-label=${`${offline} — ${t("connection.retryNow")}${queued ? ` — ${queued}` : ""}`}
      @click=${props.onRetry}
    >
      <span class="sidebar-footer-bar__status-dot" aria-hidden="true"></span>${offline}<span
        class="sidebar-footer-bar__status-detail"
        >· ${props.reconnecting}</span
      >${queued
        ? html`<span class="sidebar-footer-bar__status-detail">· ${queued}</span>`
        : nothing}
    </button>
  </openclaw-tooltip>`;
}
