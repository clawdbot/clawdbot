import { html, nothing, type TemplateResult } from "lit";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
  sessionHasRunningWork,
} from "./session-attention-presentation.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

type SessionAvatarAuth = {
  authTokens: readonly string[];
  authReady: boolean;
};

// Channel avatars stay out of the startup bundle (startup-JS budget): the
// element registers on the first avatar row, and the owner-chip fallback
// keeps the lead slot occupied through the one-time upgrade window.
let channelAvatarElementLoad: Promise<unknown> | undefined;
function ensureChannelAvatarElement(): void {
  channelAvatarElementLoad ??= import("./channel-avatar.ts");
}

function renderPersistentSessionIcon(icon: string) {
  const glyph = resolveSessionIconGlyph(icon);
  return glyph
    ? html`<span class="session-glyph__icon" aria-hidden="true">${glyph}</span>`
    : html`<span class="session-glyph__emoji" aria-hidden="true">${icon}</span>`;
}

export function describeSessionTrailingState(session: SidebarRecentSession) {
  const runningLabel =
    session.hasActiveRun && session.status === "queued"
      ? t("sessionsView.statusQueued")
      : t("sessionsView.activeRun");
  return [
    session.forkSource ? t("sessionsView.forkedSession") : "",
    sessionHasRunningWork(session) ? runningLabel : "",
    session.unread ? t("sessionsView.unread") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "owned" | "archived",
  ownerViewing?: boolean,
  participants?: readonly SessionParticipant[],
  participantCount?: number,
  avatarAuth?: SessionAvatarAuth,
): {
  running: boolean;
  leadingIndicator: TemplateResult | typeof nothing;
  trailingIndicator: TemplateResult | typeof nothing;
  renderedOwnerId?: string;
} {
  const running = sessionHasRunningWork(session);
  const trailingIndicator = session.isChild ? nothing : renderSessionState(session, false);
  // Transient attention always outranks the persistent decorative icon.
  if (session.isChild) {
    if (session.attention.kind !== "none") {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: renderSessionAttentionIcon(session.attention),
          running,
          badge: session.unread && !session.hasActiveRun ? renderSessionUnreadBadge() : nothing,
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
          badge: session.unread && !session.hasActiveRun ? renderSessionUnreadBadge() : nothing,
        }),
        trailingIndicator,
      };
    }
    if (session.channelAvatarUrl) {
      ensureChannelAvatarElement();
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
          badge: session.unread && !session.hasActiveRun ? renderSessionUnreadBadge() : nothing,
        }),
        trailingIndicator,
      };
    }
    return {
      running,
      leadingIndicator: renderSessionState(session),
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
    ensureChannelAvatarElement();
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
