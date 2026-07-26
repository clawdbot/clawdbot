// Control UI view renders the Apps & extensions promo page.
import { html, nothing, type TemplateResult } from "lit";
import type { RouteId } from "../../app-route-paths.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import "../../styles/apps.css";
import { brandIcons } from "../about/brand-icons.ts";
import { appsBrandIcons } from "./brand-icons.ts";

type AppsProps = {
  onNavigate: (routeId: RouteId) => void;
  /** Opens the device-pairing dialog; absent when the operator cannot pair. */
  onPairDevice?: () => void;
};

type AppCardCta =
  | { kind: "external"; href: string; label: () => string }
  | { kind: "internal"; routeId: RouteId; label: () => string };

type AppCard = {
  id: string;
  /** Two-stop gradient behind the card art; also covers image load latency. */
  gradient: readonly [string, string];
  icon: TemplateResult;
  title: () => string;
  desc: () => string;
  badge?: () => string;
  ctas: readonly AppCardCta[];
};

type AppSection = {
  id: string;
  label: () => string;
  cards: readonly AppCard[];
};

const docsCta = (path: string): AppCardCta => ({
  kind: "external",
  href: `https://docs.openclaw.ai${path}`,
  label: () => t("appsPage.ctaDocs"),
});

const APP_SECTIONS: readonly AppSection[] = [
  {
    id: "mobile",
    label: () => t("appsPage.sectionMobile"),
    cards: [
      {
        id: "ios",
        gradient: ["#38bdf8", "#1d4ed8"],
        icon: appsBrandIcons.apple,
        title: () => t("appsPage.cards.ios.title"),
        desc: () => t("appsPage.cards.ios.desc"),
        ctas: [
          {
            kind: "external",
            href: "https://apps.apple.com/app/openclaw-ai-that-does-things/id6780396132",
            label: () => t("appsPage.ctaAppStore"),
          },
          docsCta("/platforms/ios"),
        ],
      },
      {
        id: "android",
        gradient: ["#34d399", "#047857"],
        icon: appsBrandIcons.android,
        title: () => t("appsPage.cards.android.title"),
        desc: () => t("appsPage.cards.android.desc"),
        ctas: [
          {
            kind: "external",
            href: "https://play.google.com/store/apps/details?id=ai.openclaw.app",
            label: () => t("appsPage.ctaPlayStore"),
          },
          docsCta("/platforms/android"),
        ],
      },
    ],
  },
  {
    id: "watch",
    label: () => t("appsPage.sectionWatch"),
    cards: [
      {
        id: "apple-watch",
        gradient: ["#f472b6", "#be185d"],
        icon: appsBrandIcons.watch,
        title: () => t("appsPage.cards.appleWatch.title"),
        desc: () => t("appsPage.cards.appleWatch.desc"),
        badge: () => t("appsPage.badgeBundledIos"),
        ctas: [docsCta("/platforms/ios")],
      },
      {
        id: "wear-os",
        gradient: ["#22d3ee", "#0e7490"],
        icon: appsBrandIcons.watch,
        title: () => t("appsPage.cards.wearOs.title"),
        desc: () => t("appsPage.cards.wearOs.desc"),
        badge: () => t("appsPage.badgeBundledAndroid"),
        ctas: [docsCta("/platforms/android")],
      },
    ],
  },
  {
    id: "desktop",
    label: () => t("appsPage.sectionDesktop"),
    cards: [
      {
        id: "macos",
        gradient: ["#a855f7", "#6b21a8"],
        icon: appsBrandIcons.apple,
        title: () => t("appsPage.cards.macos.title"),
        desc: () => t("appsPage.cards.macos.desc"),
        ctas: [
          {
            kind: "external",
            href: "https://github.com/openclaw/openclaw/releases",
            label: () => t("appsPage.ctaDownload"),
          },
          docsCta("/platforms/macos"),
        ],
      },
      {
        id: "windows",
        gradient: ["#818cf8", "#4338ca"],
        icon: appsBrandIcons.windows,
        title: () => t("appsPage.cards.windows.title"),
        desc: () => t("appsPage.cards.windows.desc"),
        ctas: [
          {
            kind: "external",
            href: "https://github.com/openclaw/openclaw-windows-node/releases/latest",
            label: () => t("appsPage.ctaDownload"),
          },
          docsCta("/platforms/windows"),
        ],
      },
      {
        id: "linux",
        gradient: ["#fbbf24", "#b45309"],
        icon: appsBrandIcons.linux,
        title: () => t("appsPage.cards.linux.title"),
        desc: () => t("appsPage.cards.linux.desc"),
        ctas: [
          {
            kind: "external",
            href: "https://github.com/openclaw/openclaw/releases",
            label: () => t("appsPage.ctaDownload"),
          },
          docsCta("/platforms/linux"),
        ],
      },
    ],
  },
  {
    id: "browser",
    label: () => t("appsPage.sectionBrowser"),
    cards: [
      {
        id: "chrome-extension",
        gradient: ["#f59e0b", "#ea580c"],
        icon: appsBrandIcons.chrome,
        title: () => t("appsPage.cards.chrome.title"),
        desc: () => t("appsPage.cards.chrome.desc"),
        // Installs unpacked via `openclaw browser extension path`; there is no
        // Chrome Web Store listing, so the only CTA is the setup guide.
        ctas: [
          {
            kind: "external",
            href: "https://docs.openclaw.ai/tools/chrome-extension",
            label: () => t("appsPage.ctaSetupGuide"),
          },
        ],
      },
      {
        id: "plugins",
        gradient: ["#fb7185", "#9f1239"],
        icon: icons.puzzle,
        title: () => t("appsPage.cards.plugins.title"),
        desc: () => t("appsPage.cards.plugins.desc"),
        ctas: [
          { kind: "internal", routeId: "plugins", label: () => t("appsPage.ctaOpenPlugins") },
          {
            kind: "external",
            href: "https://clawhub.ai",
            label: () => t("appsPage.ctaBrowseClawHub"),
          },
        ],
      },
    ],
  },
];

const COMMUNITY_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; label: () => string }> =
  [
    {
      href: "https://discord.gg/clawd",
      icon: brandIcons.discord,
      label: () => t("appsPage.linkDiscord"),
    },
    { href: "https://docs.openclaw.ai", icon: icons.book, label: () => t("appsPage.linkDocs") },
  ];

function renderCta(cta: AppCardCta, index: number, props: AppsProps) {
  const className = index === 0 ? "apps-card__cta apps-card__cta--primary" : "apps-card__cta";
  if (cta.kind === "internal") {
    return html`
      <button type="button" class=${className} @click=${() => props.onNavigate(cta.routeId)}>
        ${cta.label()}
      </button>
    `;
  }
  return html`
    <a
      class=${className}
      href=${cta.href}
      target=${EXTERNAL_LINK_TARGET}
      rel=${buildExternalLinkRel()}
    >
      ${cta.label()}
    </a>
  `;
}

function renderAppCard(card: AppCard, props: AppsProps) {
  const [from, to] = card.gradient;
  return html`
    <article class="apps-card">
      <div class="apps-card__art" style=${`--apps-art-a:${from};--apps-art-b:${to}`}>
        <img
          class="apps-card__art-img apps-card__art-img--light"
          src=${inferControlUiPublicAssetPath(`app-art/${card.id}.webp`)}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <img
          class="apps-card__art-img apps-card__art-img--dark"
          src=${inferControlUiPublicAssetPath(`app-art/${card.id}-dark.webp`)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </div>
      <div class="apps-card__body">
        <div class="apps-card__title-row">
          <span class="apps-card__icon" aria-hidden="true">${card.icon}</span>
          <h3 class="apps-card__title">${card.title()}</h3>
          ${card.badge ? html`<span class="apps-card__badge">${card.badge()}</span>` : nothing}
        </div>
        <p class="apps-card__desc">${card.desc()}</p>
        <div class="apps-card__ctas">
          ${card.ctas.map((cta, index) => renderCta(cta, index, props))}
        </div>
      </div>
    </article>
  `;
}

function renderSection(section: AppSection, props: AppsProps) {
  const pairHint =
    section.id === "mobile" && props.onPairDevice
      ? html`
          <p class="apps-pair-hint">
            ${t("appsPage.havePhone")}
            <button type="button" @click=${props.onPairDevice}>
              ${t("appsPage.pairDevice")}
            </button>
          </p>
        `
      : nothing;
  return html`
    <section class="apps-section" aria-label=${section.label()}>
      <h2 class="apps-section__heading">${section.label()}</h2>
      <div class="apps-grid">${section.cards.map((card) => renderAppCard(card, props))}</div>
      ${pairHint}
    </section>
  `;
}

function renderCommunity() {
  return html`
    <section class="apps-section" aria-label=${t("appsPage.sectionCommunity")}>
      <h2 class="apps-section__heading">${t("appsPage.sectionCommunity")}</h2>
      <nav class="apps-community" aria-label=${t("appsPage.sectionCommunity")}>
        ${COMMUNITY_LINKS.map(
          (link) => html`
            <a
              class="apps-pill"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="apps-pill__icon" aria-hidden="true">${link.icon}</span>
              <span>${link.label()}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderApps(props: AppsProps) {
  return html`
    <div class="apps-page">
      <section class="apps-hero">
        <h1 class="apps-hero__title">${t("appsPage.heroTitle")}</h1>
        <p class="apps-hero__tagline">${t("appsPage.heroTagline")}</p>
      </section>
      ${APP_SECTIONS.map((section) => renderSection(section, props))} ${renderCommunity()}
    </div>
  `;
}
