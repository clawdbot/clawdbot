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
import "./channel-avatar.ts";

type SessionAvatarAuth = {
  authTokens: readonly string[];
  authReady: boolean;
};

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
    >${pullRequestState === "open" ? icons.gitPullRequest : icons.gitMerge}</span
  >`;
}

function renderSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  const sessionState = renderSessionState(session, false);
  const concurrentUnreadState = session.hasActiveRun ? renderSessionUnreadState(session) : nothing;
  if (
    pullRequestState === "none" &&
    sessionState === nothing &&
    concurrentUnreadState === nothing
  ) {
    return nothing;
  }
  return html`${renderPullRequestIndicator(pullRequestState, false)} ${sessionState}
  ${concurrentUnreadState}`;
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
    session.hasActiveRun
      ? t(session.status === "queued" ? "sessionsView.statusQueued" : "sessionsView.activeRun")
      : "",
    session.unread ? t("sessionsView.unread") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "owned" | "archived",
  ownerViewing?: boolean,
  participants?: readonly SessionCreatedActor[],
  participantCount?: number,
  avatarAuth?: SessionAvatarAuth,
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
    if (session.channelAvatarUrl) {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: html`<openclaw-channel-avatar
            .routeUrl=${session.channelAvatarUrl}
            .authTokens=${avatarAuth?.authTokens ?? []}
            .authReady=${avatarAuth?.authReady ?? false}
          ></openclaw-channel-avatar>`,
          running,
          circular: true,
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
  const ownerChip =
    !session.isChild && ownerActor?.id?.trim()
      ? renderSessionOwnerChip(
          ownerActor,
          "row",
          attribution,
          ownerViewing,
          participants,
          participantCount,
        )
      : undefined;
  if (session.channelAvatarUrl) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        // The owner chip stays visible until a usable avatar blob loads, so a
        // slow, unauthenticated, or 404 route never leaves an empty lead slot.
        content: html`<openclaw-channel-avatar
          .routeUrl=${session.channelAvatarUrl}
          .authTokens=${avatarAuth?.authTokens ?? []}
          .authReady=${avatarAuth?.authReady ?? false}
          .fallback=${ownerChip ?? nothing}
        ></openclaw-channel-avatar>`,
        running: false,
        circular: true,
      }),
      trailingIndicator,
    };
  }
  if (ownerChip) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: ownerChip,
        running: false,
        circular: true,
      }),
      trailingIndicator,
      // Single source for facepile dedup: only the identity actually shown in
      // the lead may be excluded, else attention/archived rows hide a viewer.
      renderedOwnerId: ownerActor?.id,
    };
  }
  return {
    running,
    leadingIndicator: nothing,
    trailingIndicator,
  };
}
