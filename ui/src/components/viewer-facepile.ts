import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import {
  presenceViewerLabel,
  projectPresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "./identity-avatar-view.ts";
import {
  personActivityLink,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "./person-activity-link.ts";
import "./tooltip.ts";

function renderViewerAvatar(view: IdentityAvatarView) {
  const fallback = html`<span
    class=${view.imageUrl ? "viewer-avatar__fallback" : nothing}
    style=${`background: hsl(${view.fallback.colorSeed % 360} 48% 42%)`}
    >${view.fallback.initials}</span
  >`;
  if (!view.imageUrl) {
    return fallback;
  }
  return html`${renderIdentityAvatarImage({ view, fallbackSelector: ".viewer-avatar" })}${fallback}`;
}

type ViewerAvatarVariant = "session" | "footer" | "profile";

class ViewerAvatar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) user: PresenceViewer | null = null;
  @property() variant: ViewerAvatarVariant = "session";
  @property({ attribute: false }) identity?: SessionParticipantIdentity;
  // Presence selectors use this marker; owner and menu chrome must opt out.
  @property({ type: Boolean, attribute: false }) markAsViewer = true;

  override render() {
    const user = this.user;
    if (!user) {
      return nothing;
    }
    const label = presenceViewerLabel(user);
    const view = resolveIdentityAvatarView({
      identity: this.identity ?? user.identity,
      id: user.id,
      name: user.name,
      username: user.email,
      profileAvatarUrl: user.avatarUrl,
    });
    return html`<span
      class=${identityAvatarClass(`viewer-avatar viewer-avatar--${this.variant}`, view)}
      data-viewer-id=${this.markAsViewer ? user.id : nothing}
      aria-label=${label}
    >
      ${renderViewerAvatar(view)}
    </span>`;
  }
}

class ViewerFacepile extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) presencePayload: unknown;
  @property({ attribute: false }) selfUser?: AuthenticatedUser | null;
  @property({ attribute: false }) selfInstanceId?: string;
  @property({ attribute: false }) sessionKey?: string;
  @property({ attribute: false }) excludeIdentities: readonly SessionParticipantIdentity[] = [];
  @property({ attribute: false }) staticParticipants?: readonly SessionParticipant[];
  /** Prepared live presence for the collapsed Online section. */
  @property({ attribute: false }) staticUsers?: readonly PresenceViewer[];
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  @property({ type: Number, attribute: false }) totalCount?: number;
  /**
   * Opt-in: linking each face to its Activity feed. Facepiles rendered inside an existing
   * anchor or button (sidebar rows, collapsed group headers) must leave this unset — a
   * nested interactive element would break the parent's click target.
   */
  @property({ attribute: false }) personActivity?: PersonActivityRouting;

  override render() {
    // Prepared faces must not evict the cached live projection used by sibling rows.
    const users = this.staticParticipants
      ? this.staticParticipants.map(({ identity, label, avatarUrl }) => ({
          identity,
          id: identity.id,
          name: label,
          avatarUrl,
          watchedSessions: [],
        }))
      : (this.staticUsers ??
        projectPresenceViewers(
          this.presencePayload,
          this.selfUser,
          this.selfInstanceId,
          this.sessionKey,
          this.excludeIdentities,
        ));
    if (users.length === 0) {
      return nothing;
    }
    const visible = users.slice(0, this.maxVisible);
    const overflow = users.slice(this.maxVisible);
    const overflowCount = Math.max(users.length, this.totalCount ?? 0) - visible.length;
    const overflowLabel =
      overflow.length === overflowCount
        ? overflow.map(presenceViewerLabel).join("\n")
        : t("sessionHovercard.moreParticipantsLabel", { count: String(overflowCount) });
    return html`<span
      class="viewer-facepile viewer-facepile--session"
      data-viewer-count=${Math.max(users.length, this.totalCount ?? 0)}
      aria-label=${users.map(presenceViewerLabel).join(", ")}
    >
      ${visible.map(
        (user) => html`<openclaw-tooltip .content=${presenceViewerLabel(user)}>
          <span class="viewer-facepile__tooltip-anchor">
            ${renderStandalonePersonLink(
              html`<openclaw-viewer-avatar
                .user=${user}
                .identity=${user.identity}
                .markAsViewer=${!this.staticParticipants}
                variant="session"
              ></openclaw-viewer-avatar>`,
              user.identity?.type === "profile"
                ? personActivityLink(user.identity.id, this.personActivity, user.name)
                : null,
            )}
          </span>
        </openclaw-tooltip>`,
      )}
      ${
        overflowCount > 0
          ? html`<openclaw-tooltip .content=${overflowLabel}>
              <span class="viewer-avatar viewer-avatar--overflow" aria-label=${overflowLabel}
                >+${overflowCount}</span
              >
            </openclaw-tooltip>`
          : nothing
      }
    </span>`;
  }
}

if (globalThis.customElements) {
  if (!customElements.get("openclaw-viewer-avatar")) {
    customElements.define("openclaw-viewer-avatar", ViewerAvatar);
  }
  if (!customElements.get("openclaw-viewer-facepile")) {
    customElements.define("openclaw-viewer-facepile", ViewerFacepile);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-viewer-avatar": ViewerAvatar;
    "openclaw-viewer-facepile": ViewerFacepile;
  }
}
