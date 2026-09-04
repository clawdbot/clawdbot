import { html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
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

export function renderCommunityInviteCard(onDismiss: () => void) {
  return html`
    <div class="community-invite-card">
      <aside class="invite" role="complementary" aria-label=${t("communityInvite.cardLabel")}>
        <div class="invite__header">
          <img
            class="invite__art"
            src=${inferControlUiPublicAssetPath("community-art/discord-invite.webp")}
            alt=${t("communityInvite.artAlt")}
            width="1024"
            height="538"
            loading="lazy"
          />
          <button
            class="invite__close"
            type="button"
            aria-label=${t("communityInvite.dismissForever")}
            @click=${onDismiss}
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
    </div>
  `;
}
