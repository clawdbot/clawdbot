import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionOwnerInitials } from "./session-owner-chip.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";

const MAX_VISIBLE_PULL_REQUESTS = 3;

type SessionHovercardAvatarAuth = {
  authTokens: readonly string[];
  authReady: boolean;
};

let channelAvatarElementLoad: Promise<unknown> | undefined;
function ensureChannelAvatarElement(): void {
  channelAvatarElementLoad ??= import("./channel-avatar.ts");
}

function pullRequestStateLabel(state: ControlUiSessionPullRequest["state"]): string {
  return t(`sessionHovercard.states.${state}`);
}

function checksPresentation(checks: NonNullable<ControlUiSessionPullRequest["checks"]>): {
  glyph: string;
  label: string;
} {
  switch (checks.state) {
    case "passing":
      return { glyph: "✓", label: t("sessionHovercard.checks.passing") };
    case "failing":
      return { glyph: "✗", label: t("sessionHovercard.checks.failing") };
    case "pending":
      return { glyph: "○", label: t("sessionHovercard.checks.pending") };
    default:
      return checks.state satisfies never;
  }
}

function changedFilesLabel(changedFiles: number): string {
  return t(changedFiles === 1 ? "sessionHovercard.changedFile" : "sessionHovercard.changedFiles", {
    count: String(changedFiles),
  });
}

function renderDiffStats(item: { additions?: number; deletions?: number; changedFiles?: number }) {
  if (
    item.additions === undefined &&
    item.deletions === undefined &&
    item.changedFiles === undefined
  ) {
    return nothing;
  }
  return html`<span class="session-hovercard__diff">
    ${item.changedFiles === undefined
      ? nothing
      : html`<span class="session-hovercard__files">${changedFilesLabel(item.changedFiles)}</span>`}
    ${item.additions === undefined
      ? nothing
      : html`<span class="session-hovercard__additions">+${item.additions.toLocaleString()}</span>`}
    ${item.deletions === undefined
      ? nothing
      : html`<span class="session-hovercard__deletions">−${item.deletions.toLocaleString()}</span>`}
  </span>`;
}

function renderHeader(
  row: SidebarRecentSession | undefined,
  channelAvatarAuth: SessionHovercardAvatarAuth | undefined,
) {
  if (!row) {
    return nothing;
  }
  const owner = row.owner?.actor ?? row.createdActor;
  const ownerLabel = owner?.label?.trim() || owner?.id?.trim();
  const initials = owner ? sessionOwnerInitials(owner) : "";
  const avatarFallback = initials
    ? html`<span class="session-hovercard__avatar-fallback" aria-hidden="true">${initials}</span>`
    : nothing;
  const created = formatRelativeTimestamp(row.startedAt, { fallback: "" });
  const updated = formatRelativeTimestamp(row.updatedAt, { fallback: "" });
  const metadata = [
    ownerLabel,
    created ? t("sessionHovercard.created", { time: created }) : undefined,
    updated ? t("sessionHovercard.updated", { time: updated }) : undefined,
  ].filter((value): value is string => Boolean(value));
  if (row.channelAvatarUrl) {
    ensureChannelAvatarElement();
  }
  return html`<header class="session-hovercard__header">
    ${row.channelAvatarUrl
      ? html`<openclaw-channel-avatar
          class="session-hovercard__avatar"
          .routeUrl=${row.channelAvatarUrl}
          .authTokens=${channelAvatarAuth?.authTokens ?? []}
          .authReady=${channelAvatarAuth?.authReady ?? false}
          .fallback=${avatarFallback}
        ></openclaw-channel-avatar>`
      : initials
        ? html`<span class="session-hovercard__avatar" aria-hidden="true">${initials}</span>`
        : nothing}
    <span class="session-hovercard__heading">
      <span class="session-hovercard__title">${row.label}</span>
      ${metadata.length > 0
        ? html`<span class="session-hovercard__meta">${metadata.join(" · ")}</span>`
        : nothing}
    </span>
  </header>`;
}

function renderPullRequestChip(pullRequest: ControlUiSessionPullRequest) {
  const state = pullRequestStateLabel(pullRequest.state);
  const checks = pullRequest.checks ? checksPresentation(pullRequest.checks) : null;
  return html`<a
    class="session-hovercard__chip session-hovercard__pr-chip"
    data-state=${pullRequest.state}
    href=${pullRequest.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${t("sessionHovercard.pullRequestLabel", {
      number: String(pullRequest.number),
      state,
    })}
  >
    <span class="session-hovercard__pr-number">#${pullRequest.number}</span>
    <span class="session-hovercard__pr-state">${state}</span>
    ${checks
      ? html`<span
          class="session-hovercard__checks"
          data-checks=${pullRequest.checks?.state}
          aria-label=${checks.label}
          title=${checks.label}
          >${checks.glyph}</span
        >`
      : nothing}
    ${renderDiffStats(pullRequest)}
  </a>`;
}

function renderPullRequestDetails(snapshot: ControlUiSessionPullRequestSnapshot | undefined) {
  if (!snapshot) {
    return nothing;
  }
  if (snapshot.pullRequests.length > 0) {
    const visible = snapshot.pullRequests.slice(0, MAX_VISIBLE_PULL_REQUESTS);
    const hiddenCount = snapshot.pullRequests.length - visible.length;
    return html`<div class="session-hovercard__chips">
      ${visible.map(renderPullRequestChip)}
      ${hiddenCount > 0
        ? html`<span class="session-hovercard__more"
            >${t("sessionHovercard.more", { count: String(hiddenCount) })}</span
          >`
        : nothing}
    </div>`;
  }
  const branch = snapshot.branch;
  if (!branch) {
    return nothing;
  }
  const noPullRequest = t("sessionHovercard.noPrYet");
  return html`
    <div class="session-hovercard__chips">
      <span class="session-hovercard__chip session-hovercard__branch-chip"
        >${branch.owner}/${branch.repo} · ${branch.branch}</span
      >
      ${renderDiffStats(branch)}
    </div>
    <div class="session-hovercard__no-pr">
      ${branch.createUrl
        ? html`<a href=${branch.createUrl} target="_blank" rel="noopener noreferrer"
            >${noPullRequest}</a
          >`
        : noPullRequest}
    </div>
  `;
}

export function renderSessionHovercard(input: {
  row?: SidebarRecentSession;
  channelAvatarAuth?: SessionHovercardAvatarAuth;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
}) {
  const hasPullRequestDetails = Boolean(
    input.pullRequests && (input.pullRequests.pullRequests.length > 0 || input.pullRequests.branch),
  );
  const lastMessagePreview = input.progressCard
    ? undefined
    : input.row?.lastMessagePreview?.trim() || undefined;
  if (!input.row && !hasPullRequestDetails && !input.progressCard) {
    return nothing;
  }
  return html`<div class="session-hovercard">
    ${renderHeader(input.row, input.channelAvatarAuth)}
    ${renderPullRequestDetails(input.pullRequests)}
    ${input.progressCard
      ? html`<div class="session-hovercard__divider" role="presentation"></div>
          ${renderSessionProgressCard(input.progressCard, "hovercard")}`
      : lastMessagePreview
        ? html`<div class="session-hovercard__divider" role="presentation"></div>
            <div class="session-hovercard__excerpt">${lastMessagePreview}</div>`
        : nothing}
  </div>`;
}
