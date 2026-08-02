import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
} from "./session-attention-presentation.ts";
import {
  renderSessionGlyph,
  renderSessionUnreadBadge,
  type SessionGlyphContent,
} from "./session-glyph.ts";
import { resolveSessionIcon } from "./session-icon-registry.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

function renderGlyphBadge(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
): SessionGlyphContent {
  if (session.unread) {
    return renderSessionUnreadBadge();
  }
  if (pullRequestState === "none") {
    return nothing;
  }
  const label =
    pullRequestState === "open" ? t("sessionsView.openPullRequest") : t("chat.pullRequests.merged");
  return html`<span
    class="session-glyph__badge sidebar-session-pr-indicator--${pullRequestState}"
    data-session-pr-state=${pullRequestState}
    role="img"
    aria-label=${label}
    title=${label}
  ></span>`;
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
) {
  const running = session.hasActiveRun;

  if (session.attention.kind !== "none") {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionAttentionIcon(session.attention),
        running,
        // Attention does not replace unread: a row waiting on the user can also
        // hold output the user has not seen.
        badge: renderGlyphBadge(session, pullRequestState),
      }),
    };
  }
  if (session.pinned) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: html`<span class="sidebar-pinned-session__icon" aria-hidden="true"
          >${resolveSessionIcon(session.icon)}</span
        >`,
        running,
        badge: renderGlyphBadge(session, pullRequestState),
      }),
    };
  }
  if (!session.isChild && ownerActor?.id?.trim()) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionOwnerChip(ownerActor, "row", attribution),
        running,
        circular: true,
        badge: renderGlyphBadge(session, pullRequestState),
      }),
    };
  }
  // No artwork to ring: the bare spinner already sits in the leading slot.
  if (running) {
    return { running, leadingIndicator: renderSessionState(session) };
  }
  if (pullRequestState !== "none") {
    const label =
      pullRequestState === "open"
        ? t("sessionsView.openPullRequest")
        : t("chat.pullRequests.merged");
    return {
      running,
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
  const sessionState = renderSessionState(session);
  return {
    running,
    leadingIndicator:
      sessionState !== nothing
        ? sessionState
        : html`<span class="sidebar-session-indicator__dot" aria-hidden="true"></span>`,
  };
}
