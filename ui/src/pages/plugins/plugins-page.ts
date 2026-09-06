import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { RouteLocation } from "@openclaw/uirouter";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  pathForPluginSettings,
  pathForRoute,
  pluginSettingsIdFromPath,
} from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { analyzeConfigSchema } from "../../components/config-form.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import {
  uninstallPlugin,
  type PluginCatalogItem,
  type PluginDiscoveryResult,
  type PluginListResult,
  type PluginMutationResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/plugins.css";
import { renderPluginCatalogResults } from "./catalog-results.ts";
import { renderPluginConsentDialog } from "./consent-dialog.ts";
import { renderInstalledPlugins } from "./installed-plugins.ts";
import { PluginIconController } from "./plugin-icon-controller.ts";
import { confirmPluginUninstall } from "./plugin-lifecycle-confirmation.ts";
import type { PluginRowMessage } from "./plugin-row-message.ts";
import { PluginsConsentController } from "./plugins-consent-controller.ts";
import { renderPluginsHubHeader } from "./plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";
import { pluginAdvancedSchema, pluginConfigSchema } from "./settings-model.ts";
import {
  renderPluginSettingsDetail,
  renderPluginSettingsInventory,
  type PluginSettingsTab,
} from "./settings-view.ts";

type PluginsPageSurface = "discovery" | "settings";

export type PluginsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  result: PluginListResult | null;
  error: string | null;
  location: RouteLocation;
};

function withPlugin(
  current: PluginListResult | null,
  plugin: PluginCatalogItem,
): PluginListResult | null {
  if (!current) {
    return current;
  }
  const existingIndex = current.plugins.findIndex((entry) => entry.id === plugin.id);
  const plugins = [...current.plugins];
  if (existingIndex >= 0) {
    plugins[existingIndex] = plugin;
  } else {
    plugins.push(plugin);
  }
  return { ...current, plugins };
}

export class PluginsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: PluginsRouteData;
  @property({ attribute: false }) surface: PluginsPageSurface = "settings";

  @state() private result: PluginListResult | null = null;
  @state() private error: string | null = null;
  @state() private discoveryResult: PluginDiscoveryResult | null = null;
  @state() private discoveryError: string | null = null;
  @state() private query = "";
  @state() private settingsTab: PluginSettingsTab = "installed";
  @state() private inventoryExpanded = false;
  @state() private inventorySearchOpen = false;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, PluginRowMessage> = {};
  @state() private detail: {
    pluginId: string;
    inspection: PluginsInspectResult | null;
    error: string | null;
  } | null = null;
  @state() private iconUrls: Record<string, string> = {};
  @state() private pageNotice: PluginRowMessage | null = null;
  private configAutoSaveStatus = this.context?.runtimeConfig.state.configAutoSaveStatus ?? "idle";
  private pluginConfigEditPending = false;
  private routeDataConsumed = false;
  private preserveMessageKeyOnReconnect: string | null = null;
  private iconAuthCandidates: string[] = [];
  private readonly pluginIcons = new PluginIconController({
    getFetchContext: () => ({
      resourceBasePath: this.context.resourceBasePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
    }),
    isConnected: () => this.isConnected,
    onUrlsChange: (urls) => {
      this.iconUrls = urls;
    },
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      const preservedKey = this.preserveMessageKeyOnReconnect;
      const preservedMessage = preservedKey ? this.messages[preservedKey] : undefined;
      this.preserveMessageKeyOnReconnect = null;
      this.result = null;
      this.error = null;
      this.discoveryResult = null;
      this.discoveryError = null;
      this.messages = preservedKey && preservedMessage ? { [preservedKey]: preservedMessage } : {};
      this.pageNotice = null;
    },
    invalidateRequests: (change) =>
      this.invalidateRequests(change.snapshot.phase !== "connected" || !change.snapshot.client),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });

  private readonly consentController = new PluginsConsentController({
    gateway: this.gateway,
    getContext: () => this.context,
    getResult: () => this.result,
    canMutate: () => this.canMutate(),
    isBusy: (rowKey) => Boolean(this.busy[rowKey]),
    setBusy: (rowKey, busy) => this.setBusy(rowKey, busy),
    setMessage: (rowKey, message) => this.setMessage(rowKey, message),
    clearPageNotice: () => {
      this.pageNotice = null;
    },
    closeDetails: () => {
      if (this.surface !== "settings") {
        this.detail = null;
      }
    },
    applyMutationResult: (result) => this.applyMutationResult(result),
    refreshCatalogAfterMutation: (client) => this.refreshCatalogAfterMutation(client),
    reconnectAfterMutation: (rowKey) => {
      // The reconnect refreshes hello-owned plugin tabs. Keep only its committed
      // outcome; unrelated Gateway identity changes still clear all row messages.
      this.preserveMessageKeyOnReconnect = rowKey;
      this.context.gateway.connect();
    },
    requestUpdate: () => this.requestUpdate(),
  });

  private readonly catalogTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client ? client.request<PluginListResult>("plugins.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.replaceResult(result);
      const routePluginId =
        this.surface === "settings"
          ? pluginSettingsIdFromPath(this.routeData?.location.pathname ?? "", this.context.basePath)
          : null;
      if (routePluginId && routePluginId !== this.detail?.pluginId) {
        void this.showDetails(routePluginId);
      }
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  private readonly discoveryTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client
        ? client.request<PluginDiscoveryResult>(
            "plugins.catalog.browse",
            { intent: "all", pageSize: 12 },
            { signal },
          )
        : initialState,
    onComplete: (result) => {
      this.discoveryResult = result;
    },
    onError: (error) => {
      this.discoveryError = formatUiError(error);
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => (this.surface === "settings" ? this.context?.runtimeConfig : null),
    (runtimeConfig) => {
      void runtimeConfig.ensureLoaded();
      void runtimeConfig.ensureSchemaLoaded();
      this.configAutoSaveStatus = runtimeConfig.state.configAutoSaveStatus;
      return runtimeConfig.subscribe(() => {
        const nextStatus = runtimeConfig.state.configAutoSaveStatus;
        const completedSave = this.configAutoSaveStatus === "saving" && nextStatus === "saved";
        this.configAutoSaveStatus = nextStatus;
        this.requestUpdate();
        if (completedSave && this.pluginConfigEditPending) {
          this.pluginConfigEditPending = false;
          void this.refreshCatalog();
        }
      });
    },
  );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.subscriptions.clear();
    this.pluginIcons.reset();
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (document.querySelector(".shell-nav[aria-modal='true']")) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }
    if (this.consentController.consent) {
      this.consentController.close();
      event.stopPropagation();
      return;
    }
    if (this.detail) {
      this.detail = null;
      if (this.surface === "settings") {
        this.context.replace("plugin-settings", {
          pathname: pathForRoute("plugin-settings", this.context.basePath),
        });
      }
      event.stopPropagation();
    }
  };

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    const nextIconAuthCandidates = resolveControlUiAuthCandidates({
      hello: snapshot.hello,
      settings: { token: this.context.gateway.connection.token },
      password: this.context.gateway.connection.password,
    });
    const iconAuthChanged =
      nextIconAuthCandidates.length !== this.iconAuthCandidates.length ||
      nextIconAuthCandidates.some(
        (candidate, index) => candidate !== this.iconAuthCandidates[index],
      );
    this.iconAuthCandidates = nextIconAuthCandidates;
    const shouldRefreshAfterChange =
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged) &&
      snapshot.phase === "connected" &&
      this.routeDataConsumed;
    if (
      !change.initial &&
      iconAuthChanged &&
      !change.identityChanged &&
      !change.connectionChanged
    ) {
      this.gateway.invalidate();
      this.invalidateRequests(snapshot.phase !== "connected" || !snapshot.client);
    }
    if (
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged)
    ) {
      this.pluginIcons.reset();
      this.busy = {};
    }
    if (shouldRefreshAfterChange) {
      void this.refreshCatalog();
      if (this.surface === "discovery") {
        void this.refreshDiscovery();
      }
    } else {
      this.ensureInitialData();
    }
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataConsumed = true;
    const detailPluginId =
      this.surface === "settings"
        ? pluginSettingsIdFromPath(data.location.pathname, this.context.basePath)
        : null;
    // Route location is UI state, not Gateway data. Apply it even when the
    // catalog snapshot is stale so deep links do not fall back to Installed.
    if (this.surface === "settings" && !detailPluginId) {
      this.settingsTab =
        new URLSearchParams(data.location.search).get("tab") === "advanced"
          ? "advanced"
          : "installed";
    }
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.ensureInitialData();
      return;
    }
    this.replaceResult(data.result);
    this.error = data.error;
    if (detailPluginId !== this.detail?.pluginId) {
      void this.showDetails(detailPluginId);
    }
    this.ensureInitialData();
  }

  private invalidateRequests(invalidateCatalog = true) {
    if (invalidateCatalog) {
      void this.catalogTask.run([null]);
      void this.discoveryTask.run([null]);
      this.discoveryResult = null;
      this.discoveryError = null;
    }
    // Inspection results belong to one connection epoch, including same-client reconnects.
    this.detail = null;
    this.consentController.reset();
  }

  private replaceResult(result: PluginListResult | null, preserveIcons = false) {
    if (preserveIcons) {
      this.pluginIcons.reconcile(result);
    } else {
      this.pluginIcons.reset();
    }
    this.result = result;
    this.pluginIcons.sync(result);
  }

  private get loading(): boolean {
    return (
      this.gateway.connected &&
      (!this.routeDataConsumed || this.catalogTask.status === TaskStatus.PENDING)
    );
  }

  private get discoveryLoading(): boolean {
    return this.gateway.connected && this.discoveryTask.status === TaskStatus.PENDING;
  }

  private ensureInitialData() {
    // The route owns initial loading; a warm page module can render before its data arrives.
    if (
      !this.routeDataConsumed ||
      !this.gateway.connected ||
      !this.gateway.client ||
      (this.routeData && !this.routeDataConsumed)
    ) {
      return;
    }
    if (!this.loading && !this.result && !this.error) {
      void this.refreshCatalog();
    }
    if (
      this.surface === "discovery" &&
      this.discoveryTask.status === TaskStatus.INITIAL &&
      !this.discoveryResult &&
      !this.discoveryError
    ) {
      void this.refreshDiscovery();
    }
  }

  private async refreshCatalog(): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private async refreshDiscovery(): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    this.discoveryError = null;
    await this.discoveryTask.run([client]);
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "plugins") {
      if (this.surface !== "discovery") {
        this.context.navigate("plugins");
      }
      return;
    }
    this.context.navigate("skills");
  }

  private mutationBlockedReason(): string | null {
    if (!this.gateway.connected) {
      return t("pluginsPage.connectToChange");
    }
    const auth = this.context.gateway.snapshot.hello?.auth ?? null;
    if (!hasOperatorAdminAccess(auth)) {
      return t("pluginsPage.adminRequired");
    }
    if (this.result && !this.result.mutationAllowed) {
      return t("pluginsPage.changesDisabled");
    }
    return null;
  }

  private canMutate(): boolean {
    return Boolean(this.result?.mutationAllowed) && this.mutationBlockedReason() === null;
  }

  private configBlockedReason(): string | null {
    const configState = this.context.runtimeConfig.state;
    if (!configState.connected) {
      return t("pluginsPage.connectToChange");
    }
    if (!hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null)) {
      return t("pluginsPage.adminRequired");
    }
    if (!this.context.runtimeConfig.canSet) {
      return t("pluginsPage.changesDisabled");
    }
    return null;
  }

  private canEditConfig(): boolean {
    return this.configBlockedReason() === null;
  }

  private setBusy(key: string, value: boolean) {
    const next = { ...this.busy };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.busy = next;
  }

  private setMessage(key: string, message: PluginRowMessage | null) {
    const next = { ...this.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.messages = next;
  }

  private applyMutationResult(result: PluginMutationResult) {
    this.pluginIcons.invalidate(result.plugin.id);
    this.replaceResult(withPlugin(this.result, result.plugin), true);
  }

  /** Plugin changes can affect both catalog state and route visibility (for example Workboard). */
  private async refreshCatalogAfterMutation(client: GatewayBrowserClient): Promise<void> {
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private async showDetails(pluginId: string | null) {
    const detail = pluginId ? { pluginId, inspection: null, error: null } : null;
    this.detail = detail;
    const plugin = pluginId
      ? this.result?.plugins.find((entry) => entry.id === pluginId)
      : undefined;
    if (!plugin?.installed || !detail) {
      return;
    }
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    try {
      const inspection = await inspectPlugin(scope.client, plugin.id);
      if (this.gateway.isCurrent(scope) && this.detail === detail) {
        this.detail = { ...detail, inspection };
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.detail === detail) {
        this.detail = { ...detail, error: formatUiError(error) };
      }
    }
  }

  private updateEnabled(pluginId: string, enabled: boolean, key?: string): Promise<void> {
    return this.consentController.updateEnabled(pluginId, enabled, key);
  }

  private async uninstall(pluginId: string, rowKey: string): Promise<void> {
    const name = this.result?.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
    await this.consentController.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, _isCurrent, isLatest) => {
        // Removal hides its row, so keep the restart reminder on the page.
        if (isLatest()) {
          this.pageNotice = {
            kind: "success",
            text: [
              t("pluginsPage.removedRestart", { name }),
              ...(result.warnings ?? []).map((warning) => formatUiExternalText(warning)),
              refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
            ]
              .filter(Boolean)
              .join("\n"),
          };
          const routePluginId = pluginSettingsIdFromPath(
            this.routeData?.location.pathname ?? "",
            this.context.basePath,
          );
          if (routePluginId === pluginId) {
            this.detail = null;
            this.context.replace("plugin-settings", {
              pathname: pathForRoute("plugin-settings", this.context.basePath),
            });
          }
        }
        await this.refreshCatalogAfterMutation(client);
      },
      { confirm: () => confirmPluginUninstall(name) },
    );
  }

  override render() {
    const blockedReason = this.mutationBlockedReason();
    const discovery = this.surface === "discovery";
    const configState = this.context.runtimeConfig.state;
    const configAnalysis = analyzeConfigSchema(configState.configSchema);
    const detailPluginId = this.detail?.pluginId ?? null;
    const settingsParentRoute =
      new URLSearchParams(this.routeData?.location.search ?? "").get("from") === "plugins"
        ? "plugins"
        : "plugin-settings";
    const settingsShared = {
      connected: this.gateway.connected,
      loading: this.loading,
      result: this.result,
      error: this.error,
      busy: this.busy,
      messages: this.messages,
      pageNotice: this.pageNotice,
      iconUrls: this.iconUrls,
      canMutate: this.canMutate(),
      mutationBlockedReason: blockedReason,
      configBusy: configState.configLoading || configState.configSaving,
      configError: configState.lastError,
      canEditConfig: this.canEditConfig(),
      configValue: configState.configForm,
      configHints: configState.configUiHints,
      configSchemaLoading: configState.configSchemaLoading,
      configUnsupportedPaths: configAnalysis.unsupportedPaths,
      onIconError: (pluginId: string) => this.pluginIcons.handleError(pluginId),
      onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) =>
        void this.updateEnabled(pluginId, enabled, rowKey),
      onUninstall: (pluginId: string, rowKey: string) => void this.uninstall(pluginId, rowKey),
      onConfigPatch: (path: Array<string | number>, value: unknown) => {
        this.pluginConfigEditPending = true;
        this.context.runtimeConfig.patchForm(path, value);
      },
      onConfigRemove: (path: Array<string | number>) => {
        this.pluginConfigEditPending = true;
        this.context.runtimeConfig.removeFormValue(path);
      },
      onConfigReload: () => {
        this.pluginConfigEditPending = false;
        void this.context.runtimeConfig.refresh({ discardPendingChanges: true });
      },
      onRefresh: () => void this.refreshCatalog(),
    };
    return html`
      ${
        discovery
          ? renderPluginsHubHeader({
              active: "plugins",
              onSelect: (tab) => this.selectHubTab(tab),
            })
          : nothing
      }
      ${renderSettingsWorkspace(html`
        ${
          discovery
            ? html`<wa-tab-panel
                id=${PLUGINS_HUB_PANEL_ID}
                name="plugins"
                active
                aria-labelledby="plugins-tab-plugins"
                >${renderInstalledPlugins({
                  connected: this.gateway.connected,
                  loading: this.loading,
                  result: this.result,
                  error: this.error,
                  expanded: this.inventoryExpanded,
                  searchOpen: this.inventorySearchOpen,
                  query: this.query,
                  busy: this.busy,
                  iconUrls: this.iconUrls,
                  canMutate: this.canMutate(),
                  mutationBlockedReason: blockedReason,
                  consent: this.consentController.consent,
                  consentInspection: this.consentController.inspection,
                  consentInspectionLoading: this.consentController.inspectionLoading,
                  consentInspectionError: this.consentController.inspectionError,
                  onExpandedChange: (expanded) => {
                    this.inventoryExpanded = expanded;
                  },
                  onSearchOpenChange: (open) => {
                    this.inventorySearchOpen = open;
                    if (!open) {
                      this.query = "";
                    }
                  },
                  onQueryChange: (query) => {
                    this.query = query;
                  },
                  onRefresh: () => void this.refreshCatalog(),
                  settingsHref: (pluginId) =>
                    `${pathForPluginSettings(pluginId, this.context.basePath)}?from=plugins`,
                  onOpenSettings: (pluginId) => {
                    this.context.navigate("plugin-settings", {
                      pathname: pluginId
                        ? pathForPluginSettings(pluginId, this.context.basePath)
                        : pathForRoute("plugin-settings", this.context.basePath),
                      search: pluginId ? "?from=plugins" : "",
                    });
                  },
                  onIconError: (pluginId) => this.pluginIcons.handleError(pluginId),
                  onCancelConsent: () => this.consentController.close(),
                  onConfirmConsent: () => this.consentController.confirm(),
                  onRetryConsentInspection: () => void this.consentController.inspect(),
                })}${renderPluginCatalogResults({
                  connected: this.gateway.connected,
                  loading: this.discoveryLoading,
                  result: this.discoveryResult,
                  error: this.discoveryError,
                  onRetry: () => void this.refreshDiscovery(),
                })}</wa-tab-panel
              >`
            : detailPluginId
              ? renderPluginSettingsDetail({
                  ...settingsShared,
                  pluginId: detailPluginId,
                  inspection: this.detail?.inspection ?? null,
                  inspectionError: this.detail?.error ?? null,
                  configSchema: pluginConfigSchema(configAnalysis.schema, detailPluginId),
                  backHref: pathForRoute(settingsParentRoute, this.context.basePath),
                  backLabel:
                    settingsParentRoute === "plugins" ? t("tabs.plugins") : t("nav.settings"),
                  onBack: () => {
                    this.detail = null;
                    this.context.navigate(settingsParentRoute, {
                      pathname: pathForRoute(settingsParentRoute, this.context.basePath),
                    });
                  },
                  onRetryInspection: () => void this.showDetails(detailPluginId),
                })
              : renderPluginSettingsInventory({
                  ...settingsShared,
                  tab: this.settingsTab,
                  query: this.query,
                  advancedSchema: pluginAdvancedSchema(configAnalysis.schema),
                  onTabChange: (tab) => {
                    this.settingsTab = tab;
                    this.context.replace("plugin-settings", {
                      pathname: pathForRoute("plugin-settings", this.context.basePath),
                      search: tab === "advanced" ? "?tab=advanced" : "",
                    });
                  },
                  onQueryChange: (query) => {
                    this.query = query;
                  },
                  pluginHref: (pluginId) => pathForPluginSettings(pluginId, this.context.basePath),
                  onOpenPlugin: (pluginId) => {
                    this.context.navigate("plugin-settings", {
                      pathname: pathForPluginSettings(pluginId, this.context.basePath),
                    });
                  },
                })
        }
      `)}
      ${
        !discovery && this.consentController.consent
          ? renderPluginConsentDialog({
              consent: this.consentController.consent,
              inspection: this.consentController.inspection,
              loading: this.consentController.inspectionLoading,
              error: this.consentController.inspectionError,
              iconUrl: this.consentController.consent.pluginId
                ? this.iconUrls[this.consentController.consent.pluginId]
                : undefined,
              canMutate: this.canMutate(),
              mutationBlockedReason: blockedReason,
              busy: Object.values(this.busy).some(Boolean),
              onCancel: () => this.consentController.close(),
              onConfirm: () => this.consentController.confirm(),
              onRetry: () => void this.consentController.inspect(),
            })
          : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-plugins-page")) {
  customElements.define("openclaw-plugins-page", PluginsPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugins-page": PluginsPage;
  }
}
