import { html, nothing } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { i18n, t } from "../../i18n/index.ts";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";

export type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
};

const SHORT_COMMIT_LENGTH = 12;

export function formatControlUiBuildDate(
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

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return html`<span class="about-build-strip__unavailable">${t("aboutPage.unavailable")}</span>`;
  }
  const label = copyButtonLabel(props.copyState);
  return html`
    <span class="about-build-strip__commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="about-build-strip__copy ${props.copyState === "copied"
            ? "about-build-strip__copy--copied"
            : props.copyState === "error"
              ? "about-build-strip__copy--error"
              : ""}"
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

export function renderAbout(props: AboutProps) {
  const buildDate = formatControlUiBuildDate(props.buildInfo.builtAt, i18n.getLocale());
  return html`
    <div class="about-page">
      <section class="card about-card" aria-labelledby="about-artifact-title">
        <div class="about-card__intro">
          <h2 id="about-artifact-title" class="card-title">${t("aboutPage.artifactTitle")}</h2>
          <p class="card-sub">${t("aboutPage.artifactSubtitle")}</p>
        </div>

        <dl class="about-build-strip" role="group" aria-label=${t("aboutPage.artifactDetails")}>
          <div class="about-build-strip__item">
            <dt>${t("aboutPage.version")}</dt>
            <dd>
              ${props.buildInfo.version
                ? html`<code dir="ltr" title=${props.buildInfo.version}
                    >${props.buildInfo.version}</code
                  >`
                : html`<span class="about-build-strip__unavailable"
                    >${t("aboutPage.unavailable")}</span
                  >`}
            </dd>
          </div>
          <div class="about-build-strip__item">
            <dt>${t("aboutPage.commit")}</dt>
            <dd>${renderCommit(props)}</dd>
          </div>
          <div class="about-build-strip__item">
            <dt>${t("aboutPage.built")}</dt>
            <dd>
              ${buildDate && props.buildInfo.builtAt
                ? html`<time
                    dir="auto"
                    datetime=${props.buildInfo.builtAt}
                    title=${props.buildInfo.builtAt}
                    >${buildDate}</time
                  >`
                : html`<span class="about-build-strip__unavailable"
                    >${t("aboutPage.unavailable")}</span
                  >`}
            </dd>
          </div>
        </dl>

        <div class="about-gateway-row">
          <dl>
            <div>
              <dt>${t("aboutPage.gatewayVersion")}</dt>
              <dd>
                ${props.gatewayVersion
                  ? html`<code dir="ltr" title=${props.gatewayVersion}
                      >${props.gatewayVersion}</code
                    >`
                  : html`<span class="about-build-strip__unavailable"
                      >${t("aboutPage.unavailable")}</span
                    >`}
              </dd>
            </div>
          </dl>
          <p>${t("aboutPage.gatewayVersionHint")}</p>
        </div>
      </section>
    </div>
  `;
}
