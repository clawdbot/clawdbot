import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { i18n, t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { sessionOwnerInitials } from "./session-owner-chip.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import "./viewer-facepile.ts";

const MAX_VISIBLE_PULL_REQUESTS = 4;
const MAX_VISIBLE_PARTICIPANTS = 3;

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

function checksLabel(checks: NonNullable<ControlUiSessionPullRequest["checks"]>): string {
  switch (checks.state) {
    case "passing":
      return t("sessionHovercard.checks.passing");
    case "failing":
      return t("sessionHovercard.checks.failing");
    case "pending":
      return t("sessionHovercard.checks.pending");
    default:
      return checks.state satisfies never;
  }
}

function pullRequestStateIcon(state: ControlUiSessionPullRequest["state"]) {
  switch (state) {
    case "open":
      return icons.gitPullRequest;
    case "draft":
      return icons.gitPullRequestDraft;
    case "merged":
      return icons.gitMerge;
    case "closed":
      return icons.gitPullRequestClosed;
    default:
      return state satisfies never;
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

function renderHeader(row: SidebarSessionHovercardRow | undefined) {
  if (!row) {
    return nothing;
  }
  const hasCreatedAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt);
  const created = hasCreatedAt
    ? formatRelativeTimestamp(row.createdAt, { calendarUnits: true, fallback: "" })
    : "";
  const age = hasCreatedAt
    ? formatRelativeTimestamp(row.createdAt, {
        calendarUnits: true,
        fallback: "",
        suffix: false,
      })
    : "";
  const updated = formatRelativeTimestamp(row.updatedAt, { calendarUnits: true, fallback: "" });
  return html`<header class="session-hovercard__header">
    <span class="session-hovercard__heading">
      <span class="session-hovercard__title">${row.label}</span>
      ${updated
        ? html`<span class="session-hovercard__meta"
            >${t("channels.hub.updatedAgo", { ago: updated })}</span
          >`
        : nothing}
    </span>
    ${age
      ? html`<span
          class="session-hovercard__created-age"
          data-created-at=${String(row.createdAt)}
          title=${created}
          >${age}</span
        >`
      : nothing}
  </header>`;
}

function sessionWorkContext(row: SidebarSessionHovercardRow | undefined) {
  return row?.workContext;
}

function renderSessionContext(
  row: SidebarSessionHovercardRow | undefined,
  selfUserId?: string,
  avatarAuth?: SessionHovercardAvatarAuth,
) {
  const creator = row?.createdActor;
  const creatorLabel = creator?.label?.trim() || creator?.id?.trim();
  const creatorInitials = creator ? sessionOwnerInitials(creator) : "";
  const avatarFallback = creatorInitials
    ? html`<span class="session-hovercard__creator-avatar-fallback" aria-hidden="true"
        >${creatorInitials}</span
      >`
    : nothing;
  const context = sessionWorkContext(row);
  const participantIds = new Set<string>();
  let excludedProjectedCount = 0;
  const participants = (row?.participants ?? []).filter((participant) => {
    const id = participant.id?.trim();
    if (!id || participantIds.has(id)) {
      return false;
    }
    participantIds.add(id);
    if (id === creator?.id || id === selfUserId) {
      excludedProjectedCount += 1;
      return false;
    }
    return true;
  });
  const visibleParticipants = participants.slice(0, MAX_VISIBLE_PARTICIPANTS);
  const participantNames = visibleParticipants.map(
    (participant) => participant.label || participant.id || "",
  );
  const formattedParticipantNames = new Intl.ListFormat(i18n.getLocale(), {
    style: "long",
    type: "unit",
  }).format(participantNames);
  const hiddenParticipantCount = Math.max(
    0,
    Math.max(participants.length, (row?.participantCount ?? 0) - excludedProjectedCount) -
      visibleParticipants.length,
  );
  const participantSummary = [
    formattedParticipantNames,
    hiddenParticipantCount > 0
      ? t("sessionHovercard.moreParticipantsLabel", { count: String(hiddenParticipantCount) })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (!creatorLabel && !context && visibleParticipants.length === 0) {
    return nothing;
  }
  if (row?.channelAvatarUrl) {
    ensureChannelAvatarElement();
  }
  return html`<div class="session-hovercard__context">
    ${creatorLabel || visibleParticipants.length > 0
      ? html`<div
          class="session-hovercard__context-row session-hovercard__identity-row"
          aria-label=${[creatorLabel, participantSummary].filter(Boolean).join(", ")}
        >
          ${row?.channelAvatarUrl
            ? html`<openclaw-channel-avatar
                class="session-hovercard__creator-avatar"
                .routeUrl=${row.channelAvatarUrl}
                .authTokens=${avatarAuth?.authTokens ?? []}
                .authReady=${avatarAuth?.authReady ?? false}
                .fallback=${avatarFallback}
                aria-hidden="true"
              ></openclaw-channel-avatar>`
            : creator?.id
              ? html`<openclaw-viewer-avatar
                  class="session-hovercard__creator-avatar"
                  .user=${{
                    id: creator.id,
                    name: creator.label,
                    avatarUrl: creator.avatarUrl,
                    watchedSessions: [],
                  }}
                  .markAsViewer=${false}
                  variant="session"
                  aria-hidden="true"
                ></openclaw-viewer-avatar>`
              : html`<span class="session-hovercard__context-icon" aria-hidden="true"
                  >${icons.users}</span
                >`}
          <span class="session-hovercard__identity-copy">
            ${creatorLabel
              ? html`<span class="session-hovercard__identity-name">${creatorLabel}</span>`
              : nothing}
            ${creatorLabel && visibleParticipants.length > 0
              ? html`<span class="session-hovercard__identity-separator" aria-hidden="true"
                  >·</span
                >`
              : nothing}
            ${visibleParticipants.length > 0
              ? html`<span class="session-hovercard__participants">
                  <span class="session-hovercard__participant"
                    >${t("sessionsView.withParticipant", {
                      name: formattedParticipantNames,
                    })}</span
                  >
                  ${hiddenParticipantCount > 0
                    ? html`<span class="session-hovercard__participants-more"
                        >${t("sessionHovercard.moreParticipants", {
                          count: String(hiddenParticipantCount),
                        })}</span
                      >`
                    : nothing}
                </span>`
              : nothing}
          </span>
        </div>`
      : nothing}
    ${context
      ? html`<div
            class="session-hovercard__context-row"
            aria-label=${`${t("sessionHovercard.projectLabel")}: ${context.project}`}
            title=${`${t("sessionHovercard.projectLabel")}: ${context.project}`}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true">${icons.folder}</span>
            <span
              class="session-hovercard__context-value session-hovercard__context-text"
              title=${context.project}
              >${context.project}</span
            >
          </div>
          ${context.branch
            ? html`<div
                class="session-hovercard__context-row"
                aria-label=${`${t("sessionHovercard.branchLabel")}: ${context.branch}`}
                title=${`${t("sessionHovercard.branchLabel")}: ${context.branch}`}
              >
                <span class="session-hovercard__context-icon" aria-hidden="true"
                  >${icons.gitBranch}</span
                >
                <span
                  class="session-hovercard__context-value session-hovercard__context-text"
                  title=${context.branch}
                  >${context.branch}</span
                >
              </div>`
            : nothing}`
      : nothing}
  </div>`;
}

function renderPullRequestRow(pullRequest: ControlUiSessionPullRequest) {
  const state = pullRequestStateLabel(pullRequest.state);
  const checks = pullRequest.checks ? checksLabel(pullRequest.checks) : null;
  const details = [
    checks,
    pullRequest.changedFiles === undefined ? null : changedFilesLabel(pullRequest.changedFiles),
    pullRequest.additions === undefined ? null : `+${pullRequest.additions.toLocaleString()}`,
    pullRequest.deletions === undefined ? null : `−${pullRequest.deletions.toLocaleString()}`,
  ].filter((detail): detail is string => Boolean(detail));
  return html`<a
    class="session-hovercard__pr-row"
    data-state=${pullRequest.state}
    href=${pullRequest.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${`${t("sessionHovercard.pullRequestLabel", {
      number: String(pullRequest.number),
      state,
    })}${details.length > 0 ? `, ${details.join(", ")}` : ""}`}
  >
    <span
      class="session-hovercard__pr-state-icon"
      role="img"
      data-checks=${pullRequest.checks?.state ?? nothing}
      aria-label=${checks ? `${state} · ${checks}` : state}
      title=${checks ? `${state} · ${checks}` : state}
      >${pullRequestStateIcon(pullRequest.state)}</span
    >
    <span class="session-hovercard__pr-number">#${pullRequest.number}</span>
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
    return html`<div class="session-hovercard__pr-list">
      ${visible.map(renderPullRequestRow)}
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
  const createPullRequest = t("chat.pullRequests.createPr");
  return html`
    <div class="session-hovercard__branch-row">
      <span class="session-hovercard__branch-icon" aria-hidden="true">${icons.gitBranch}</span>
      <span class="session-hovercard__branch-name"
        >${branch.owner}/${branch.repo} · ${branch.branch}</span
      >
      ${renderDiffStats(branch)}
    </div>
    <div class="session-hovercard__no-pr">
      ${branch.createUrl
        ? html`<a href=${branch.createUrl} target="_blank" rel="noopener noreferrer"
            >${createPullRequest}</a
          >`
        : noPullRequest}
    </div>
  `;
}

export function renderSessionHovercard(input: {
  row?: SidebarSessionHovercardRow;
  selfUserId?: string;
  avatarAuth?: SessionHovercardAvatarAuth;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
}) {
  const hasPullRequestDetails = Boolean(
    input.pullRequests && (input.pullRequests.pullRequests.length > 0 || input.pullRequests.branch),
  );
  const creatorId = input.row?.createdActor?.id;
  const hasOtherParticipant = input.row?.participants?.some((participant) => {
    const id = participant.id?.trim();
    return Boolean(id && id !== creatorId && id !== input.selfUserId);
  });
  const hasContext = Boolean(
    input.row?.channelAvatarUrl ||
    input.row?.createdActor ||
    sessionWorkContext(input.row) ||
    hasOtherParticipant,
  );
  const lastMessagePreview = input.progressCard
    ? undefined
    : input.row?.lastMessagePreview?.trim() || undefined;
  if (!input.row && !hasPullRequestDetails && !input.progressCard) {
    return nothing;
  }
  return html`<div class="session-hovercard">
    ${input.row
      ? html`<section class="session-hovercard__section session-hovercard__section--header">
          ${renderHeader(input.row)}
        </section>`
      : nothing}
    ${hasContext
      ? html`<section class="session-hovercard__section session-hovercard__section--metadata">
          ${renderSessionContext(input.row, input.selfUserId, input.avatarAuth)}
        </section>`
      : nothing}
    ${hasPullRequestDetails
      ? html`<section class="session-hovercard__section session-hovercard__section--prs">
          ${renderPullRequestDetails(input.pullRequests)}
        </section>`
      : nothing}
    ${lastMessagePreview
      ? html`<section class="session-hovercard__section session-hovercard__section--optional">
          <div class="session-hovercard__excerpt">${lastMessagePreview}</div>
        </section>`
      : nothing}
    ${input.progressCard
      ? html`<footer class="session-hovercard__section session-hovercard__progress-footer">
          ${renderSessionProgressCard(input.progressCard, "hovercard")}
        </footer>`
      : nothing}
  </div>`;
}
