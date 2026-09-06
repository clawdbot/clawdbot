import { html, nothing } from "lit";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { analyzeConfigSchema } from "../../components/config-form.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import type {
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail, type PluginCatalogDetailTab } from "./catalog-detail.ts";
import { renderPluginCatalogResults } from "./catalog-results.ts";
import { renderPluginConsentDialog } from "./consent-dialog.ts";
import type { InstallWizardController } from "./install-wizard-controller.ts";
import {
  installRequestForDiscoveryDetail,
  type PluginInstallWizardState,
} from "./install-wizard-model.ts";
import { renderPluginInstallWizard } from "./install-wizard.ts";
import { renderInstalledPlugins } from "./installed-plugins.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";
import type { PluginRowMessage } from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";
import { renderPluginsHubHeader } from "./plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
import type { PluginsRouteData } from "./route-data.ts";
import { pluginAdvancedSchema, pluginConfigSchema } from "./settings-model.ts";
import {
  renderPluginSettingsDetail,
  renderPluginSettingsInventory,
  type PluginSettingsTab,
} from "./settings-view.ts";

type CatalogDetailState = {
  id: string;
  result: PluginDiscoveryDetailResult | null;
  error: string | null;
};

type InstalledDetailState = {
  pluginId: string;
  inspection: PluginsInspectResult | null;
  error: string | null;
};

type PluginsPageViewActions = {
  selectHubTab: (tab: PluginsHubTab) => void;
  closeCatalogDetail: () => void;
  retryCatalogDetail: () => void;
  selectCatalogDetailTab: (tab: PluginCatalogDetailTab) => void;
  setInventoryExpanded: (expanded: boolean) => void;
  setInventorySearchOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  refreshCatalog: () => void;
  openPluginSettings: (pluginId: string | null, fromDiscovery: boolean) => void;
  handlePluginIconError: (pluginId: string) => void;
  updateEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  uninstall: (pluginId: string, rowKey: string) => void;
  patchConfig: (path: Array<string | number>, value: unknown) => void;
  removeConfig: (path: Array<string | number>) => void;
  reloadConfig: () => void;
  closeSettingsDetail: (parentRoute: "plugins" | "plugin-settings") => void;
  retrySettingsDetail: (pluginId: string) => void;
  selectSettingsTab: (tab: PluginSettingsTab) => void;
};

export type PluginsPageViewModel = {
  context: ApplicationContext;
  routeData?: PluginsRouteData;
  surface: "discovery" | "settings";
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  query: string;
  settingsTab: PluginSettingsTab;
  inventoryExpanded: boolean;
  inventorySearchOpen: boolean;
  busy: Record<string, boolean>;
  messages: Record<string, PluginRowMessage>;
  detail: InstalledDetailState | null;
  iconUrls: Record<string, string>;
  catalogIconUrls: Record<string, string>;
  pageNotice: PluginRowMessage | null;
  catalogDetail: CatalogDetailState | null;
  catalogDetailTab: PluginCatalogDetailTab;
  installWizard: PluginInstallWizardState | null;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  canEditConfig: boolean;
  discovery: PluginDiscoveryController;
  consentController: PluginsConsentController;
  installWizardController: InstallWizardController;
  actions: PluginsPageViewActions;
};

export function renderPluginsPage(model: PluginsPageViewModel) {
  const {
    actions,
    catalogDetail,
    consentController,
    context,
    detail,
    discovery,
    installWizard,
    installWizardController,
  } = model;
  const configState = context.runtimeConfig.state;
  const configAnalysis = analyzeConfigSchema(configState.configSchema);
  const installWizardConfigSchema = installWizard?.pluginId
    ? pluginConfigSchema(configAnalysis.schema, installWizard.pluginId)
    : null;
  const detailPluginId = detail?.pluginId ?? null;
  const settingsParentRoute =
    new URLSearchParams(model.routeData?.location.search ?? "").get("from") === "plugins"
      ? "plugins"
      : "plugin-settings";
  const settingsShared = {
    connected: model.connected,
    loading: model.loading,
    result: model.result,
    error: model.error,
    busy: model.busy,
    messages: model.messages,
    pageNotice: model.pageNotice,
    iconUrls: model.iconUrls,
    canMutate: model.canMutate,
    mutationBlockedReason: model.mutationBlockedReason,
    configBusy: configState.configLoading || configState.configSaving,
    configError: configState.lastError,
    canEditConfig: model.canEditConfig,
    configValue: configState.configForm,
    configHints: configState.configUiHints,
    configSchemaLoading: configState.configSchemaLoading,
    configUnsupportedPaths: configAnalysis.unsupportedPaths,
    onIconError: actions.handlePluginIconError,
    onSetEnabled: actions.updateEnabled,
    onUninstall: actions.uninstall,
    onConfigPatch: actions.patchConfig,
    onConfigRemove: actions.removeConfig,
    onConfigReload: actions.reloadConfig,
    onRefresh: actions.refreshCatalog,
  };

  return html`
    ${
      model.surface === "discovery" && !catalogDetail
        ? renderPluginsHubHeader({ active: "plugins", onSelect: actions.selectHubTab })
        : nothing
    }
    ${renderSettingsWorkspace(html`
      ${
        model.surface === "discovery"
          ? html`<wa-tab-panel
              id=${PLUGINS_HUB_PANEL_ID}
              name="plugins"
              active
              aria-labelledby="plugins-tab-plugins"
              >${
                catalogDetail
                  ? renderPluginCatalogDetail({
                      connected: model.connected,
                      result: catalogDetail.result,
                      error: catalogDetail.error,
                      tab: model.catalogDetailTab,
                      backHref: pathForRoute("plugins", context.basePath),
                      onBack: actions.closeCatalogDetail,
                      onRetry: actions.retryCatalogDetail,
                      onTabChange: actions.selectCatalogDetailTab,
                      canInstall:
                        model.canMutate &&
                        Boolean(
                          catalogDetail.result &&
                          installRequestForDiscoveryDetail(catalogDetail.result),
                        ),
                      installBlockedReason: model.mutationBlockedReason,
                      onInstall: () => {
                        if (catalogDetail.result) {
                          installWizardController.open(catalogDetail.result);
                        }
                      },
                      iconUrls: model.catalogIconUrls,
                    })
                  : renderSettingsPage(
                      html`${renderInstalledPlugins({
                        connected: model.connected,
                        loading: model.loading,
                        result: model.result,
                        error: model.error,
                        expanded: model.inventoryExpanded,
                        searchOpen: model.inventorySearchOpen,
                        query: model.query,
                        iconUrls: model.iconUrls,
                        attributions: discovery.attributions,
                        onExpandedChange: actions.setInventoryExpanded,
                        onSearchOpenChange: actions.setInventorySearchOpen,
                        onQueryChange: actions.setQuery,
                        onRefresh: actions.refreshCatalog,
                        settingsHref: (pluginId) =>
                          `${pathForPluginSettings(pluginId, context.basePath)}?from=plugins`,
                        onOpenSettings: (pluginId) =>
                          actions.openPluginSettings(pluginId ?? null, true),
                        onIconError: actions.handlePluginIconError,
                      })}${renderPluginCatalogResults({
                        connected: model.connected,
                        loading: discovery.loading,
                        paging: discovery.paging,
                        pageNumber: discovery.pageNumber,
                        canGoPrevious: discovery.canGoPrevious,
                        canGoNext: discovery.canGoNext,
                        result: discovery.result,
                        error: discovery.error,
                        remoteError: discovery.remoteError,
                        categories: discovery.categories,
                        categoriesError: discovery.categoriesError,
                        featured: discovery.featured,
                        featuredLoading: discovery.featuredLoading,
                        featuredError: discovery.featuredError,
                        intent: discovery.intent,
                        category: discovery.category,
                        query: discovery.query,
                        iconUrls: model.catalogIconUrls,
                        entryHref: (id) => pathForPluginCatalogEntry(id, context.basePath),
                        onIntentChange: (intent) => discovery.selectIntent(intent),
                        onCategoryChange: (category) => discovery.selectCategory(category),
                        onQueryChange: (query) => discovery.updateQuery(query),
                        onOpenEntry: (id) =>
                          context.navigate("plugins", {
                            pathname: pathForPluginCatalogEntry(id, context.basePath),
                          }),
                        onPreviousPage: () => void discovery.previousPage(),
                        onNextPage: () => void discovery.nextPage(),
                        onRetry: () => void discovery.refresh(),
                        onRetryCategories: () => void discovery.refreshCategories(),
                        onRetryFeatured: () => void discovery.refreshFeatured(),
                      })}`,
                      { wide: true, carapace: true },
                    )
              }</wa-tab-panel
            >`
          : detailPluginId
            ? renderPluginSettingsDetail({
                ...settingsShared,
                pluginId: detailPluginId,
                inspection: detail?.inspection ?? null,
                inspectionError: detail?.error ?? null,
                configSchema: pluginConfigSchema(configAnalysis.schema, detailPluginId),
                backHref: pathForRoute(settingsParentRoute, context.basePath),
                backLabel:
                  settingsParentRoute === "plugins" ? t("tabs.plugins") : t("nav.settings"),
                onBack: () => actions.closeSettingsDetail(settingsParentRoute),
                onRetryInspection: () => actions.retrySettingsDetail(detailPluginId),
              })
            : renderPluginSettingsInventory({
                ...settingsShared,
                tab: model.settingsTab,
                query: model.query,
                advancedSchema: pluginAdvancedSchema(configAnalysis.schema),
                onTabChange: actions.selectSettingsTab,
                onQueryChange: actions.setQuery,
                pluginHref: (pluginId) => pathForPluginSettings(pluginId, context.basePath),
                onOpenPlugin: (pluginId) => actions.openPluginSettings(pluginId, false),
              })
      }
    `)}
    ${
      installWizard
        ? renderPluginInstallWizard({
            state: installWizard,
            mutationBlockedReason: model.mutationBlockedReason,
            canMutate: model.canMutate,
            busy: Object.values(model.busy).some(Boolean),
            configSchema: installWizardConfigSchema,
            configSchemaLoading: configState.configSchemaLoading,
            configValue: configState.configForm,
            configHints: configState.configUiHints,
            configUnsupportedPaths: configAnalysis.unsupportedPaths,
            configBusy: configState.configLoading || configState.configSaving,
            configError: configState.lastError,
            canEditConfig: model.canEditConfig,
            onClose: () => installWizardController.close(),
            onInstall: () => installWizardController.begin(),
            onContinuePolicyWarning: () => installWizardController.continuePolicyWarning(),
            onRetry: () => installWizardController.retry(),
            onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
            onConfigRemove: (path) => context.runtimeConfig.removeFormValue(path),
            onSaveConfiguration: () => void installWizardController.saveConfiguration(),
            onManage: () => installWizardController.manage(),
          })
        : nothing
    }
    ${
      consentController.consent
        ? renderPluginConsentDialog({
            consent: consentController.consent,
            inspection: consentController.inspection,
            loading: consentController.inspectionLoading,
            error: consentController.inspectionError,
            iconUrl: consentController.consent.pluginId
              ? model.iconUrls[consentController.consent.pluginId]
              : undefined,
            canMutate: model.canMutate,
            mutationBlockedReason: model.mutationBlockedReason,
            busy: Object.values(model.busy).some(Boolean),
            onCancel: () => installWizardController.cancelConsent(),
            onConfirm: () => consentController.confirm(),
            onRetry: () => void consentController.inspect(),
          })
        : nothing
    }
  `;
}
