import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { PresenceEntry } from "../api/types.ts";
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
import "./tooltip.ts";

function readPresenceEntries(value: unknown): PresenceEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const presence = (value as { presence?: unknown }).presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : [];
}

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

export type ViewerAvatarVariant = "session" | "footer" | "profile" | "tooltip";

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
  @property({ attribute: false }) staticTooltips?: readonly string[];
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;

  override render() {
    const projection = projectPresenceEntries(
      readPresenceEntries(this.presencePayload),
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
    const tooltipLabel = (user: PresenceViewer, index: number) =>
      this.staticTooltips?.[index] ?? presenceViewerLabel(user);
    return html`<span
      class="viewer-facepile viewer-facepile--session"
      data-viewer-count=${users.length}
      aria-label=${users.map(presenceViewerLabel).join(", ")}
    >
      ${visible.map(
        (user, index) => html`<openclaw-tooltip .content=${tooltipLabel(user, index)}>
          <span class="viewer-facepile__tooltip-anchor">
            <openclaw-viewer-avatar .user=${user} variant="session"></openclaw-viewer-avatar>
          </span>
        </openclaw-tooltip>`,
      )}
      ${overflow.length > 0
        ? html`<openclaw-tooltip class="viewer-facepile__overflow-tooltip-owner">
            <span
              class="viewer-avatar viewer-avatar--overflow"
              aria-label=${overflow
                .map((user, index) => tooltipLabel(user, this.maxVisible + index))
                .join(", ")}
              >+${overflow.length}</span
            >
            <span slot="content" class="viewer-facepile__overflow-tooltip">
              ${overflow.map(
                (user, index) => html`<span class="viewer-facepile__overflow-tooltip-row">
                  <openclaw-viewer-avatar
                    .user=${user}
                    .markAsViewer=${false}
                    variant="tooltip"
                  ></openclaw-viewer-avatar>
                  <span class="viewer-facepile__overflow-tooltip-label"
                    >${tooltipLabel(user, this.maxVisible + index)}</span
                  >
                </span>`,
              )}
            </span>
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
