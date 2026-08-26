import type { ProgressCard } from "@openclaw/gateway-protocol";
import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
import { html, nothing, type TemplateResult } from "lit";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { i18n, t } from "../i18n/index.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  personActivityLink,
  renderPersonAvatarLink,
  renderPersonName,
  type PersonActivityRouting,
} from "./person-activity-link.ts";
import { sessionOwnerInitials, type SessionCreatedActor } from "./session-owner-chip.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import "./viewer-facepile.ts";

const MAX_VISIBLE_PULL_REQUESTS = 4;
const MAX_VISIBLE_PARTICIPANTS = 3;

function participantLabel(participant: SessionCreatedActor): string {
  return participant.label?.trim() || participant.id?.trim() || "";
}

type SessionAgeUnit = RelativeTimeUnit | "week" | "month" | "year";

type SessionHovercardAvatarAuth = {
  authTokens: readonly string[];
  authReady: boolean;
};

type SessionHovercardInput = {
  row?: SidebarSessionHovercardRow;
  selfUserId?: string;
  avatarAuth?: SessionHovercardAvatarAuth;
  personActivity?: PersonActivityRouting;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
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

function sessionAgeBucket(diffMs: number): { value: number; unit: SessionAgeUnit } {
  const days = Math.abs(diffMs) / (24 * 60 * 60_000);
  if (days >= 365) {
    return { value: Math.max(1, Math.round(days / 365)), unit: "year" };
  }
  if (days >= 28) {
    return { value: Math.max(1, Math.round(days / 30)), unit: "month" };
  }
  if (days >= 7) {
    return { value: Math.max(1, Math.round(days / 7)), unit: "week" };
  }
  if (days >= 1) {
    return { value: Math.max(1, Math.round(days)), unit: "day" };
  }
  return bucketRelativeTimeMs(Math.abs(diffMs));
}

function formatSessionAge(timestamp: number | null | undefined, suffix: boolean): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  const diff = timestamp - Date.now();
  const { value, unit } = sessionAgeBucket(diff);
  if (suffix) {
    if (unit === "second" && diff <= 0) {
      return t("common.justNow");
    }
    return new Intl.RelativeTimeFormat(i18n.getLocale(), {
      numeric: "always",
      style: "narrow",
    }).format(diff <= 0 ? -value : value, unit);
  }
  if (i18n.getLocale().toLowerCase().startsWith("en")) {
    const compactSuffix: Partial<Record<SessionAgeUnit, string>> = {
      day: "d",
      week: "w",
      month: "mo",
      year: "y",
    };
    const unitSuffix = compactSuffix[unit];
    if (unitSuffix) {
      return `${value}${unitSuffix}`;
    }
  }
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(value);
}

function renderHeader(row: SidebarSessionHovercardRow) {
  const hasCreatedAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt);
  const created = hasCreatedAt ? formatSessionAge(row.createdAt, true) : "";
  const age = hasCreatedAt ? formatSessionAge(row.createdAt, false) : "";
  const updated = formatSessionAge(row.updatedAt, true);
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
      ? html`<span class="session-hovercard__created-age" title=${created}>${age}</span>`
      : nothing}
  </header>`;
}

/**
 * Keeps the locale's own "with {name}" phrasing and list separators while making each
 * name its own link. A translation that lost its placeholder falls back to plain text
 * rather than dropping the names.
 */
function renderParticipantNames(
  participants: readonly SessionCreatedActor[],
  formattedNames: string,
  personActivity: PersonActivityRouting | undefined,
) {
  const [prefix, suffix] = t("sessionsView.withParticipant").split("{name}");
  if (suffix === undefined) {
    return t("sessionsView.withParticipant", { name: formattedNames });
  }
  const links = participants.map((participant) =>
    participant.id ? personActivityLink(participant.id, personActivity) : null,
  );
  const parts = new Intl.ListFormat(i18n.getLocale(), {
    style: "long",
    type: "unit",
  }).formatToParts(participants.map(participantLabel));
  const names: (TemplateResult | string)[] = [];
  let index = 0;
  for (const part of parts) {
    if (part.type === "literal") {
      names.push(part.value);
      continue;
    }
    names.push(
      renderPersonName(part.value, links[index] ?? null, "session-hovercard__participant-name"),
    );
    index += 1;
  }
  return html`${prefix}${names}${suffix}`;
}

function renderSessionContext({
  row,
  selfUserId,
  avatarAuth,
  personActivity,
}: SessionHovercardInput) {
  const creator = row?.createdActor;
  const creatorLabel = creator?.label?.trim() || creator?.id?.trim();
  const creatorInitials = creator ? sessionOwnerInitials(creator) : "";
  const avatarFallback = creatorInitials
    ? html`<span class="session-hovercard__creator-avatar-fallback" aria-hidden="true"
        >${creatorInitials}</span
      >`
    : nothing;
  const context = row?.workContext;
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
  const participantNames = visibleParticipants.map(participantLabel);
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
  const creatorId = creator?.id;
  const creatorActivity = creatorId ? personActivityLink(creatorId, personActivity) : null;
  const creatorAvatar = row?.channelAvatarUrl
    ? html`<openclaw-channel-avatar
        class="session-hovercard__creator-avatar"
        .routeUrl=${row.channelAvatarUrl}
        .authTokens=${avatarAuth?.authTokens ?? []}
        .authReady=${avatarAuth?.authReady ?? false}
        .fallback=${avatarFallback}
        aria-hidden="true"
      ></openclaw-channel-avatar>`
    : creatorId
      ? html`<openclaw-viewer-avatar
          class="session-hovercard__creator-avatar"
          .user=${{
            id: creatorId,
            name: creator?.label,
            avatarUrl: creator?.avatarUrl,
            watchedSessions: [],
          }}
          .markAsViewer=${false}
          variant="session"
          aria-hidden="true"
        ></openclaw-viewer-avatar>`
      : html`<span class="session-hovercard__context-icon" aria-hidden="true"
          >${icons.users}</span
        >`;
  return html`<div class="session-hovercard__context">
    ${creatorLabel || visibleParticipants.length > 0
      ? html`<div
          class="session-hovercard__context-row session-hovercard__identity-row"
          aria-label=${[creatorLabel, participantSummary].filter(Boolean).join(", ")}
        >
          ${renderPersonAvatarLink(creatorAvatar, creatorActivity)}
          <span class="session-hovercard__identity-copy">
            ${creatorLabel
              ? renderPersonName(creatorLabel, creatorActivity, "session-hovercard__identity-name")
              : nothing}
            ${creatorLabel && visibleParticipants.length > 0
              ? html`<span class="session-hovercard__identity-separator" aria-hidden="true"
                  >·</span
                >`
              : nothing}
            ${visibleParticipants.length > 0
              ? html`<span class="session-hovercard__participants">
                  <span class="session-hovercard__participant"
                    >${renderParticipantNames(
                      visibleParticipants,
                      formattedParticipantNames,
                      personActivity,
                    )}</span
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
            aria-label=${`${t(
              context.kind === "project"
                ? "sessionHovercard.projectLabel"
                : "sessionHovercard.workspaceLabel",
            )}: ${context.name}`}
            title=${`${t(
              context.kind === "project"
                ? "sessionHovercard.projectLabel"
                : "sessionHovercard.workspaceLabel",
            )}: ${context.path}`}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true">${icons.folder}</span>
            <span
              class="session-hovercard__context-value session-hovercard__context-text"
              title=${context.path}
              >${context.name}</span
            >
          </div>
          ${context.kind === "project" && context.branch
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

export function renderSessionHovercard(input: SessionHovercardInput) {
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
    input.row?.workContext ||
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
          ${renderSessionContext(input)}
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
