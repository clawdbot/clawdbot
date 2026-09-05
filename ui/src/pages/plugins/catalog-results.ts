import { html, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton, renderSettingsPage } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryResult } from "../../lib/plugins/index.ts";

export type PluginCatalogResultsProps = {
  connected: boolean;
  loading: boolean;
  result: PluginDiscoveryResult | null;
  error: string | null;
  onRetry: () => void;
};

function formatCount(value: number | undefined): string | null {
  return value === undefined ? null : new Intl.NumberFormat().format(value);
}

export function renderPluginCatalogResults(props: PluginCatalogResultsProps): TemplateResult {
  return renderSettingsPage(
    html`
      <section class="plugin-catalog-results" aria-labelledby="plugin-catalog-results-title">
        <header class="plugin-catalog-results__header">
          <div>
            <h2 id="plugin-catalog-results-title">${t("pluginsPage.exploreTitle")}</h2>
            <p>${t("pluginsPage.exploreDescription")}</p>
          </div>
        </header>
        ${
          props.loading
            ? renderSettingsLoadingSkeleton({
                label: t("pluginsPage.loadingDiscovery"),
                rows: 4,
                carapace: true,
              })
            : props.error
              ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
                  <span>${formatUiExternalText(props.error)}</span>
                  <button
                    type="button"
                    class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                    @click=${props.onRetry}
                  >
                    ${t("pluginsPage.tryAgain")}
                  </button>
                </div>`
              : !props.connected
                ? html`<p class="plugin-catalog-results__empty">
                    ${t("pluginsPage.discoveryOffline")}
                  </p>`
                : props.result && props.result.items.length === 0
                  ? html`<p class="plugin-catalog-results__empty">
                      ${t("pluginsPage.noDiscoveryResults")}
                    </p>`
                  : html`<div class="plugin-catalog-results__list">
                      ${repeat(
                        props.result?.items ?? [],
                        (plugin) => plugin.id,
                        (plugin) => {
                          const popularity = formatCount(plugin.catalog.downloads);
                          return html`<article class="plugin-catalog-result oc-card">
                            <span class="plugin-catalog-result__icon" aria-hidden="true"
                              >${icons.puzzle}</span
                            >
                            <div class="plugin-catalog-result__identity">
                              <h3>${plugin.catalog.name}</h3>
                              <p>
                                ${plugin.catalog.summary || t("pluginsPage.optionalCapability")}
                              </p>
                              <div class="plugin-catalog-result__meta">
                                ${
                                  plugin.catalog.author
                                    ? html`<span>@${plugin.catalog.author}</span>`
                                    : null
                                }
                                ${
                                  plugin.catalog.official
                                    ? html`<span>${t("pluginsPage.official")}</span>`
                                    : null
                                }
                                ${
                                  popularity
                                    ? html`<span
                                        >${t("pluginsPage.downloadCount", { count: popularity })}</span
                                      >`
                                    : null
                                }
                              </div>
                            </div>
                            <span class="plugin-catalog-result__state">
                              ${
                                plugin.local.installed
                                  ? t("pluginsPage.installed")
                                  : t("pluginsPage.available")
                              }
                            </span>
                          </article>`;
                        },
                      )}
                    </div>`
        }
      </section>
    `,
    { wide: true, carapace: true },
  );
}
