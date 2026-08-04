import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
} from "./session-attention-presentation.ts";
import { renderSessionGlyph } from "./session-glyph.ts";
import { resolveSessionIcon } from "./session-icon-registry.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

function renderPullRequestIndicator(pullRequestState: SessionPullRequestIndicatorState) {
  if (pullRequestState === "none") {
    return nothing;
  }
  const label =
    pullRequestState === "open" ? t("sessionsView.openPullRequest") : t("chat.pullRequests.merged");
  return html`<span
    class="sidebar-session-pr-indicator sidebar-session-pr-indicator--${pullRequestState}"
    data-session-pr-state=${pullRequestState}
    role="img"
    aria-label=${label}
    title=${label}
    >${icons.gitBranch}</span
  >`;
}

function renderSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  const sessionState = renderSessionState(session);
  if (!session.hasForkSource && pullRequestState === "none" && sessionState === nothing) {
    return nothing;
  }
  const forkLabel = t("sessionsView.forkSession");
  return html`
    ${session.hasForkSource
      ? html`<span
          class="session-row-fork-indicator"
          role="img"
          aria-label=${forkLabel}
          title=${forkLabel}
          >${icons.gitFork}</span
        >`
      : nothing}
    ${renderPullRequestIndicator(pullRequestState)} ${sessionState}
  `;
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
) {
  const running = session.hasActiveRun;
  const trailingIndicator = session.isChild
    ? nothing
    : renderSessionTrailingState(session, pullRequestState);

  if (session.attention.kind !== "none") {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionAttentionIcon(session.attention),
        running: false,
      }),
      trailingIndicator,
    };
  }
  if (session.pinned) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: html`<span class="sidebar-pinned-session__icon" aria-hidden="true"
          >${resolveSessionIcon(session.icon)}</span
        >`,
        running: false,
      }),
      trailingIndicator,
    };
  }
  if (!session.isChild && ownerActor?.id?.trim()) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionOwnerChip(ownerActor, "row", attribution),
        running: false,
        circular: true,
      }),
      trailingIndicator,
    };
  }
  if (session.isChild) {
    return {
      running,
      leadingIndicator: renderSessionState(session),
      trailingIndicator: nothing,
    };
  }
  return {
    running,
    leadingIndicator: nothing,
    trailingIndicator,
  };
}
