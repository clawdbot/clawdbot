import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  renderArtTile,
  renderPluginConsentDialog,
  type PluginConsentState,
} from "./consent-dialog.ts";
import { renderPluginCardIdentity, type PluginCardAttribution } from "./plugin-card.ts";
const INSTALLED_PLUGINS_INITIAL_LIMIT = 9;

/** Enabled plugins form the first alphabetical group; all disabled states follow. */
function prioritizeInstalledPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins
    .filter((plugin) => plugin.installed)
    .toSorted(
      (left, right) =>
        Number(right.enabled) - Number(left.enabled) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

function matchesPlugin(plugin: PluginCatalogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.category,
    plugin.origin,
    ...(plugin.kind ?? []),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export type InstalledPluginsProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  expanded: boolean;
  searchOpen: boolean;
  query: string;
  busy: Record<string, boolean>;
  iconUrls: Record<string, string>;
  attributions?: ReadonlyMap<string, PluginCardAttribution>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  consent: PluginConsentState | null;
  consentInspection: PluginsInspectResult | null;
  consentInspectionLoading: boolean;
  consentInspectionError: string | null;
  onExpandedChange: (expanded: boolean) => void;
  onSearchOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  settingsHref: (pluginId: string) => string;
  onOpenSettings: (pluginId?: string) => void;
  onIconError: (pluginId: string) => void;
  onCancelConsent: () => void;
  onConfirmConsent: () => void;
  onRetryConsentInspection: () => void;
};

function renderCard(plugin: PluginCatalogItem, props: InstalledPluginsProps): TemplateResult {
  const open = () => props.onOpenSettings(plugin.id);
  const attribution = props.attributions?.get(plugin.id) ?? { official: false };
  return html`
    <a
      class="installed-plugins-card oc-card oc-card-interactive"
      data-plugin-id=${plugin.id}
      data-plugin-status=${plugin.state}
      href=${props.settingsHref(plugin.id)}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        open();
      }}
    >
      <div class="installed-plugins-card__head">
        ${renderArtTile(
          plugin.id,
          plugin.name,
          props.iconUrls[plugin.id],
          () => props.onIconError(plugin.id),
          "installed-plugins-card__art",
        )}
        ${renderPluginCardIdentity({
          name: plugin.name,
          attribution,
          showAuthor: false,
          subtitle: plugin.description || t("pluginsPage.optionalCapability"),
        })}
      </div>
      ${
        plugin.error
          ? html`<p class="installed-plugins-card__error" role="alert">
              ${formatUiExternalText(plugin.error)}
            </p>`
          : plugin.state === "needs-setup"
            ? html`<p
                class="installed-plugins-card__message installed-plugins-card__message--warning"
              >
                ${t("pluginsPage.setupRequired")}
              </p>`
            : nothing
      }
    </a>
  `;
}

export function renderInstalledPlugins(props: InstalledPluginsProps): TemplateResult {
  const installed = prioritizeInstalledPlugins(props.result?.plugins ?? []);
  const filtered = props.searchOpen
    ? installed.filter((plugin) => matchesPlugin(plugin, props.query))
    : installed;
  const visible =
    props.searchOpen || props.expanded
      ? filtered
      : filtered.slice(0, INSTALLED_PLUGINS_INITIAL_LIMIT);
  const consentKey = props.consent
    ? props.consent.intent.kind === "install"
      ? props.consent.intent.installIdentity
      : props.consent.intent.rowKey
    : null;
  const closeSearch = (source: Element) => {
    const actions = source.closest(".installed-plugins__actions");
    props.onSearchOpenChange(false);
    queueMicrotask(() => {
      actions?.querySelector<HTMLButtonElement>(".installed-plugins__search-trigger")?.focus();
    });
  };

  return html`${renderSettingsPage(
    html`
      <section class="installed-plugins" aria-labelledby="installed-plugins-title">
        <header class="installed-plugins__header">
          <div>
            <h2 id="installed-plugins-title">${t("pluginsPage.installedPluginsTitle")}</h2>
          </div>
          <div class="installed-plugins__actions">
            ${
              props.searchOpen
                ? html`<div class="installed-plugins__search">
                    <span class="installed-plugins__search-icon" aria-hidden="true"
                      >${icons.search}</span
                    >
                    <input
                      type="search"
                      class="oc-input"
                      aria-label=${t("pluginsPage.searchLabel")}
                      .value=${props.query}
                      placeholder=${t("pluginsPage.searchInstalledPlaceholder")}
                      ${ref((element) => {
                        if (
                          element instanceof HTMLInputElement &&
                          document.activeElement !== element
                        ) {
                          queueMicrotask(() => {
                            if (element.isConnected) {
                              element.focus();
                            }
                          });
                        }
                      })}
                      @input=${(event: Event) => {
                        if (event.currentTarget instanceof HTMLInputElement) {
                          props.onQueryChange(event.currentTarget.value);
                        }
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          if (event.currentTarget instanceof HTMLInputElement) {
                            closeSearch(event.currentTarget);
                          }
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="btn btn--xs btn--icon installed-plugins__icon-action installed-plugins__search-close oc-action oc-action-icon oc-action-ghost"
                      aria-label=${t("common.close")}
                      @click=${(event: MouseEvent) => {
                        if (event.currentTarget instanceof HTMLElement) {
                          closeSearch(event.currentTarget);
                        }
                      }}
                    >
                      ${icons.x}
                    </button>
                  </div>`
                : html`<button
                    type="button"
                    class="btn btn--sm btn--icon installed-plugins__icon-action installed-plugins__search-trigger oc-action oc-action-icon oc-action-ghost"
                    aria-label=${t("pluginsPage.searchLabel")}
                    aria-expanded="false"
                    @click=${() => props.onSearchOpenChange(true)}
                  >
                    ${icons.search}
                  </button>`
            }
            <button
              type="button"
              class="btn btn--sm btn--icon installed-plugins__icon-action oc-action oc-action-icon oc-action-ghost"
              aria-label=${t("pluginsPage.pluginSettings")}
              @click=${() => props.onOpenSettings()}
            >
              ${icons.settings}
            </button>
          </div>
        </header>
        ${
          props.loading
            ? renderSettingsLoadingSkeleton({
                label: t("pluginsPage.loading"),
                rows: 6,
                carapace: true,
              })
            : props.error
              ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
                  <span>${props.error}</span>
                  <button
                    type="button"
                    class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                    @click=${props.onRefresh}
                  >
                    ${t("pluginsPage.tryAgain")}
                  </button>
                </div>`
              : !props.connected
                ? renderSettingsEmpty(t("pluginsPage.offlineBody"), { carapace: true })
                : visible.length === 0
                  ? renderSettingsEmpty(
                      props.query
                        ? t("pluginsPage.noInstalledMatchTitle")
                        : t("pluginsPage.noInstalledTitle"),
                      { carapace: true },
                    )
                  : html`<div class="installed-plugins__grid">
                      ${repeat(
                        visible,
                        (plugin) => plugin.id,
                        (plugin) => renderCard(plugin, props),
                      )}
                    </div>`
        }
        ${
          !props.searchOpen &&
          (installed.length > INSTALLED_PLUGINS_INITIAL_LIMIT || props.expanded)
            ? html`<div class="installed-plugins__more">
                <button
                  type="button"
                  class="btn btn--sm installed-plugins__more-action oc-action oc-action-ghost"
                  @click=${() => props.onExpandedChange(!props.expanded)}
                >
                  ${
                    props.expanded
                      ? t("pluginsPage.hideInstalledPlugins")
                      : t("pluginsPage.showAllPlugins", { count: String(installed.length) })
                  }
                </button>
              </div>`
            : nothing
        }
      </section>
    `,
    { wide: true, carapace: true },
  )}
  ${
    props.consent
      ? renderPluginConsentDialog({
          consent: props.consent,
          inspection: props.consentInspection,
          loading: props.consentInspectionLoading,
          error: props.consentInspectionError,
          iconUrl: props.consent.pluginId ? props.iconUrls[props.consent.pluginId] : undefined,
          canMutate: props.canMutate,
          mutationBlockedReason: props.mutationBlockedReason,
          busy: consentKey ? Boolean(props.busy[consentKey]) : false,
          onCancel: props.onCancelConsent,
          onConfirm: props.onConfirmConsent,
          onRetry: props.onRetryConsentInspection,
        })
      : nothing
  }`;
}
