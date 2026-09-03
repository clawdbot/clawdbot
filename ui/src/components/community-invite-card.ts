// Community invite card, anchored above the sidebar footer. It never dims the
// app or traps focus; Shadow DOM keeps it off the startup CSS budget.
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import "../styles/community-invite-card.css";
import { icons } from "./icons.ts";

// Solid brand mark: the shared lucide set is stroked, so this one carries its own fill.
const discordMark = html`
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.78 13.78 0 0 0-.64 1.29 18.27 18.27 0 0 0-5.5 0 12.64 12.64 0 0 0-.64-1.29 19.74 19.74 0 0 0-4.93 1.51C.53 9.05-.32 13.6.1 18.06a19.9 19.9 0 0 0 6.07 3.03c.46-.63.87-1.3 1.24-2a12.86 12.86 0 0 1-1.96-.93c.16-.12.32-.24.48-.37a14.2 14.2 0 0 0 12.14 0c.16.13.32.25.48.37-.63.37-1.28.68-1.96.93.36.7.78 1.37 1.24 2a19.84 19.84 0 0 0 6.07-3.03c.5-5.18-.84-9.68-3.58-13.69ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.09 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z"
    />
  </svg>
`;

class OpenClawCommunityInviteCard extends OpenClawLitElement {
  @property({ attribute: false }) onDismiss?: () => void;
  static override styles = css`
    :host {
      display: block;
      flex: none;
      margin: 0;
      border-block-start: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
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
      height: 100px;
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
      object-position: center 87%;
    }

    .invite__close {
      position: absolute;
      z-index: 2;
      inset-block-start: var(--space-2, 8px);
      inset-inline-end: var(--space-2, 8px);
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 50%;
      /* These fixed translucent colors belong to photo chrome, not the theme surface. */
      background: rgb(0 0 0 / 42%);
      color: rgb(255 255 255 / 76%);
      cursor: var(--cursor-action, default);
      transition:
        background 120ms ease,
        color 120ms ease;
    }

    .invite__close:hover {
      background: rgb(255 255 255 / 14%);
      color: rgb(255 255 255);
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
      gap: 5px;
      padding: 11px 18px 20px;
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

    a.invite__cta {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 38px;
      margin-top: var(--space-3, 12px);
      padding: 6px var(--space-2, 8px);
      border-radius: var(--radius-md, 10px);
      background: var(--text-strong);
      color: var(--bg);
      cursor: pointer;
      font-size: var(--control-ui-text-sm, 12px);
      font-weight: 600;
      text-decoration: none;
      transition:
        background 120ms ease,
        transform 120ms ease;
    }

    .invite__cta:hover {
      background: color-mix(in srgb, var(--text) 92%, var(--bg-hover) 8%);
      color: var(--bg);
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
            @click=${() => this.onDismiss?.()}
          >
            ${icons.x}
          </button>
        </div>
        <div class="invite__body">
          <h2 class="invite__title">${t("communityInvite.title")}</h2>
          <p class="invite__text">
            ${t("communityInvite.body")} ${t("communityInvite.bodyGreeting")}
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
}

if (!customElements.get("openclaw-community-invite-card")) {
  customElements.define("openclaw-community-invite-card", OpenClawCommunityInviteCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-community-invite-card": OpenClawCommunityInviteCard;
  }
}
