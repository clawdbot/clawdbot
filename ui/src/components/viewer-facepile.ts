import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { PresenceEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "./menu-surface.ts";
import "./tooltip.ts";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

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
  selfInstanceId?: string,
): { users: readonly PresenceViewer[]; selfUserId?: string } {
  const grouped = new Map<string, PresenceEntry[]>();
  let selfUserId: string | undefined;
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
    if (selfInstanceId && entry.instanceId === selfInstanceId) {
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
let cachedSelfInstanceId: string | undefined;
let cachedPresenceProjection: ReturnType<typeof projectPresenceViewers> | undefined;

function projectPresencePayload(value: unknown, selfInstanceId?: string) {
  if (
    cachedPresenceProjection &&
    cachedPresencePayload === value &&
    cachedSelfInstanceId === selfInstanceId
  ) {
    return cachedPresenceProjection;
  }
  cachedPresencePayload = value;
  cachedSelfInstanceId = selfInstanceId;
  cachedPresenceProjection = projectPresenceViewers(readPresenceEntries(value), selfInstanceId);
  return cachedPresenceProjection;
}

export function presenceViewerLabel(user: PresenceViewer): string {
  return user.name ?? user.email ?? user.id;
}

function initialsFor(user: PresenceViewer): string {
  const label = presenceViewerLabel(user);
  const words = label
    .replace(/@.*$/u, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return (words[0] ?? label).slice(0, 2).toUpperCase();
}

function avatarColor(userId: string): string {
  let hash = 2166136261;
  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 48% 42%)`;
}

function renderAvatarInitials(user: PresenceViewer) {
  return html`<span style=${`background: ${avatarColor(user.id)}`}>${initialsFor(user)}</span>`;
}

function resolveViewerAvatar(user: PresenceViewer) {
  const avatar = resolveAvatar({
    id: user.email ?? user.id,
    name: user.name,
    profileAvatarUrl: user.avatarUrl,
  });
  if (avatar.kind === "initials") {
    return renderAvatarInitials(user);
  }
  return html`<img
      src=${avatar.url}
      alt=""
      referrerpolicy="no-referrer"
      @error=${(event: Event) => {
        const image = event.currentTarget;
        if (image instanceof HTMLImageElement) {
          image.closest<HTMLElement>(".viewer-avatar")?.classList.add("is-fallback");
        }
      }}
      @load=${(event: Event) => {
        const image = event.currentTarget;
        if (image instanceof HTMLImageElement) {
          image.closest<HTMLElement>(".viewer-avatar")?.classList.remove("is-fallback");
        }
      }}
    />
    <span class="viewer-avatar__fallback" style=${`background: ${avatarColor(user.id)}`}
      >${initialsFor(user)}</span
    >`;
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
    return html`<span
      class="viewer-avatar viewer-avatar--${this.variant}"
      data-viewer-id=${user.id}
      aria-label=${label}
    >
      ${resolveViewerAvatar(user)}
    </span>`;
  }
}

function renderRosterRow(user: PresenceViewer, isSelf: boolean) {
  const label = presenceViewerLabel(user);
  // The email doubles as the label when no display name exists; repeating it
  // as a subtitle would just echo the same line.
  const subtitle = user.email && user.email !== label ? user.email : undefined;
  return html`<wa-dropdown-item class="presence-roster-menu__item" data-viewer-id=${user.id}>
    <openclaw-viewer-avatar slot="icon" .user=${user} variant="footer"></openclaw-viewer-avatar>
    <span class="presence-roster-menu__text">
      <span class="presence-roster-menu__name"
        >${label}${isSelf
          ? html` <span class="presence-roster-menu__you">(${t("presence.you")})</span>`
          : nothing}</span
      >
      ${subtitle ? html`<span class="presence-roster-menu__email">${subtitle}</span>` : nothing}
    </span>
  </wa-dropdown-item>`;
}

class ViewerFacepile extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) presencePayload: unknown;
  @property({ attribute: false }) selfInstanceId?: string;
  @property({ attribute: false }) sessionKey?: string;
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  @property() variant: "session" | "footer" = "session";

  @state() private rosterPosition: { x: number; y: number } | null = null;

  private openRoster(event: MouseEvent) {
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.rosterPosition = { x: rect.left, y: rect.top };
  }

  private focusRosterTrigger() {
    this.querySelector<HTMLButtonElement>("button.viewer-facepile-trigger")?.focus();
  }

  protected override willUpdate() {
    if (!this.rosterPosition) {
      return;
    }
    // A presence update can unmount the footer facepile (everyone else left)
    // while the roster is open. The dropdown is then removed without hiding,
    // so wa-after-hide never fires — clear the open state here or the menu
    // would remount at stale coordinates when presence returns.
    const projection = projectPresencePayload(this.presencePayload, this.selfInstanceId);
    const available =
      this.variant === "footer" &&
      !this.sessionKey &&
      projection.users.some((user) => user.id !== projection.selfUserId);
    if (!available) {
      this.rosterPosition = null;
    }
  }

  private renderRosterMenu(roster: readonly PresenceViewer[], selfUserId: string | undefined) {
    const position = this.rosterPosition;
    if (!position) {
      return nothing;
    }
    return html`<openclaw-menu-surface>
      <wa-dropdown
        class="presence-roster-menu"
        .open=${true}
        placement="top-start"
        .distance=${4}
        aria-label=${t("presence.rosterTitle")}
        @wa-select=${(event: CustomEvent) => {
          // Rows are informational; selecting one just dismisses the menu.
          // Close explicitly — preventDefault also cancels the dropdown's own
          // select-and-hide behavior — and hand focus back to the trigger so
          // a keyboard activation does not strand focus on the body.
          event.preventDefault();
          this.rosterPosition = null;
          this.focusRosterTrigger();
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => this.focusRosterTrigger())}
        @wa-after-hide=${(event: Event) => {
          // The dropdown's own trigger is a hidden throwaway anchor, so restore
          // focus to the visible facepile button on keyboard dismissal.
          const keyboard = consumeDropdownKeyboardDismissal(event);
          this.rosterPosition = null;
          if (keyboard) {
            this.focusRosterTrigger();
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        <div class="presence-roster-menu__title" role="presentation">
          ${t("presence.rosterTitle")} · ${roster.length}
        </div>
        ${roster.map((user) => renderRosterRow(user, user.id === selfUserId))}
      </wa-dropdown>
    </openclaw-menu-surface>`;
  }

  override render() {
    const projection = projectPresencePayload(this.presencePayload, this.selfInstanceId);
    const sessionKey = this.sessionKey;
    const users = sessionKey
      ? projection.users.filter(
          (user) => user.id !== projection.selfUserId && user.watchedSessions.includes(sessionKey),
        )
      : this.variant === "footer"
        ? projection.users.filter((user) => user.id !== projection.selfUserId)
        : projection.users;
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
      ${visible.map((user) => {
        const label = presenceViewerLabel(user);
        return html`<openclaw-tooltip .content=${label}>
          <openclaw-viewer-avatar .user=${user} .variant=${this.variant}></openclaw-viewer-avatar>
        </openclaw-tooltip>`;
      })}
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
    if (this.variant !== "footer") {
      return facepile;
    }
    // The footer cluster opens the who's-online roster. Self sorts first so
    // your own row anchors the list; everyone else keeps the projection order.
    const roster = [...projection.users].toSorted((a, b) =>
      a.id === projection.selfUserId ? -1 : b.id === projection.selfUserId ? 1 : 0,
    );
    return html`<button
        type="button"
        class="viewer-facepile-trigger"
        aria-label=${t("presence.rosterLabel")}
        aria-haspopup="menu"
        aria-expanded=${this.rosterPosition !== null}
        @click=${(event: MouseEvent) => this.openRoster(event)}
      >
        ${facepile}
      </button>
      ${this.renderRosterMenu(roster, projection.selfUserId)}`;
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
