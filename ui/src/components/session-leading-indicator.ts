import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
  renderSessionUnreadState,
} from "./session-attention-presentation.ts";
import {
  renderSessionGlyph,
  renderSessionUnreadBadge,
  type SessionGlyphContent,
} from "./session-glyph.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";
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

function pullRequestStateLabel(
  pullRequestState: Exclude<SessionPullRequestIndicatorState, "none">,
) {
  return pullRequestState === "open"
    ? t("sessionsView.openPullRequest")
    : t("chat.pullRequests.merged");
}

function renderPullRequestIndicator(
  pullRequestState: SessionPullRequestIndicatorState,
  showTitle = true,
) {
  if (pullRequestState === "none") {
    return nothing;
  }
  const label = pullRequestStateLabel(pullRequestState);
  return html`<span
    class="sidebar-session-pr-indicator sidebar-session-pr-indicator--${pullRequestState}"
    data-session-pr-state=${pullRequestState}
    role="img"
    aria-label=${label}
    title=${showTitle ? label : nothing}
    >${icons.gitBranch}</span
  >`;
}

function renderSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  const sessionState = renderSessionState(session, false);
  const concurrentUnreadState = session.hasActiveRun ? renderSessionUnreadState(session) : nothing;
  if (
    !session.forkSource &&
    pullRequestState === "none" &&
    sessionState === nothing &&
    concurrentUnreadState === nothing
  ) {
    return nothing;
  }
  const forkLabel = t("sessionsView.forkedSession");
  return html`
    ${session.forkSource
      ? html`<span class="session-row-fork-indicator" role="img" aria-label=${forkLabel}
          >${icons.gitFork}</span
        >`
      : nothing}
    ${renderPullRequestIndicator(pullRequestState, false)} ${sessionState} ${concurrentUnreadState}
  `;
}

function renderPersistentSessionIcon(icon: string) {
  const glyph = resolveSessionIconGlyph(icon);
  return glyph
    ? html`<span class="session-glyph__icon" aria-hidden="true">${glyph}</span>`
    : html`<span class="session-glyph__emoji" aria-hidden="true">${icon}</span>`;
}

export function describeSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  return [
    session.forkSource ? t("sessionsView.forkedSession") : "",
    pullRequestState === "none" ? "" : pullRequestStateLabel(pullRequestState),
    session.hasActiveRun ? t("sessionsView.activeRun") : "",
    session.unread ? t("sessionsView.unread") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
  ownerViewing?: boolean,
): {
  running: boolean;
  leadingIndicator: TemplateResult | typeof nothing;
  trailingIndicator: TemplateResult | typeof nothing;
  renderedOwnerId?: string;
} {
  const running = session.hasActiveRun;
  const trailingIndicator = session.isChild
    ? nothing
    : renderSessionTrailingState(session, pullRequestState);
  // Transient attention always outranks the persistent decorative icon.
  if (session.isChild) {
    if (session.attention.kind !== "none") {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: renderSessionAttentionIcon(session.attention),
          running,
          badge: renderGlyphBadge(session, pullRequestState),
        }),
        trailingIndicator,
      };
    }
    if (session.icon) {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: renderPersistentSessionIcon(session.icon),
          running,
          badge: renderGlyphBadge(session, pullRequestState),
        }),
        trailingIndicator,
      };
    }
    if (running) {
      return {
        running,
        leadingIndicator: renderSessionState(session),
        trailingIndicator,
      };
    }
    if (pullRequestState !== "none") {
      return {
        running,
        leadingIndicator: renderPullRequestIndicator(pullRequestState),
        trailingIndicator,
      };
    }
    const sessionState = renderSessionState(session);
    return {
      running,
      leadingIndicator: sessionState,
      trailingIndicator,
    };
  }

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
  if (session.icon) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderPersistentSessionIcon(session.icon),
        running: false,
      }),
      trailingIndicator,
    };
  }
  if (!session.isChild && ownerActor?.id?.trim()) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionOwnerChip(ownerActor, "row", attribution, ownerViewing),
        running: false,
        circular: true,
      }),
      trailingIndicator,
      // Single source for facepile dedup: only the identity actually shown in
      // the lead may be excluded, else attention/archived rows hide a viewer.
      renderedOwnerId: ownerActor.id,
    };
  }
  return {
    running,
    leadingIndicator: nothing,
    trailingIndicator,
  };
}
