import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { readPresenceEntries } from "../app/user-profile.ts";
import {
  presenceViewerLabel,
  projectPresenceEntries,
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

function normalized(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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
  // Presence selectors use this marker; owner and menu chrome must opt out.
  @property({ type: Boolean, attribute: false }) markAsViewer = true;

  override render() {
    const user = this.user;
    if (!user) {
      return nothing;
    }
    const label = presenceViewerLabel(user);
    const view = resolveIdentityAvatarView({
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
  @property({ attribute: false }) selfUserId?: string;
  @property({ attribute: false }) selfInstanceId?: string;
  @property({ attribute: false }) sessionKey?: string;
  @property({ attribute: false }) excludeUserId?: string;
  @property({ attribute: false }) staticUsers?: readonly PresenceViewer[];
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  /**
   * Opt-in: linking each face to its Activity feed. Facepiles rendered inside an existing
   * anchor or button (sidebar rows, collapsed group headers) must leave this unset — a
   * nested interactive element would break the parent's click target.
   */
  @property({ attribute: false }) personActivity?: PersonActivityRouting;

  override render() {
    const projection = projectPresenceEntries(
      readPresenceEntries(this.presencePayload) ?? [],
      this.selfUserId,
      this.selfInstanceId,
    );
    const sessionKey = this.sessionKey;
    const excludeUserId = normalized(this.excludeUserId);
    const users = this.staticUsers
      ? [...this.staticUsers]
      : sessionKey
        ? projection.users.filter(
            (user) =>
              user.id !== projection.selfUserId &&
              user.id !== excludeUserId &&
              user.watchedSessions.includes(sessionKey),
          )
        : projection.users.filter((user) => user.id !== projection.selfUserId);
    if (users.length === 0) {
      return nothing;
    }
    const visible = users.slice(0, this.maxVisible);
    const overflow = users.slice(this.maxVisible);
    return html`<span
      class="viewer-facepile viewer-facepile--session"
      data-viewer-count=${users.length}
      aria-label=${users.map(presenceViewerLabel).join(", ")}
    >
      ${visible.map(
        (user) => html`<openclaw-tooltip .content=${presenceViewerLabel(user)}>
          <span class="viewer-facepile__tooltip-anchor">
            ${renderStandalonePersonLink(
              html`<openclaw-viewer-avatar
                .user=${user}
                variant="session"
              ></openclaw-viewer-avatar>`,
              personActivityLink(user.id, this.personActivity),
            )}
          </span>
        </openclaw-tooltip>`,
      )}
      ${overflow.length > 0
        ? html`<openclaw-tooltip .content=${overflow.map(presenceViewerLabel).join("\n")}>
            <span
              class="viewer-avatar viewer-avatar--overflow"
              aria-label=${overflow.map(presenceViewerLabel).join(", ")}
              >+${overflow.length}</span
            >
          </openclaw-tooltip>`
        : nothing}
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
