import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export type PluginCardAttribution = {
  author?: string;
  official: boolean;
};

export function renderPluginOfficialBadge(): TemplateResult {
  return html`<span
    class="plugin-official-badge"
    aria-label=${t("pluginsPage.official")}
    title=${t("pluginsPage.official")}
    >${icons.badgeCheck}</span
  >`;
}

export function renderPluginAuthor(
  author: string | undefined,
  options: { linked?: boolean } = {},
): TemplateResult | typeof nothing {
  if (!author) {
    return nothing;
  }
  const handle = author.replace(/^@+/, "");
  const label = `@${handle}`;
  return options.linked
    ? html`<a
        class="plugin-card-author plugin-card-author--linked"
        href=${`https://clawhub.ai/user/${encodeURIComponent(handle)}`}
        target="_blank"
        rel="noopener noreferrer"
        >${label}</a
      >`
    : html`<span class="plugin-card-author">${label}</span>`;
}

export function renderPluginCardIdentity(params: {
  name: string;
  attribution: PluginCardAttribution;
  linkedAuthor?: boolean;
  showAuthor?: boolean;
  subtitle?: string;
}): TemplateResult {
  return html`<div class="installed-plugins-card__identity">
    <div class="plugin-card-title-row">
      <h3>${params.name}</h3>
      ${params.attribution.official ? renderPluginOfficialBadge() : nothing}
    </div>
    ${params.subtitle ? renderPluginCardSummary(params.subtitle) : nothing}
    ${
      params.showAuthor === false
        ? nothing
        : renderPluginAuthor(params.attribution.author, { linked: params.linkedAuthor })
    }
  </div>`;
}

export function renderPluginCardSummary(summary: string): TemplateResult {
  return html`<p class="installed-plugins-card__summary">${summary}</p>`;
}
