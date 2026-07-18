import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { icons } from "../../components/icons.ts";
import {
  canonicalLobsterLook,
  LOBSTER_PET_PALETTES,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { i18n, t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import "../../styles/about.css";
import { brandIcons } from "./brand-icons.ts";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";

type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
  clawdWaving: boolean;
  onPokeClawd: () => void;
};

const SHORT_COMMIT_LENGTH = 12;

// Docs-first where a docs page exists; GitHub/Discord match the native
// macOS/iOS About screens (AboutSettings.swift, SettingsProTabSections.swift).
const ABOUT_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; label: () => string }> = [
  { href: "https://openclaw.ai", icon: icons.globe, label: () => t("aboutPage.linkWebsite") },
  { href: "https://docs.openclaw.ai", icon: icons.book, label: () => t("aboutPage.linkDocs") },
  {
    href: "https://github.com/openclaw/openclaw",
    icon: brandIcons.github,
    label: () => t("aboutPage.linkGitHub"),
  },
  {
    href: "https://discord.gg/clawd",
    icon: brandIcons.discord,
    label: () => t("aboutPage.linkDiscord"),
  },
  {
    href: "https://x.com/openclaw",
    icon: brandIcons.x,
    label: () => t("aboutPage.linkX"),
  },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: icons.scrollText,
    label: () => t("aboutPage.linkChangelog"),
  },
];

function formatControlUiBuildDate(
  value: string | null,
  locales?: Intl.LocalesArgument,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function copyButtonLabel(state: AboutCommitCopyState): string {
  if (state === "copying") {
    return t("aboutPage.copyingCommit");
  }
  if (state === "copied") {
    return t("aboutPage.copiedCommit");
  }
  if (state === "error") {
    return t("aboutPage.copyCommitFailed");
  }
  return t("aboutPage.copyCommit");
}

function copyStatus(state: AboutCommitCopyState): string {
  return state === "copied"
    ? t("aboutPage.copiedCommit")
    : state === "error"
      ? t("aboutPage.copyCommitFailed")
      : "";
}

function renderUnavailable() {
  return html`<span class="muted">${t("aboutPage.unavailable")}</span>`;
}

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return renderUnavailable();
  }
  const label = copyButtonLabel(props.copyState);
  return html`
    <span class="about-commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="btn btn--icon"
          aria-label=${label}
          aria-busy=${props.copyState === "copying" ? "true" : nothing}
          ?disabled=${props.copyState === "copying"}
          @click=${props.onCopyCommit}
        >
          <span aria-hidden="true">${props.copyState === "copied" ? icons.check : icons.copy}</span>
        </button>
      </openclaw-tooltip>
      <span class="about-sr-only" role="status" aria-live="polite"
        >${copyStatus(props.copyState)}</span
      >
    </span>
  `;
}

// The same canonical crimson Clawd as the chat welcome hero, rendered big.
// The poke button replays the claw wave; ambient motion lives in about.css.
function renderHero(props: AboutProps) {
  const palette =
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "crimson") ??
    expectDefined(LOBSTER_PET_PALETTES[0], "about lobster palette");
  const look = canonicalLobsterLook(palette);
  return html`
    <section class="about-hero">
      <button
        type="button"
        class="about-hero__clawd ${props.clawdWaving ? "about-hero__clawd--wave" : ""}"
        style=${`--lob-shell:${look.palette.shell};--lob-claw:${look.palette.claw}`}
        aria-label=${t("aboutPage.waveHello")}
        @click=${props.onPokeClawd}
      >
        ${renderLobsterSvg(look)}
      </button>
      <h2 class="about-hero__name">${t("aboutPage.productName")}</h2>
      <p class="about-hero__tagline">${t("aboutPage.tagline")}</p>
      ${props.buildInfo.version
        ? html`<code class="about-hero__version" dir="ltr">v${props.buildInfo.version}</code>`
        : nothing}
      <nav class="about-hero__links" aria-label=${t("aboutPage.linksLabel")}>
        ${ABOUT_LINKS.map(
          (link) => html`
            <a
              class="about-hero__link"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="about-hero__link-icon" aria-hidden="true">${link.icon}</span>
              <span>${link.label()}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderAbout(props: AboutProps) {
  const buildDate = formatControlUiBuildDate(props.buildInfo.builtAt, i18n.getLocale());
  const buildFacts = html`
    <dl class="settings-kv" role="group" aria-label=${t("aboutPage.artifactDetails")}>
      <dt>${t("aboutPage.version")}</dt>
      <dd>
        ${props.buildInfo.version
          ? html`<code dir="ltr" title=${props.buildInfo.version}>${props.buildInfo.version}</code>`
          : renderUnavailable()}
      </dd>
      <dt>${t("aboutPage.commit")}</dt>
      <dd>${renderCommit(props)}</dd>
      ${props.buildInfo.branch
        ? html`
            <dt>${t("aboutPage.branch")}</dt>
            <dd>
              <code dir="ltr" title=${props.buildInfo.branch}
                >${props.buildInfo.branch}${props.buildInfo.dirty === true ? "*" : ""}</code
              >
            </dd>
          `
        : nothing}
      <dt>${t("aboutPage.built")}</dt>
      <dd>
        ${buildDate && props.buildInfo.builtAt
          ? html`<time
              dir="auto"
              datetime=${props.buildInfo.builtAt}
              title=${props.buildInfo.builtAt}
              >${buildDate}</time
            >`
          : renderUnavailable()}
      </dd>
    </dl>
  `;
  return renderSettingsPage([
    renderHero(props),
    renderSettingsSection(
      { title: t("aboutPage.artifactTitle"), description: t("aboutPage.artifactSubtitle") },
      buildFacts,
    ),
    renderSettingsSection(
      {},
      renderSettingsRow({
        title: t("aboutPage.gatewayVersion"),
        description: t("aboutPage.gatewayVersionHint"),
        control: props.gatewayVersion
          ? renderSettingsValue(
              html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`,
              { mono: true },
            )
          : renderSettingsValue(t("aboutPage.unavailable")),
      }),
    ),
    html`<p class="about-footer">${t("aboutPage.license")}</p>`,
  ]);
}
