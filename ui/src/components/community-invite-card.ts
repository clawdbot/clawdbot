import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Community invite card, anchored above the sidebar footer. It never dims the
// app or traps focus; Shadow DOM keeps it off the startup CSS budget.
import { css, html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { icons } from "./icons.ts";

export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite";
const COMMUNITY_INVITE_STATE_CHANGED_EVENT = "community-invite-state-changed";

export type CommunityInviteState = {
  firstShownAtMs?: number;
  dismissedAtMs?: number;
};

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Null means storage itself is unavailable; an empty object is a new browser. */
export function readCommunityInviteState(): CommunityInviteState | null {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(COMMUNITY_INVITE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(value)) {
    return {};
  }
  const storedFirstShownAtMs = timestamp(value.firstShownAtMs);
  const firstShownAtMs =
    storedFirstShownAtMs !== undefined && storedFirstShownAtMs <= Date.now()
      ? storedFirstShownAtMs
      : undefined;
  const dismissedAtMs = timestamp(value.dismissedAtMs);
  return {
    ...(firstShownAtMs === undefined ? {} : { firstShownAtMs }),
    ...(dismissedAtMs === undefined ? {} : { dismissedAtMs }),
  };
}

function writeCommunityInviteState(state: CommunityInviteState): boolean {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return false;
  }
  try {
    const serialized = JSON.stringify(state);
    storage.setItem(COMMUNITY_INVITE_KEY, serialized);
    return storage.getItem(COMMUNITY_INVITE_KEY) === serialized;
  } catch {
    return false;
  }
}

// Solid brand mark: the shared lucide set is stroked, so this one carries its own fill.
const discordMark = html`
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.78 13.78 0 0 0-.64 1.29 18.27 18.27 0 0 0-5.5 0 12.64 12.64 0 0 0-.64-1.29 19.74 19.74 0 0 0-4.93 1.51C.53 9.05-.32 13.6.1 18.06a19.9 19.9 0 0 0 6.07 3.03c.46-.63.87-1.3 1.24-2a12.86 12.86 0 0 1-1.96-.93c.16-.12.32-.24.48-.37a14.2 14.2 0 0 0 12.14 0c.16.13.32.25.48.37-.63.37-1.28.68-1.96.93.36.7.78 1.37 1.24 2a19.84 19.84 0 0 0 6.07-3.03c.5-5.18-.84-9.68-3.58-13.69ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.09 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z"
    />
  </svg>
`;

class OpenClawCommunityInviteCard extends OpenClawLitElement {
  static override styles = css`
    :host {
      display: block;
      flex: none;
      margin: var(--sidebar-group-gap, 16px) calc(-1 * var(--sidebar-pad-x, 10px)) 0;
      animation: invite-enter var(--duration-normal, 180ms) var(--ease-out, ease-out) both;
    }

    @keyframes invite-enter {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
    }

    .invite {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 0;
      border-radius: 0;
      background: var(--community-invite-surface-current, var(--sidebar-bg, var(--bg)));
      color: var(--text);
      box-shadow: none;
    }

    .invite__header {
      position: relative;
      height: var(--community-invite-image-height, 100px);
      flex: none;
      overflow: hidden;
    }

    .invite__header::before,
    .invite__header::after {
      content: "";
      position: absolute;
      z-index: 1;
      pointer-events: none;
    }

    .invite__header::before {
      inset: 0;
      background: linear-gradient(
        to bottom,
        transparent 45%,
        var(--community-invite-photo-base-shade-current, transparent) 100%
      );
    }

    .invite__header::after {
      inset: auto 0 0;
      height: var(--community-invite-fade-height-current, 48px);
      background: var(
        --community-invite-fade-gradient-current,
        linear-gradient(
          to bottom,
          transparent 0%,
          color-mix(
              in srgb,
              var(--community-invite-surface-current, var(--sidebar-bg, var(--bg)))
                var(--community-invite-fade-opacity-20-current, 6%),
              transparent
            )
            20%,
          color-mix(
              in srgb,
              var(--community-invite-surface-current, var(--sidebar-bg, var(--bg)))
                var(--community-invite-fade-opacity-45-current, 22%),
              transparent
            )
            45%,
          color-mix(
              in srgb,
              var(--community-invite-surface-current, var(--sidebar-bg, var(--bg)))
                var(--community-invite-fade-opacity-70-current, 60%),
              transparent
            )
            70%,
          color-mix(
              in srgb,
              var(--community-invite-surface-current, var(--sidebar-bg, var(--bg)))
                var(--community-invite-fade-opacity-88-current, 86%),
              transparent
            )
            88%,
          var(--community-invite-surface-current, var(--sidebar-bg, var(--bg))) 100%
        )
      );
    }

    .invite__art {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center var(--community-invite-object-y, 87%);
    }

    .invite__close {
      position: absolute;
      z-index: 2;
      inset: var(--space-2, 8px) var(--space-2, 8px) auto auto;
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgb(0 0 0 / 42%);
      color: rgb(255 255 255 / 76%);
      cursor: var(--cursor-action, pointer);
      transition:
        background 120ms ease,
        color 120ms ease;
    }

    .invite__close:hover {
      background: rgb(255 255 255 / 14%);
      color: #fff;
    }

    .invite__close:focus-visible {
      outline: 2px solid rgb(255 255 255 / 70%);
      outline-offset: 1px;
    }

    .invite__close svg {
      display: block;
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentcolor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .invite__body {
      display: flex;
      flex-direction: column;
      gap: var(--community-invite-body-gap, 5px);
      padding: var(--community-invite-body-pad-top, 11px) var(--community-invite-body-pad-x, 18px)
        var(--community-invite-body-pad-bottom, 20px);
    }

    .invite__title {
      margin: 0;
      color: var(--text-strong);
      font-size: var(--control-ui-text-lg, 16px);
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }

    .invite__text {
      margin: 0;
      color: var(--muted);
      font-size: var(--control-ui-text-sm, 12px);
      line-height: 1.45;
    }

    .invite__cta {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: var(--community-invite-cta-min-height, 38px);
      margin-top: var(--community-invite-cta-gap, var(--space-3, 12px));
      padding: var(--community-invite-cta-pad-y, 6px) var(--space-2, 8px);
      border-radius: var(--radius-md, 10px);
      background: var(--community-invite-cta-bg-current, var(--text-strong));
      color: var(--community-invite-cta-fg-current, var(--bg));
      font-size: var(--control-ui-text-sm, 12px);
      font-weight: 600;
      text-decoration: none;
      transition:
        background 120ms ease,
        transform 120ms ease;
    }

    .invite__cta:hover {
      background: var(--community-invite-cta-hover-bg-current, var(--text));
      color: var(--community-invite-cta-fg-current, var(--bg));
    }

    .invite__cta:active {
      transform: scale(0.96);
    }

    .invite__cta:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .invite__cta svg {
      width: 17px;
      height: 17px;
      flex: none;
    }

    @supports (corner-shape: superellipse(1.5)) {
      .invite__cta {
        border-radius: calc(10px * var(--openclaw-corner-radius-scale, 1.25));
        corner-shape: superellipse(1.5);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host,
      .invite__close,
      .invite__cta {
        animation: none;
        transition: none;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.recordFirstShown();
  }

  override render() {
    return html`
      <aside class="invite" role="complementary" aria-label=${t("communityInvite.cardLabel")}>
        <div class="invite__header">
          <img
            class="invite__art"
            src=${inferControlUiPublicAssetPath("community-art/discord-invite.webp")}
            alt=${t("communityInvite.artAlt")}
            width="1024"
            height="538"
          />
          <button
            class="invite__close"
            type="button"
            aria-label=${t("communityInvite.dismissForever")}
            @click=${this.dismiss}
          >
            ${icons.x}
          </button>
        </div>
        <div class="invite__body">
          <h2 class="invite__title">${t("communityInvite.title")}</h2>
          <p class="invite__text">
            ${t("communityInvite.body")}<br />${t("communityInvite.bodyGreeting")}
          </p>
          <a
            class="invite__cta"
            href=${COMMUNITY_DISCORD_URL}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
          >
            ${discordMark}
            <span>${t("communityInvite.action")}</span>
          </a>
        </div>
      </aside>
    `;
  }

  private publishState(state: CommunityInviteState | null) {
    this.dispatchEvent(
      new CustomEvent(COMMUNITY_INVITE_STATE_CHANGED_EVENT, {
        bubbles: true,
        composed: true,
        detail: { state },
      }),
    );
  }

  private recordFirstShown() {
    const current = readCommunityInviteState();
    if (current === null || current.dismissedAtMs !== undefined) {
      this.publishState(current);
      return;
    }
    if (current.firstShownAtMs !== undefined) {
      this.publishState(current);
      return;
    }
    const next = { ...current, firstShownAtMs: Date.now() };
    this.publishState(writeCommunityInviteState(next) ? next : null);
  }

  private dismiss = () => {
    const current = readCommunityInviteState();
    if (current === null) {
      this.publishState(null);
      return;
    }
    const now = Date.now();
    const next = {
      ...current,
      firstShownAtMs: current.firstShownAtMs ?? now,
      dismissedAtMs: now,
    };
    this.publishState(writeCommunityInviteState(next) ? next : null);
  };
}

if (!customElements.get("openclaw-community-invite-card")) {
  customElements.define("openclaw-community-invite-card", OpenClawCommunityInviteCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-community-invite-card": OpenClawCommunityInviteCard;
  }
}
