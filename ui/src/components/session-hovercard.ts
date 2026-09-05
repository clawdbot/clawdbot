import type { ProgressCard } from "@openclaw/gateway-protocol";
import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
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
import { renderSessionColorDot } from "./session-color.ts";
import { sessionOwnerInitials, type SessionCreatedActor } from "./session-owner-chip.ts";
import { progressCardHeadsUp, renderProgressCardMarkdown } from "./session-progress-card.ts";
import "./session-hovercard.css";
import "./tooltip.ts";
import "./viewer-facepile.ts";

// Preserve the pre-dropdown facepile footprint; further identities remain linked in the menu.
const MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS = 4;

function participantLabel(participant: SessionParticipant): string {
  return participant.label?.trim() || participant.identity.id;
}

function excludesParticipant(
  participant: SessionParticipant,
  creator: SessionCreatedActor | undefined,
  selfUserId: string | undefined,
): boolean {
  return (
    (participant.identity.type === "profile" && participant.identity.id === selfUserId) ||
    JSON.stringify(participant.identity) === JSON.stringify(creator?.identity)
  );
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
  progressCardError?: string;
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

function renderDiffStats(item: { additions?: number; deletions?: number }) {
  if (item.additions === undefined && item.deletions === undefined) {
    return nothing;
  }
  return html`<span class="session-hovercard__diff">
    ${
      item.additions === undefined
        ? nothing
        : html`<span class="session-hovercard__additions"
            >+${item.additions.toLocaleString()}</span
          >`
    }
    ${
      item.deletions === undefined
        ? nothing
        : html`<span class="session-hovercard__deletions"
            >−${item.deletions.toLocaleString()}</span
          >`
    }
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
      second: "s",
      minute: "m",
      hour: "h",
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

type SessionAttribution = {
  creator?: SessionCreatedActor;
  primaryIdentity: SessionParticipant["identity"] | undefined;
  primaryLabel: string;
  participants: SessionParticipant[];
  otherCount: number;
};

function sessionAttribution(
  row: SidebarSessionHovercardRow,
  selfUserId: string | undefined,
): SessionAttribution | undefined {
  const creator = row.createdActor;
  const creatorLabel = creator?.label?.trim() || creator?.id?.trim();
  const participantIds = new Set<string>();
  let excludedProjectedCount = 0;
  const participants = (row.expandedParticipants ?? row.participants ?? []).filter(
    (participant) => {
      const id = JSON.stringify(participant.identity);
      if (participantIds.has(id)) {
        return false;
      }
      participantIds.add(id);
      if (excludesParticipant(participant, creator, selfUserId)) {
        excludedProjectedCount += 1;
        return false;
      }
      return true;
    },
  );
  const participantCount = Math.max(
    participants.length,
    (row.participantCount ?? 0) - excludedProjectedCount,
  );
  if (creator && creatorLabel) {
    return {
      creator,
      primaryIdentity: creator.identity,
      primaryLabel: creatorLabel,
      participants,
      otherCount: participantCount,
    };
  }
  const primary = participants[0];
  if (!primary) {
    return undefined;
  }
  return {
    primaryIdentity: primary.identity,
    primaryLabel: participantLabel(primary),
    participants,
    otherCount: Math.max(0, participantCount - 1),
  };
}

function renderParticipantMenu(
  participants: readonly SessionParticipant[],
  participantCount: number,
  personActivity: PersonActivityRouting | undefined,
) {
  const unresolvedCount = Math.max(0, participantCount - participants.length);
  return html`<div
    slot="content"
    class="session-hovercard__participant-menu"
    role="list"
    style="min-width: 150px; max-height: min(280px, 60vh); overflow-y: auto;"
    aria-label=${t("sessionHovercard.moreParticipantsLabel", {
      count: String(participantCount),
    })}
  >
    ${participants.map((participant) => {
      const label = participantLabel(participant);
      const activity =
        participant.identity.type === "profile"
          ? personActivityLink(participant.identity.id, personActivity, label)
          : null;
      return html`<div role="listitem">
        ${renderPersonName(
          label,
          activity,
          "session-menu__item learn-more-link session-hovercard__participant-link",
        )}
      </div>`;
    })}
    ${
      unresolvedCount > 0
        ? html`<div class="session-hovercard__more" role="listitem">
            ${t("sessionHovercard.moreParticipantsLabel", { count: String(unresolvedCount) })}
          </div>`
        : nothing
    }
  </div>`;
}

function renderSessionAttribution({
  row,
  selfUserId,
  avatarAuth,
  personActivity,
}: SessionHovercardInput) {
  if (!row) {
    return nothing;
  }
  const attribution = sessionAttribution(row, selfUserId);
  if (!attribution) {
    return nothing;
  }
  const { creator, primaryIdentity, primaryLabel, participants, otherCount } = attribution;
  const primaryParticipant = creator ? undefined : participants[0];
  const primaryActivity =
    primaryIdentity?.type === "profile"
      ? personActivityLink(primaryIdentity.id, personActivity, primaryLabel)
      : null;
  const creatorInitials = creator ? sessionOwnerInitials(creator) : "";
  const avatarFallback = creatorInitials
    ? html`<span class="session-hovercard__creator-avatar-fallback" aria-hidden="true"
        >${creatorInitials}</span
      >`
    : nothing;
  if (creator && row.channelAvatarUrl) {
    ensureChannelAvatarElement();
  }
  const primaryAvatar = creator
    ? row.channelAvatarUrl
      ? html`<openclaw-channel-avatar
          class="session-hovercard__creator-avatar"
          .routeUrl=${row.channelAvatarUrl}
          .authTokens=${avatarAuth?.authTokens ?? []}
          .authReady=${avatarAuth?.authReady ?? false}
          .fallback=${avatarFallback}
          aria-hidden="true"
        ></openclaw-channel-avatar>`
      : html`<openclaw-viewer-avatar
          class="session-hovercard__creator-avatar"
          .user=${{
            id: creator.id,
            name: creator.label,
            avatarUrl: creator.avatarUrl,
            watchedSessions: [],
          }}
          .markAsViewer=${false}
          .identity=${creator.identity}
          variant="session"
          aria-hidden="true"
        ></openclaw-viewer-avatar>`
    : primaryParticipant
      ? html`<openclaw-viewer-avatar
          class="session-hovercard__creator-avatar"
          .user=${{
            id: primaryParticipant.identity.id,
            name: primaryParticipant.label,
            avatarUrl: primaryParticipant.avatarUrl,
            watchedSessions: [],
          }}
          .markAsViewer=${false}
          .identity=${primaryParticipant.identity}
          variant="session"
          aria-hidden="true"
        ></openclaw-viewer-avatar>`
      : nothing;
  const remainingParticipants = creator ? participants : participants.slice(1);
  const attributionLabel = [
    primaryLabel,
    otherCount > 0
      ? t("sessionHovercard.moreParticipantsLabel", { count: String(otherCount) })
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const otherLabel =
    otherCount > 0
      ? t(
          otherCount === 1
            ? "sessionHovercard.attributionOther"
            : "sessionHovercard.attributionOthers",
          { count: String(otherCount) },
        )
      : "";
  return html`<div class="session-hovercard__attribution" aria-label=${attributionLabel}>
    <span class="session-hovercard__attribution-copy">
      ${renderPersonName(primaryLabel, primaryActivity, "session-hovercard__attribution-name")}
      ${
        otherCount > 0
          ? remainingParticipants.length > 0
            ? html`<openclaw-tooltip
                class="session-hovercard__participants-tooltip"
                .describe=${false}
                open-on-click
              >
                <button
                  type="button"
                  class="session-hovercard__attribution-others"
                  style="padding: 1px 3px; border: 0; border-radius: var(--radius-sm); background: transparent; font: inherit;"
                  aria-label=${t("sessionHovercard.moreParticipantsLabel", {
                    count: String(otherCount),
                  })}
                >
                  ${otherLabel}
                </button>
                ${renderParticipantMenu(remainingParticipants, otherCount, personActivity)}
              </openclaw-tooltip>`
            : html`<span class="session-hovercard__attribution-others">${otherLabel}</span>`
          : nothing
      }
    </span>
    <span class="session-hovercard__attribution-avatars">
      ${renderPersonAvatarLink(primaryAvatar, primaryActivity)}
      ${
        remainingParticipants.length > 0
          ? html`<openclaw-viewer-facepile
              .staticParticipants=${remainingParticipants}
              .totalCount=${otherCount}
              .maxVisible=${Math.min(
                remainingParticipants.length,
                MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS,
              )}
              .personActivity=${personActivity}
            ></openclaw-viewer-facepile>`
          : nothing
      }
    </span>
  </div>`;
}

function renderHeader(input: SessionHovercardInput) {
  const row = input.row!;
  const hasCreatedAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt);
  const created = hasCreatedAt ? formatSessionAge(row.createdAt, true) : "";
  const age = hasCreatedAt ? formatSessionAge(row.createdAt, false) : "";
  return html`<header class="session-hovercard__header">
    <span class="session-hovercard__heading">
      <span class="session-hovercard__title">${renderSessionColorDot(row.color)}${row.label}</span>
      ${renderSessionAttribution(input)}
    </span>
    ${
      age
        ? html`<span class="session-hovercard__created-age" title=${created}>${age}</span>`
        : nothing
    }
  </header>`;
}

function renderProgressHeadsUp(
  card: ProgressCard | null | undefined,
  sessionStatus: SidebarSessionHovercardRow["status"],
  startedAt: SidebarSessionHovercardRow["startedAt"],
) {
  const headsUp = progressCardHeadsUp(card, sessionStatus, startedAt);
  if (!headsUp) {
    return nothing;
  }
  const statusLabel = t(
    headsUp.status === "in_progress"
      ? "sessionProgressCard.status.inProgress"
      : headsUp.status === "paused"
        ? "sessionProgressCard.status.paused"
        : "sessionProgressCard.status.pending",
  );
  return html`<div
    class="session-hovercard__context-row session-hovercard__plan-row"
    aria-label=${t("sessionProgressCard.stepLabel", {
      status: statusLabel,
      step: headsUp.step,
    })}
    title=${headsUp.step}
  >
    <span class="session-hovercard__context-icon" aria-hidden="true"
      >${
        headsUp.status === "in_progress"
          ? html`<span class="session-run-spinner"></span>`
          : icons.clock
      }</span
    >
    <span class="session-hovercard__context-value session-hovercard__plan-step"
      >${headsUp.step}</span
    >
    <span class="session-hovercard__plan-count">${headsUp.completed}/${headsUp.total}</span>
  </div>`;
}

function renderSessionContext({ row, progressCard }: SessionHovercardInput) {
  const context = row?.workContext;
  const placementIdentity =
    row?.placementProviderId && row.placementProfileId
      ? {
          label: `${row.placementProviderId} · ${row.placementProfileId}`,
          title: t("sessionHovercard.runsOn", {
            providerId: row.placementProviderId,
            profileId: row.placementProfileId,
          }),
        }
      : undefined;
  if (
    !context &&
    !placementIdentity &&
    row?.boardFace !== "dashboard" &&
    row?.hasAutomation !== true &&
    !progressCardHeadsUp(progressCard, row?.status, row?.startedAt)
  ) {
    return nothing;
  }
  return html`<div class="session-hovercard__context">
    ${
      context
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
          </div>`
        : nothing
    }
    ${
      placementIdentity
        ? html`<div
            class="session-hovercard__context-row"
            aria-label=${placementIdentity.title}
            title=${placementIdentity.title}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true">${icons.server}</span>
            <span class="session-hovercard__context-value session-hovercard__context-text"
              >${placementIdentity.label}</span
            >
          </div>`
        : nothing
    }
    ${
      row?.boardFace === "dashboard"
        ? html`<div
            class="session-hovercard__context-row"
            aria-label=${t("sessionsView.opensAsDashboard")}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true"
              >${icons.layoutDashboard}</span
            >
            <span class="session-hovercard__context-value session-hovercard__context-text"
              >${t("sessionsView.opensAsDashboard")}</span
            >
          </div>`
        : nothing
    }
    ${
      row?.hasAutomation === true
        ? html`<div
            class="session-hovercard__context-row"
            aria-label=${t("sessionsView.automationAttached")}
          >
            <span class="session-hovercard__context-icon" aria-hidden="true">${icons.clock}</span>
            <span class="session-hovercard__context-value session-hovercard__context-text"
              >${t("sessionsView.automationAttached")}</span
            >
          </div>`
        : nothing
    }
    ${renderProgressHeadsUp(progressCard, row?.status, row?.startedAt)}
  </div>`;
}

function renderAgentNotepad(card: ProgressCard | null | undefined) {
  if (!card?.markdown?.trim()) {
    return nothing;
  }
  return html`<section
    class="session-hovercard__section session-hovercard__notepad"
    aria-label=${t("sessionHovercard.agentNotepad")}
  >
    <div class="session-hovercard__notepad-title">${t("sessionHovercard.agentNotepad")}</div>
    ${renderProgressCardMarkdown(card.markdown, { promoteProgress: true })}
  </section>`;
}

function renderPullRequestRow(pullRequest: ControlUiSessionPullRequest) {
  const state = pullRequestStateLabel(pullRequest.state);
  const checks = pullRequest.checks ? checksLabel(pullRequest.checks) : null;
  const details = [
    pullRequest.title,
    checks,
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
    <span class="session-hovercard__pr-title">${pullRequest.title}</span>
    ${renderDiffStats(pullRequest)}
  </a>`;
}

function renderPullRequestDetails(snapshot: ControlUiSessionPullRequestSnapshot | undefined) {
  if (!snapshot) {
    return nothing;
  }
  if (snapshot.pullRequests.length > 0) {
    const visible = snapshot.pullRequests.slice(0, 1);
    const hiddenCount = snapshot.pullRequests.length - visible.length;
    return html`<div class="session-hovercard__pr-list">
      ${visible.map(renderPullRequestRow)}
      ${
        hiddenCount > 0
          ? html`<span class="session-hovercard__more"
              >${t("sessionHovercard.more", { count: String(hiddenCount) })}</span
            >`
          : nothing
      }
    </div>`;
  }
  const branch = snapshot.branch;
  if (!branch) {
    return nothing;
  }
  const createPullRequest = t("chat.pullRequests.createPr");
  const createPullRequestLabel = t("chat.pullRequests.createPrLabel", {
    branch: branch.branch,
  });
  return html`<div class="session-hovercard__branch-row">
    <span class="session-hovercard__branch-icon" aria-hidden="true">${icons.gitBranch}</span>
    ${
      branch.createUrl
        ? html`<a
            class="session-hovercard__branch-action"
            href=${branch.createUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${createPullRequestLabel}
            title=${createPullRequestLabel}
            >${createPullRequest}</a
          >`
        : html`<span class="session-hovercard__branch-label">${t("chat.sessionDiff.title")}</span>`
    }
    ${renderDiffStats(branch)}
  </div>`;
}

export function renderSessionHovercard(input: SessionHovercardInput) {
  const hasPullRequestDetails = Boolean(
    input.pullRequests && (input.pullRequests.pullRequests.length > 0 || input.pullRequests.branch),
  );
  const hasContext = Boolean(
    input.row?.workContext ||
    (input.row?.placementProviderId && input.row.placementProfileId) ||
    input.row?.boardFace === "dashboard" ||
    input.row?.hasAutomation === true ||
    progressCardHeadsUp(input.progressCard, input.row?.status, input.row?.startedAt),
  );
  const lastMessagePreview = input.progressCard
    ? undefined
    : input.row?.lastMessagePreview?.trim() || undefined;
  if (!input.row && !hasPullRequestDetails && !input.progressCard && !input.progressCardError) {
    return nothing;
  }
  return html`<div class="session-hovercard">
    ${
      input.row
        ? html`<section class="session-hovercard__section session-hovercard__section--header">
            ${renderHeader(input)}
          </section>`
        : nothing
    }
    ${
      hasContext
        ? html`<section class="session-hovercard__section session-hovercard__section--metadata">
            ${renderSessionContext(input)}
          </section>`
        : nothing
    }
    ${
      hasPullRequestDetails
        ? html`<section class="session-hovercard__section session-hovercard__section--prs">
            ${renderPullRequestDetails(input.pullRequests)}
          </section>`
        : nothing
    }
    ${
      lastMessagePreview
        ? html`<section class="session-hovercard__section session-hovercard__section--optional">
            <div class="session-hovercard__excerpt">${lastMessagePreview}</div>
          </section>`
        : nothing
    }
    ${renderAgentNotepad(input.progressCard)}
    ${input.progressCardError ? html`<section class="session-hovercard__section" role="status">${input.progressCardError}</section>` : nothing}
  </div>`;
}
