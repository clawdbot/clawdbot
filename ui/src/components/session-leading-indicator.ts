import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
} from "./session-attention-presentation.ts";
import { resolveSessionIcon } from "./session-icon-registry.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
) {
  const running = session.hasActiveRun || session.status === "running";
  const sessionState = renderSessionState(session);
  // Pinned rows keep their custom icon in the fixed leading slot and place
  // transient run/unread/terminal state at the row edge.
  const pinnedState =
    session.pinned && sessionState !== nothing
      ? html`<span class="nav-item__state">${sessionState}</span>`
      : nothing;

  if (session.attention.kind !== "none") {
    return {
      running,
      pinnedState,
      leadingIndicator: renderSessionAttentionIcon(session.attention),
    };
  }
  if (session.pinned) {
    return {
      running,
      pinnedState,
      leadingIndicator: html`<span class="sidebar-pinned-session__icon" aria-hidden="true"
        >${resolveSessionIcon(session.icon)}</span
      >`,
    };
  }
  if (!session.isChild && ownerActor?.id?.trim()) {
    const label =
      pullRequestState === "open"
        ? t("sessionsView.openPullRequest")
        : t("chat.pullRequests.merged");
    return {
      running,
      pinnedState,
      leadingIndicator: html`<span
        class="sidebar-session-avatar ${running ? "sidebar-session-avatar--running" : ""}"
      >
        ${renderSessionOwnerChip(ownerActor, "row", attribution)}
        ${running
          ? html`<span
              class="sidebar-session-avatar__running-ring"
              role="img"
              aria-label=${t("sessionsView.activeRun")}
              title=${t("sessionsView.activeRun")}
            ></span>`
          : nothing}
        ${session.unread
          ? html`<span
              class="sidebar-session-avatar__badge sidebar-session-avatar__badge--unread"
              role="img"
              aria-label=${t("sessionsView.unread")}
            ></span>`
          : pullRequestState !== "none"
            ? html`<span
                class="sidebar-session-avatar__badge sidebar-session-pr-indicator--${pullRequestState}"
                data-session-pr-state=${pullRequestState}
                role="img"
                aria-label=${label}
                title=${label}
              ></span>`
            : nothing}
      </span>`,
    };
  }
  if (running) {
    return { running, pinnedState, leadingIndicator: sessionState };
  }
  if (pullRequestState !== "none") {
    const label =
      pullRequestState === "open"
        ? t("sessionsView.openPullRequest")
        : t("chat.pullRequests.merged");
    return {
      running,
      pinnedState,
      leadingIndicator: html`<span
        class="sidebar-session-pr-indicator sidebar-session-pr-indicator--${pullRequestState}"
        data-session-pr-state=${pullRequestState}
        role="img"
        aria-label=${label}
        title=${label}
        >${icons.gitBranch}</span
      >`,
    };
  }
  return {
    running,
    pinnedState,
    leadingIndicator:
      sessionState !== nothing
        ? sessionState
        : html`<span class="sidebar-session-indicator__dot" aria-hidden="true"></span>`,
  };
}
