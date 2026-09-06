import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import {
  renderPluginAuthor,
  renderPluginCardIdentity,
  renderPluginCardSummary,
  renderPluginOfficialBadge,
} from "./plugin-card.ts";

export type PluginDiscoveryIntent = "all" | "bundled" | "trending" | "official";

export type PluginCatalogResultsProps = {
  connected: boolean;
  loading: boolean;
  paging: boolean;
  pageNumber: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  result: PluginDiscoveryResult | null;
  error: string | null;
  remoteError: string | null;
  categories: readonly PluginDiscoveryCategory[];
  categoriesError: string | null;
  featured: readonly PluginDiscoveryEntry[];
  featuredLoading: boolean;
  featuredError: string | null;
  intent: PluginDiscoveryIntent;
  category: string | null;
  query: string;
  iconUrls: Readonly<Record<string, string>>;
  entryHref: (id: string) => string;
  onIntentChange: (intent: PluginDiscoveryIntent) => void;
  onCategoryChange: (category: string | null) => void;
  onQueryChange: (query: string) => void;
  onOpenEntry: (id: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onRetry: () => void;
  onRetryCategories: () => void;
  onRetryFeatured: () => void;
};

const CATEGORY_ICONS: Readonly<Record<string, TemplateResult>> = {
  activity: icons.activity,
  "book-open": icons.book,
  brain: icons.brain,
  database: icons.box,
  "git-branch": icons.gitPullRequest,
  globe: icons.globe,
  "message-circle": icons.messageSquare,
  "message-square": icons.messageSquare,
  package: icons.box,
  palette: icons.wandSparkles,
  shield: icons.shield,
  wrench: icons.settings,
};

function categoryIcon(icon: string | undefined): TemplateResult {
  return (icon && CATEGORY_ICONS[icon]) || icons.box;
}

function renderCatalogIcon(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  const blobUrl = plugin.catalog.imageUrl ? props.iconUrls[plugin.catalog.imageUrl] : undefined;
  return blobUrl ? html`<img src=${blobUrl} alt="" />` : categoryIcon(plugin.catalog.icon);
}

export function formatCompactCount(value: number): string {
  if (value < 1_000) {
    return new Intl.NumberFormat().format(value);
  }
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 100 ? Math.round(millions) : Number(millions.toFixed(1))}m`;
}

function renderDownloadCount(
  downloads: number | undefined,
  options: { compact?: boolean } = {},
): TemplateResult | typeof nothing {
  if (downloads === undefined) {
    return nothing;
  }
  const count = formatCompactCount(downloads);
  return html`<span
    class="plugin-download-count"
    aria-label=${t("pluginsPage.downloadCount", { count })}
  >
    <span aria-hidden="true">${icons.download}</span>
    ${options.compact ? count : t("pluginsPage.downloadCount", { count })}
  </span>`;
}

function renderPopularity(plugin: PluginDiscoveryEntry): TemplateResult | typeof nothing {
  if (plugin.catalog.publishedToClawHub === false && plugin.catalog.downloads === undefined) {
    return html`<span class="plugin-download-count plugin-download-count--unavailable">—</span>`;
  }
  return renderDownloadCount(plugin.catalog.downloads, { compact: true });
}

function renderFeaturedCard(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  return html`<article
    class="plugin-featured-card oc-card oc-card-interactive"
    data-plugin-id=${plugin.id}
  >
    <a
      class="plugin-featured-card__primary-link"
      href=${props.entryHref(plugin.id)}
      aria-label=${plugin.catalog.name}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onOpenEntry(plugin.id);
      }}
    ></a>
    <div class="installed-plugins-card__head">
      <span class="installed-plugins-card__art plugin-featured-card__art" aria-hidden="true">
        ${renderCatalogIcon(plugin, props)}
      </span>
      ${renderPluginCardIdentity({
        name: plugin.catalog.name,
        attribution: {
          ...(plugin.catalog.author ? { author: plugin.catalog.author } : {}),
          official: plugin.catalog.official,
        },
        linkedAuthor: true,
      })}
    </div>
    ${renderPluginCardSummary(plugin.catalog.summary || t("pluginsPage.optionalCapability"))}
    <div class="plugin-featured-card__footer">${renderDownloadCount(plugin.catalog.downloads)}</div>
  </article>`;
}

function renderFeatured(props: PluginCatalogResultsProps): TemplateResult {
  return html`<section class="plugin-featured" aria-labelledby="plugin-featured-title">
    <header class="plugin-catalog-results__header">
      <div>
        <h2 id="plugin-featured-title">${t("pluginsPage.featuredTitle")}</h2>
      </div>
    </header>
    ${
      props.featuredLoading
        ? renderSettingsLoadingSkeleton({
            label: t("pluginsPage.loadingFeatured"),
            rows: 3,
            carapace: true,
          })
        : props.featuredError
          ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
              <span>${formatUiExternalText(props.featuredError)}</span>
              <button
                type="button"
                class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                @click=${props.onRetryFeatured}
              >
                ${t("pluginsPage.tryAgain")}
              </button>
            </div>`
          : props.featured.length === 0
            ? html`<p class="plugin-catalog-results__empty">
                ${t("pluginsPage.noFeaturedResults")}
              </p>`
            : html`<div class="plugin-featured__grid">
                ${repeat(
                  props.featured,
                  (plugin) => plugin.id,
                  (plugin) => renderFeaturedCard(plugin, props),
                )}
              </div>`
    }
  </section>`;
}

function renderCategories(props: PluginCatalogResultsProps): TemplateResult {
  if (props.categoriesError) {
    return html`<div class="plugin-catalog-categories__error" role="alert">
      <span>${formatUiExternalText(props.categoriesError)}</span>
      <button
        type="button"
        class="btn btn--xs oc-action oc-action-ghost"
        @click=${props.onRetryCategories}
      >
        ${t("pluginsPage.tryAgain")}
      </button>
    </div>`;
  }
  return html`<aside
    class="plugin-catalog-categories"
    aria-label=${t("pluginsPage.categoriesLabel")}
  >
    <h3>${t("pluginsPage.categoriesTitle")}</h3>
    <button
      type="button"
      class="plugin-catalog-category ${props.category === null ? "is-active" : ""}"
      aria-pressed=${props.category === null}
      @click=${() => props.onCategoryChange(null)}
    >
      <span aria-hidden="true">${icons.layoutGrid}</span>
      <span>${t("pluginsPage.allCategories")}</span>
    </button>
    ${repeat(
      props.categories.toSorted((left, right) => left.order - right.order),
      (item) => item.slug,
      (item) => html`<button
        type="button"
        class="plugin-catalog-category ${props.category === item.slug ? "is-active" : ""}"
        aria-pressed=${props.category === item.slug}
        @click=${() => props.onCategoryChange(item.slug)}
      >
        <span aria-hidden="true">${categoryIcon(item.icon)}</span>
        <span>${item.label}</span>
      </button>`,
    )}
  </aside>`;
}

function renderCategorySelect(props: PluginCatalogResultsProps): TemplateResult | typeof nothing {
  if (props.categoriesError) {
    return nothing;
  }
  return html`<label class="plugin-catalog-category-select">
    <span aria-hidden="true">${icons.layoutGrid}</span>
    <select
      class="oc-input"
      aria-label=${t("pluginsPage.categoriesLabel")}
      .value=${props.category ?? ""}
      @change=${(event: Event) => {
        if (event.currentTarget instanceof HTMLSelectElement) {
          props.onCategoryChange(event.currentTarget.value || null);
        }
      }}
    >
      <option value="">${t("pluginsPage.allCategories")}</option>
      ${repeat(
        props.categories.toSorted((left, right) => left.order - right.order),
        (item) => item.slug,
        (item) => html`<option value=${item.slug}>${item.label}</option>`,
      )}
    </select>
  </label>`;
}

function renderResultRow(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  return html`<article class="plugin-catalog-result" data-plugin-id=${plugin.id}>
    <a
      class="plugin-catalog-result__primary-link"
      href=${props.entryHref(plugin.id)}
      aria-label=${plugin.catalog.name}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onOpenEntry(plugin.id);
      }}
    ></a>
    <span class="plugin-catalog-result__icon" aria-hidden="true">
      ${renderCatalogIcon(plugin, props)}
    </span>
    <div class="plugin-catalog-result__identity">
      <div class="plugin-catalog-result__title-row">
        <h3>${plugin.catalog.name}</h3>
        ${renderPluginAuthor(plugin.catalog.author, { linked: true })}
        ${plugin.catalog.official ? renderPluginOfficialBadge() : nothing}
      </div>
      <p>${plugin.catalog.summary || t("pluginsPage.optionalCapability")}</p>
    </div>
    ${renderPopularity(plugin)}
  </article>`;
}

function intentLabel(intent: PluginDiscoveryIntent): string {
  if (intent === "bundled") {
    return t("pluginsPage.intentBundled");
  }
  if (intent === "trending") {
    return t("pluginsPage.intentTrending");
  }
  if (intent === "official") {
    return t("pluginsPage.intentOfficial");
  }
  return t("pluginsPage.intentAll");
}

function renderExplorer(props: PluginCatalogResultsProps): TemplateResult {
  const visibleItems = props.result?.items ?? [];
  return html`
    <section class="plugin-catalog-results" aria-labelledby="plugin-catalog-results-title">
      <header class="plugin-catalog-results__header">
        <div>
          <h2 id="plugin-catalog-results-title">${t("pluginsPage.exploreTitle")}</h2>
        </div>
      </header>
      <div class="plugin-catalog-controls">
        ${renderHubTabs({
          id: "plugin-catalog-intents",
          active: props.intent,
          tabs: (["all", "bundled", "trending", "official"] as const).map((intent) => ({
            value: intent,
            label: intentLabel(intent),
          })),
          ariaLabel: t("pluginsPage.viewsLabel"),
          panelId: "plugin-catalog-results-panel",
          className: "plugin-catalog-intents",
          carapace: true,
          variant: "sub",
          onSelect: props.onIntentChange,
        })}
        <label class="plugin-catalog-search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            class="oc-input"
            aria-label=${t("pluginsPage.searchPlugins")}
            placeholder=${t("pluginsPage.searchPlugins")}
            .value=${props.query}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onQueryChange(event.currentTarget.value);
              }
            }}
          />
        </label>
      </div>
      <div
        id="plugin-catalog-results-panel"
        class="plugin-catalog-layout"
        role="tabpanel"
        aria-labelledby=${`plugin-catalog-intents-tab-${props.intent}`}
      >
        ${renderCategorySelect(props)} ${renderCategories(props)}
        <div class="plugin-catalog-layout__results">
          ${
            props.remoteError
              ? html`<div class="callout warning oc-banner" role="status">
                  ${formatUiExternalText(props.remoteError)}
                </div>`
              : nothing
          }
          ${
            props.loading
              ? renderSettingsLoadingSkeleton({
                  label: t("pluginsPage.loadingDiscovery"),
                  rows: 6,
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
                  : visibleItems.length === 0
                    ? html`<p class="plugin-catalog-results__empty">
                        ${t("pluginsPage.noDiscoveryResults")}
                      </p>`
                    : html`<div class="plugin-catalog-results__table">
                        <div class="plugin-catalog-results__list-header" aria-hidden="true">
                          <span></span>
                          <span>${t("pluginsPage.catalogPluginColumn")}</span>
                          <span>${t("pluginsPage.catalogDownloadsColumn")}</span>
                        </div>
                        <div class="plugin-catalog-results__list">
                          ${repeat(
                            visibleItems,
                            (plugin) => plugin.id,
                            (plugin) => renderResultRow(plugin, props),
                          )}
                        </div>
                      </div>`
          }
          ${
            props.canGoPrevious || props.canGoNext
              ? html`<nav
                  class="plugin-catalog-pagination"
                  aria-label=${t("pluginsPage.catalogPaginationLabel")}
                >
                  ${
                    props.canGoPrevious
                      ? html`<button
                          type="button"
                          class="btn btn--sm oc-action oc-action-ghost"
                          ?disabled=${props.paging}
                          @click=${props.onPreviousPage}
                        >
                          ${t("pluginsPage.previousPage")}
                        </button>`
                      : nothing
                  }
                  <span aria-live="polite">
                    ${t("pluginsPage.pageNumber", { page: String(props.pageNumber) })}
                  </span>
                  <button
                    type="button"
                    class="btn btn--sm oc-action oc-action-ghost"
                    ?disabled=${props.paging || !props.canGoNext}
                    @click=${props.onNextPage}
                  >
                    ${t("pluginsPage.nextPage")}
                  </button>
                </nav>`
              : nothing
          }
        </div>
      </div>
    </section>
  `;
}

export function renderPluginCatalogResults(props: PluginCatalogResultsProps): TemplateResult {
  return html`${renderFeatured(props)}${renderExplorer(props)}`;
}
