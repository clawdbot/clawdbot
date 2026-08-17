import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { PresenceEntry } from "../api/types.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "./identity-avatar-view.ts";
import { renderSidebarServerDetails } from "./sidebar-build-chip-format.ts";
import "./tooltip.ts";

export type PresenceViewer = {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  watchedSessions: readonly string[];
};

function normalized(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstSorted(values: Iterable<string | null | undefined>): string | undefined {
  return [...values]
    .map(normalized)
    .filter((value): value is string => value !== undefined)
    .toSorted()[0];
}

function readPresenceEntries(value: unknown): PresenceEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const presence = (value as { presence?: unknown }).presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : [];
}

function projectPresenceViewers(
  entries: readonly PresenceEntry[],
  authenticatedSelfUserId?: string,
  selfInstanceId?: string,
): { users: readonly PresenceViewer[]; selfUserId?: string } {
  const grouped = new Map<string, PresenceEntry[]>();
  let selfUserId = normalized(authenticatedSelfUserId);
  for (const entry of entries) {
    if (entry.reason === "disconnect" || !entry.user?.id) {
      continue;
    }
    const userId = entry.user.id;
    const existing = grouped.get(userId);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(userId, [entry]);
    }
    if (!selfUserId && selfInstanceId && entry.instanceId === selfInstanceId) {
      selfUserId = userId;
    }
  }
  return {
    selfUserId,
    users: [...grouped.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, userEntries]) => ({
        id,
        name: firstSorted(userEntries.map((entry) => entry.user?.name)),
        email: firstSorted(userEntries.map((entry) => entry.user?.email)),
        avatarUrl: firstSorted(userEntries.map((entry) => entry.user?.avatarUrl)),
        watchedSessions: [
          ...new Set(userEntries.flatMap((entry) => entry.watchedSessions ?? [])),
        ].toSorted(),
      })),
  };
}

let cachedPresencePayload: unknown;
let cachedAuthenticatedSelfUserId: string | undefined;
let cachedSelfInstanceId: string | undefined;
let cachedPresenceProjection: ReturnType<typeof projectPresenceViewers> | undefined;

export function projectPresencePayload(
  value: unknown,
  authenticatedSelfUserId?: string,
  selfInstanceId?: string,
) {
  if (
    cachedPresenceProjection &&
    cachedPresencePayload === value &&
    cachedAuthenticatedSelfUserId === authenticatedSelfUserId &&
    cachedSelfInstanceId === selfInstanceId
  ) {
    return cachedPresenceProjection;
  }
  cachedPresencePayload = value;
  cachedAuthenticatedSelfUserId = authenticatedSelfUserId;
  cachedSelfInstanceId = selfInstanceId;
  cachedPresenceProjection = projectPresenceViewers(
    readPresenceEntries(value),
    authenticatedSelfUserId,
    selfInstanceId,
  );
  return cachedPresenceProjection;
}

export function hasSessionPresenceViewers(
  value: unknown,
  authenticatedSelfUserId: string | undefined,
  selfInstanceId: string | undefined,
  sessionKey: string,
  excludeUserId?: string,
): boolean {
  const projection = projectPresencePayload(value, authenticatedSelfUserId, selfInstanceId);
  const excludedUserId = normalized(excludeUserId);
  return projection.users.some(
    (user) =>
      user.id !== projection.selfUserId &&
      user.id !== excludedUserId &&
      user.watchedSessions.includes(sessionKey),
  );
}

export function hasMultiplePresenceIdentities(value: unknown): boolean {
  return projectPresencePayload(value).users.length >= 2;
}

export function presenceViewerLabel(user: PresenceViewer): string {
  return user.name ?? user.email ?? user.id;
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

export type ViewerAvatarVariant = "session" | "footer" | "profile";

class ViewerAvatar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) user: PresenceViewer | null = null;
  @property() variant: ViewerAvatarVariant = "session";

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
      data-viewer-id=${user.id}
      aria-label=${label}
    >
      ${renderViewerAvatar(view)}
    </span>`;
  }
}

function renderPresenceCardRow(user: PresenceViewer) {
  const label = presenceViewerLabel(user);
  // The email doubles as the label when no display name exists; repeating it
  // as a subtitle would just echo the same line.
  const subtitle = user.email && user.email !== label ? user.email : undefined;
  return html`<div class="sidebar-hover-card__person" data-viewer-id=${user.id}>
    <openclaw-viewer-avatar .user=${user} variant="footer"></openclaw-viewer-avatar>
    <span class="sidebar-hover-card__person-text">
      <span class="sidebar-hover-card__person-name">${label}</span>
      ${subtitle
        ? html`<span class="sidebar-hover-card__person-email">${subtitle}</span>`
        : nothing}
    </span>
  </div>`;
}

class ViewerFacepile extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) presencePayload: unknown;
  @property({ attribute: false }) selfUserId?: string;
  @property({ attribute: false }) selfInstanceId?: string;
  @property({ attribute: false }) sessionKey?: string;
  @property({ attribute: false }) excludeUserId?: string;
  @property({ attribute: false }) staticUsers?: readonly PresenceViewer[];
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  @property() variant: "session" | "footer" = "session";
  @property({ attribute: false }) buildInfo: ControlUiBuildInfo = CONTROL_UI_BUILD_INFO;
  @property({ attribute: false }) gatewayVersion: string | null = null;

  override render() {
    const projection = projectPresencePayload(
      this.presencePayload,
      this.selfUserId,
      this.selfInstanceId,
    );
    const sessionKey = this.sessionKey;
    const excludeUserId = normalized(this.excludeUserId);
    const users =
      this.variant === "session" && this.staticUsers
        ? [...this.staticUsers]
        : sessionKey
          ? projection.users.filter(
              (user) =>
                user.id !== projection.selfUserId &&
                user.id !== excludeUserId &&
                user.watchedSessions.includes(sessionKey),
            )
          : this.variant === "footer"
            ? projection.users.filter((user) => user.id !== projection.selfUserId)
            : projection.users.filter((user) => user.id !== projection.selfUserId);
    if (users.length === 0) {
      return nothing;
    }
    const visible = users.slice(0, this.maxVisible);
    const overflow = users.slice(this.maxVisible);
    const facepile = html`<span
      class="viewer-facepile viewer-facepile--${this.variant}"
      data-viewer-count=${users.length}
      aria-label=${users.map(presenceViewerLabel).join(", ")}
    >
      ${visible.map((user) =>
        this.variant === "footer"
          ? html`<openclaw-viewer-avatar .user=${user} variant="footer"></openclaw-viewer-avatar>`
          : html`<openclaw-tooltip .content=${presenceViewerLabel(user)}>
              <span class="viewer-facepile__tooltip-anchor">
                <openclaw-viewer-avatar .user=${user} variant="session"></openclaw-viewer-avatar>
              </span>
            </openclaw-tooltip>`,
      )}
      ${overflow.length > 0
        ? this.variant === "footer"
          ? html`<span
              class="viewer-avatar viewer-avatar--overflow"
              aria-label=${overflow.map(presenceViewerLabel).join(", ")}
              >+${overflow.length}</span
            >`
          : html`<openclaw-tooltip .content=${overflow.map(presenceViewerLabel).join("\n")}>
              <span
                class="viewer-avatar viewer-avatar--overflow"
                aria-label=${overflow.map(presenceViewerLabel).join(", ")}
                >+${overflow.length}</span
              >
            </openclaw-tooltip>`
        : nothing}
    </span>`;
    if (this.variant !== "footer") {
      return facepile;
    }
    const roster = projection.users.filter((user) => user.id !== projection.selfUserId);
    return html`
      <openclaw-tooltip class="sidebar-hover-tooltip">
        <span
          class="viewer-facepile-trigger"
          role="group"
          tabindex="0"
          aria-label=${t("presence.rosterLabel")}
        >
          ${facepile}
        </span>
        <div slot="content" class="sidebar-hover-card sidebar-presence-hover-card">
          <section class="sidebar-hover-card__region">
            <div class="sidebar-hover-card__heading">
              ${t("presence.rosterTitle")} · ${roster.length}
            </div>
            <div
              class="sidebar-hover-card__people"
              tabindex="0"
              aria-label=${`${t("presence.rosterTitle")} · ${roster.length}`}
            >
              ${roster.map((user) => renderPresenceCardRow(user))}
            </div>
          </section>
          <div class="sidebar-hover-card__divider" role="separator"></div>
          <section class="sidebar-hover-card__region">
            <div class="sidebar-hover-card__heading">${t("presence.serverRegion")}</div>
            ${renderSidebarServerDetails(this.buildInfo, this.gatewayVersion)}
          </section>
        </div>
      </openclaw-tooltip>
    `;
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
