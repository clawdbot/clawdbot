import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { PresenceEntry } from "../api/types.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
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

type GravatarCacheEntry = string | Promise<string | null> | { failedUntil: number };

// An <img> error cannot distinguish a Gravatar 404 from a transient network or
// 5xx failure, so negative entries expire instead of poisoning the page lifetime.
// Accepted tradeoff: re-resolution happens on the next user-prop update (any
// presence/snapshot event), not on a timer — a fully idle page keeps initials
// until activity resumes rather than each avatar owning a retry timer.
const GRAVATAR_NEGATIVE_CACHE_MS = 10 * 60 * 1000;
const gravatarUrlCache = new Map<string, GravatarCacheEntry>();

function negativeEntry(): GravatarCacheEntry {
  return { failedUntil: Date.now() + GRAVATAR_NEGATIVE_CACHE_MS };
}

function normalizedEmail(email: string | null | undefined): string | undefined {
  return normalized(email)?.toLowerCase();
}

function gravatarUrlForEmail(email: string): string | null | Promise<string | null> {
  const normalizedValue = normalizedEmail(email);
  if (!normalizedValue) {
    return null;
  }
  const cached = gravatarUrlCache.get(normalizedValue);
  if (cached !== undefined) {
    if (typeof cached === "object" && cached !== null && "failedUntil" in cached) {
      if (cached.failedUntil > Date.now()) {
        return null;
      }
      gravatarUrlCache.delete(normalizedValue);
    } else {
      return cached;
    }
  }
  const pending = Promise.resolve()
    .then(() =>
      globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedValue)),
    )
    .then((digest) => {
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const url = `https://gravatar.com/avatar/${hash}?d=404&s=128`;
      gravatarUrlCache.set(normalizedValue, url);
      return url;
    })
    .catch(() => {
      gravatarUrlCache.set(normalizedValue, negativeEntry());
      return null;
    });
  gravatarUrlCache.set(normalizedValue, pending);
  return pending;
}

export type ViewerAvatarVariant = "session" | "footer" | "profile";

class ViewerAvatar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) user: PresenceViewer | null = null;
  @property() variant: ViewerAvatarVariant = "session";

  @state() private gravatar: { email: string; url: string } | null = null;

  private failedImageUrl: string | null = null;
  private resolutionId = 0;

  protected override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("user")) {
      this.failedImageUrl = null;
    }
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("user")) {
      return;
    }
    const resolutionId = ++this.resolutionId;
    const email = this.user?.avatarUrl ? undefined : normalizedEmail(this.user?.email);
    if (!email) {
      return;
    }
    const applyResolvedUrl = (url: string | null) => {
      if (
        resolutionId === this.resolutionId &&
        !this.user?.avatarUrl &&
        normalizedEmail(this.user?.email) === email
      ) {
        this.gravatar = url ? { email, url } : null;
      }
    };
    const resolved = gravatarUrlForEmail(email);
    if (typeof resolved === "string") {
      applyResolvedUrl(resolved);
      return;
    }
    if (resolved) {
      void resolved.then(applyResolvedUrl);
    }
  }

  private readonly handleImageError = (event: Event) => {
    const imageUrl = (event.currentTarget as HTMLImageElement).getAttribute("src");
    const user = this.user;
    if (!imageUrl || !user) {
      return;
    }
    const email = normalizedEmail(user.email);
    if (
      !user.avatarUrl &&
      email &&
      imageUrl === this.gravatar?.url &&
      email === this.gravatar.email
    ) {
      gravatarUrlCache.set(email, negativeEntry());
      this.gravatar = null;
      return;
    }
    this.failedImageUrl = imageUrl;
    this.requestUpdate();
  };

  override render() {
    const user = this.user;
    if (!user) {
      return nothing;
    }
    const label = presenceViewerLabel(user);
    const email = normalizedEmail(user.email);
    const gravatarUrl = this.gravatar && this.gravatar.email === email ? this.gravatar.url : null;
    const imageUrl = user.avatarUrl ?? gravatarUrl;
    return html`<span
      class="viewer-avatar viewer-avatar--${this.variant}"
      data-viewer-id=${user.id}
      aria-label=${label}
    >
      ${imageUrl && imageUrl !== this.failedImageUrl
        ? html`<img
            src=${imageUrl}
            alt=""
            referrerpolicy="no-referrer"
            loading="lazy"
            @error=${this.handleImageError}
          />`
        : html`<span style=${`background: ${avatarColor(user.id)}`}>${initialsFor(user)}</span>`}
    </span>`;
  }
}

class ViewerFacepile extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) presencePayload: unknown;
  @property({ attribute: false }) selfInstanceId?: string;
  @property({ attribute: false }) sessionKey?: string;
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  @property() variant: "session" | "footer" = "session";

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
    return html`<span
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
