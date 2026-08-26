import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { RouteLocation } from "@openclaw/uirouter";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForPluginsHubTab, pathForRoute } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import type { McpServerForm } from "../../components/mcp-server-form.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import {
  buildAddMcpServerPatch,
  buildRemoveMcpServerPatch,
  buildToggleMcpServerPatch,
  MCP_SERVER_NAME_PATTERN,
  parseMcpTarget,
  patchMcpServers,
  summarizeMcpServers,
  type McpServerSummary,
  type McpServersPatchBuildResult,
} from "../../lib/config/mcp-servers.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { inspectPlugin } from "../../lib/plugins/capability-consent-error.ts";
import {
  uninstallPlugin,
  type PluginCatalogItem,
  type PluginListResult,
  type PluginMutationResult,
  type PluginSearchResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { fetchPluginIconBlobUrl } from "./icon-loader.ts";
import { PluginsConsentController } from "./plugins-consent-controller.ts";
import { renderPluginsHubHeader } from "./plugins-hub-header.ts";
import type { PluginsHubTab } from "./plugins-hub.ts";
import type { ConnectorSuggestion } from "./presentation.ts";
import { pluginArtPath } from "./presentation.ts";
import { canonicalPluginsRouteLocation, pluginsHubTabForRoute } from "./route-data.ts";
import {
  connectorRowKey,
  renderPlugins,
  type InstalledFilter,
  type PluginRowMessage,
  type PluginsTab,
} from "./view.ts";

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

class PluginsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: PluginsRouteData;

  @state() private result: PluginListResult | null = null;
  @state() private error: string | null = null;
  @state() private activeTab: PluginsTab = "installed";
  @state() private query = "";
  @state() private installedFilter: InstalledFilter = "all";
  @state() private debouncedSearchQuery = "";
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, PluginRowMessage> = {};
  @state() private pendingRemoval: Record<string, boolean> = {};
  @state() private detailPluginId: string | null = null;
  @state() private detailInspection: PluginsInspectResult | null = null;
  @state() private detailInspectionLoading = false;
  @state() private iconUrls: Record<string, string> = {};
  @state() private pageNotice: PluginRowMessage | null = null;
  @state() private mcpServers: McpServerSummary[] | null = null;
  @state() private mcpMessage: PluginRowMessage | null = null;
  @state() private mcpBusy = false;
  @state() private mcpFormOpen = false;

  private routeDataConsumed = false;
  private normalizedLocation = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly iconMisses = new Set<string>();
  private readonly iconRequests = new Map<
    string,
    { controller: AbortController; timeout: ReturnType<typeof setTimeout> }
  >();
  private iconAuthCandidates: string[] = [];
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.result = null;
      this.error = null;
      this.messages = {};
      this.pendingRemoval = {};
      this.detailPluginId = null;
      this.detailInspection = null;
      this.detailInspectionLoading = false;
      this.consentController.reset();
      this.pageNotice = null;
      this.mcpMessage = null;
    },
    invalidateRequests: (change) =>
      this.invalidateRequests(change.snapshot.phase !== "connected" || !change.snapshot.client),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });

  private readonly consentController = new PluginsConsentController({
    gateway: this.gateway,
    getContext: () => this.context,
    getResult: () => this.result,
    getSearchResults: () => this.searchResults,
    canMutate: () => this.canMutate(),
    isBusy: (rowKey) => Boolean(this.busy[rowKey]),
    setBusy: (rowKey, busy) => this.setBusy(rowKey, busy),
    setMessage: (rowKey, message) => this.setMessage(rowKey, message),
    clearPageNotice: () => {
      this.pageNotice = null;
    },
    closeDetails: () => {
      this.detailPluginId = null;
    },
    applyMutationResult: (result) => this.applyMutationResult(result),
    refreshCatalogAfterMutation: (client) => this.refreshCatalogAfterMutation(client),
    requestUpdate: () => this.requestUpdate(),
  });

  private readonly catalogTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client ? client.request<PluginListResult>("plugins.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.replaceResult(result);
    },
    onError: (error) => {
      this.error = formatUiError(error);
    },
  });

  private readonly configTask = new Task(this, {
    autoRun: false,
    args: () =>
      [
        this.gateway.connected ? this.gateway.client : null,
        this.context?.runtimeConfig ?? null,
      ] as const,
    task: async ([client, runtimeConfig]) => {
      if (!client || !runtimeConfig) {
        return initialState;
      }
      await runtimeConfig.refresh();
      return runtimeConfig.state.lastError;
    },
    onComplete: () => {
      this.syncMcpServers();
    },
    onError: () => {
      this.syncMcpServers();
    },
  });

  private readonly searchTask = new Task(this, {
    args: () =>
      [
        this.gateway.connected && this.activeTab === "discover" ? this.gateway.client : null,
        this.debouncedSearchQuery,
      ] as const,
    task: async ([client, query], { signal }) => {
      if (!client || query.length < 2) {
        return initialState;
      }
      const response = await client.request<{ results: PluginSearchResult[] }>(
        "plugins.search",
        { query, limit: 20 },
        { signal },
      );
      return response.results;
    },
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      this.syncMcpServers();
      return runtimeConfig.subscribe(() => this.syncMcpServers());
    },
  );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.syncCanonicalLocation();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    this.syncCanonicalLocation();
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    this.subscriptions.clear();
    this.clearSearchTimer();
    this.resetPluginIcons();
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    if (this.consentController.consent) {
      this.consentController.close();
      event.stopPropagation();
      return;
    }
    if (this.detailPluginId) {
      this.detailPluginId = null;
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
      this.resetPluginIcons();
      this.busy = {};
      this.mcpBusy = false;
      this.debouncedSearchQuery = "";
    }
    if (shouldRefreshAfterChange) {
      void this.refreshPage();
    } else {
      this.ensureInitialData();
    }
    if (snapshot.phase === "connected") {
      void this.context?.runtimeConfig.ensureLoaded().then(() => this.syncMcpServers());
    }
    if (
      !change.initial &&
      (change.identityChanged || change.connectionChanged || iconAuthChanged) &&
      snapshot.phase === "connected" &&
      this.activeTab === "discover"
    ) {
      this.scheduleSearch();
    }
  }

  private applyRouteData() {
    const data = this.routeData;
    this.routeDataConsumed = true;
    if (!data) {
      this.ensureInitialData();
      return;
    }
    const urlTab = pluginsHubTabForRoute(data.location, this.context.basePath);
    if (urlTab !== this.activeTab) {
      this.changeTab(urlTab);
    }
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.ensureInitialData();
      return;
    }
    this.replaceResult(data.result);
    this.error = data.error;
    this.ensureInitialData();
  }

  private syncCanonicalLocation() {
    const context = this.context;
    const location = this.routeData?.location;
    if (!context || !location) {
      return;
    }
    const canonical = canonicalPluginsRouteLocation(location, context.basePath);
    if (!canonical) {
      this.normalizedLocation = "";
      return;
    }
    const source = `${location.pathname}${location.search}${location.hash}`;
    if (this.normalizedLocation === source) {
      return;
    }
    // One source location gets one replace. Route-data updates clear the guard
    // once the canonical path arrives, so returning to an old link still works.
    this.normalizedLocation = source;
    context.replace("plugins", canonical);
  }

  private invalidateRequests(invalidateCatalog = true) {
    this.clearSearchTimer();
    this.debouncedSearchQuery = "";
    if (invalidateCatalog) {
      void this.catalogTask.run([null]);
    }
    void this.configTask.run([null, this.context.runtimeConfig]);
    void this.searchTask.run([null, ""]);
    this.consentController.invalidateMutations();
  }

  private replaceResult(result: PluginListResult | null, preserveIcons = false) {
    if (preserveIcons) {
      this.reconcilePluginIcons(result);
    } else {
      this.resetPluginIcons();
    }
    this.result = result;
    this.syncPluginIcons();
  }

  private reconcilePluginIcons(result: PluginListResult | null) {
    const eligiblePluginIds = new Set(
      (result?.plugins ?? [])
        .filter((plugin) => plugin.hasIcon && !pluginArtPath(plugin.id))
        .map((plugin) => plugin.id),
    );
    const nextUrls = { ...this.iconUrls };
    let urlsChanged = false;
    for (const [pluginId, url] of Object.entries(nextUrls)) {
      if (!eligiblePluginIds.has(pluginId)) {
        URL.revokeObjectURL(url);
        delete nextUrls[pluginId];
        urlsChanged = true;
      }
    }
    if (urlsChanged) {
      this.iconUrls = nextUrls;
    }
    for (const [pluginId, request] of this.iconRequests) {
      if (!eligiblePluginIds.has(pluginId)) {
        clearTimeout(request.timeout);
        request.controller.abort();
        this.iconRequests.delete(pluginId);
      }
    }
    for (const pluginId of this.iconMisses) {
      if (!eligiblePluginIds.has(pluginId)) {
        this.iconMisses.delete(pluginId);
      }
    }
  }

  private resetPluginIcons() {
    for (const request of this.iconRequests.values()) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    for (const url of Object.values(this.iconUrls)) {
      URL.revokeObjectURL(url);
    }
    this.iconRequests.clear();
    this.iconMisses.clear();
    this.iconUrls = {};
  }

  private syncPluginIcons() {
    for (const plugin of this.result?.plugins ?? []) {
      if (
        !plugin.hasIcon ||
        pluginArtPath(plugin.id) ||
        this.iconUrls[plugin.id] ||
        this.iconMisses.has(plugin.id) ||
        this.iconRequests.has(plugin.id)
      ) {
        continue;
      }
      this.fetchPluginIcon(plugin.id);
    }
  }

  private fetchPluginIcon(pluginId: string) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
      10_000,
    );
    const request = { controller, timeout };
    this.iconRequests.set(pluginId, request);
    void fetchPluginIconBlobUrl({
      pluginId,
      resourceBasePath: this.context.resourceBasePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
      signal: controller.signal,
    })
      .then((url) => {
        if (this.iconRequests.get(pluginId) !== request || !this.isConnected) {
          if (url) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        if (url) {
          this.iconUrls = { ...this.iconUrls, [pluginId]: url };
        } else {
          this.iconMisses.add(pluginId);
        }
      })
      .catch(() => {
        if (this.iconRequests.get(pluginId) === request) {
          this.iconMisses.add(pluginId);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.iconRequests.get(pluginId) === request) {
          this.iconRequests.delete(pluginId);
        }
      });
  }

  private handlePluginIconError(pluginId: string) {
    this.invalidatePluginIcon(pluginId);
    this.iconMisses.add(pluginId);
  }

  private invalidatePluginIcon(pluginId: string) {
    const request = this.iconRequests.get(pluginId);
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
      this.iconRequests.delete(pluginId);
    }
    const url = this.iconUrls[pluginId];
    if (url) {
      URL.revokeObjectURL(url);
    }
    const next = { ...this.iconUrls };
    delete next[pluginId];
    this.iconUrls = next;
    this.iconMisses.delete(pluginId);
  }

  private clearSearchTimer() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private get loading(): boolean {
    return this.gateway.connected && this.catalogTask.status === TaskStatus.PENDING;
  }

  private get searchResults(): PluginSearchResult[] | null {
    return this.searchTask.status === TaskStatus.COMPLETE &&
      this.debouncedSearchQuery === this.query.trim()
      ? (this.searchTask.value ?? null)
      : null;
  }

  private get searchLoading(): boolean {
    return (
      this.activeTab === "discover" &&
      this.debouncedSearchQuery.length >= 2 &&
      this.searchTask.status === TaskStatus.PENDING
    );
  }

  private get searchError(): string | null {
    return this.searchTask.status === TaskStatus.ERROR &&
      this.debouncedSearchQuery === this.query.trim()
      ? formatUiError(this.searchTask.error)
      : null;
  }

  private get configRefreshError(): string | null {
    const failure =
      this.configTask.status === TaskStatus.ERROR
        ? formatUiError(this.configTask.error)
        : this.configTask.status === TaskStatus.COMPLETE
          ? this.configTask.value
          : null;
    return failure ? t("pluginsPage.configRefreshFailed", { error: failure }) : null;
  }

  private ensureInitialData() {
    if (
      !this.gateway.connected ||
      !this.gateway.client ||
      this.loading ||
      this.result ||
      this.error
    ) {
      return;
    }
    if (this.routeData && !this.routeDataConsumed) {
      return;
    }
    void this.refreshCatalog();
  }

  private async refreshCatalog(): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private async refreshRuntimeConfig(): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    await this.configTask.run([client, runtimeConfig]);
  }

  private async refreshPage(): Promise<void> {
    await Promise.all([this.refreshCatalog(), this.refreshRuntimeConfig()]);
  }

  private syncMcpServers() {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    this.mcpServers = summarizeMcpServers(resolveEditableSnapshotConfig(snapshot));
  }

  private selectHubTab(tab: PluginsHubTab) {
    if (tab === "installed" || tab === "discover") {
      this.changeTab(tab);
      this.context.navigate("plugins", {
        pathname: pathForPluginsHubTab(tab, this.context.basePath),
      });
      return;
    }
    this.context.navigate(tab === "skills" ? "skills" : "skill-workshop");
  }

  private changeTab(tab: PluginsTab) {
    this.activeTab = tab;
    this.clearSearchTimer();
    this.debouncedSearchQuery = "";
    void this.searchTask.run([null, ""]);
    if (tab === "discover") {
      this.scheduleSearch();
    }
  }

  private changeQuery(query: string) {
    this.query = query;
    this.clearSearchTimer();
    this.debouncedSearchQuery = "";
    void this.searchTask.run([null, ""]);
    if (this.activeTab === "discover") {
      this.scheduleSearch();
    }
  }

  private openClawHubSearch(query: string) {
    this.query = query;
    this.changeTab("discover");
  }

  private scheduleSearch() {
    const query = this.query.trim();
    if (query.length < 2 || !this.gateway.connected || !this.gateway.client) {
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.searchClawHub(query);
    }, 300);
  }

  private async searchClawHub(query: string) {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected || query.length < 2) {
      return;
    }
    this.debouncedSearchQuery = query;
    await this.searchTask.run([client, query]);
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

  private setPendingRemoval(key: string, value: boolean) {
    const next = { ...this.pendingRemoval };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.pendingRemoval = next;
  }

  private applyMutationResult(result: PluginMutationResult) {
    this.invalidatePluginIcon(result.plugin.id);
    this.replaceResult(withPlugin(this.result, result.plugin), true);
  }

  /** Plugin changes can affect both catalog state and route visibility (for example Workboard). */
  private async refreshCatalogAfterMutation(client: GatewayBrowserClient): Promise<void> {
    this.error = null;
    await this.catalogTask.run([client]);
  }

  private pageError(): string | null {
    const errors = [this.error, this.configRefreshError].filter((message): message is string =>
      Boolean(message),
    );
    return errors.length > 0 ? errors.join(" ") : null;
  }

  private showDetails(pluginId: string | null) {
    this.detailPluginId = pluginId;
    this.detailInspection = null;
    this.detailInspectionLoading = false;
    const plugin = pluginId
      ? this.result?.plugins.find((entry) => entry.id === pluginId)
      : undefined;
    if (!plugin?.installed) {
      return;
    }
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    this.detailInspectionLoading = true;
    void inspectPlugin(scope.client, plugin.id)
      .then((inspection) => {
        if (this.gateway.isCurrent(scope) && this.detailPluginId === plugin.id) {
          this.detailInspection = inspection;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.gateway.isCurrent(scope) && this.detailPluginId === plugin.id) {
          this.detailInspectionLoading = false;
        }
      });
  }

  private updateEnabled(pluginId: string, enabled: boolean, key?: string): Promise<void> {
    return this.consentController.updateEnabled(pluginId, enabled, key);
  }

  private async uninstall(pluginId: string, rowKey: string): Promise<void> {
    await this.consentController.runMutation(
      rowKey,
      (client) => uninstallPlugin(client, pluginId),
      async (result, refreshError, client, _isCurrent, isLatest) => {
        this.setPendingRemoval(rowKey, false);
        // Removal hides its row, so keep the restart reminder on the page.
        if (isLatest()) {
          this.pageNotice = {
            kind: "success",
            text: [
              t("pluginsPage.removedRestart", { name: result.pluginId }),
              ...(result.warnings ?? []).map((warning) => formatUiExternalText(warning)),
              refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }
        await this.refreshCatalogAfterMutation(client);
      },
    );
  }

  private async mutateMcpServers(params: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
    busyKey?: string;
  }): Promise<boolean> {
    if (!this.canMutate() || this.mcpBusy) {
      return false;
    }
    const runtimeConfig = this.context.runtimeConfig;
    this.mcpBusy = true;
    if (params.busyKey) {
      this.setBusy(params.busyKey, true);
      this.setMessage(params.busyKey, null);
    }
    this.mcpMessage = null;
    // Failures surface where the action started: on the triggering card when
    // one exists (Discover connectors), otherwise in the MCP section.
    const fail = (text: string) => {
      if (params.busyKey) {
        this.setMessage(params.busyKey, { kind: "error", text });
      } else {
        this.mcpMessage = { kind: "error", text };
      }
      return false;
    };
    try {
      const result = await patchMcpServers(runtimeConfig, {
        buildPatch: params.buildPatch,
        note: params.note,
      });
      if (!result.ok) {
        return fail(result.error);
      }
      this.syncMcpServers();
      this.mcpMessage = { kind: "success", text: params.successText };
      return true;
    } catch (error) {
      return fail(formatUiError(error));
    } finally {
      this.mcpBusy = false;
      if (params.busyKey) {
        this.setBusy(params.busyKey, false);
      }
    }
  }

  private async addMcpServer(form: McpServerForm) {
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      this.mcpMessage = { kind: "error", text: t("mcpServers.nameInvalid") };
      return;
    }
    const config = parseMcpTarget(form.target, form.transport);
    if (!config) {
      this.mcpMessage = { kind: "error", text: t("mcpServers.targetInvalid") };
      return;
    }
    const added = await this.mutateMcpServers({
      buildPatch: (servers) => buildAddMcpServerPatch(servers, name, config),
      note: `plugins: add MCP server ${name}`,
      successText: t("mcpServers.addedSuccess", { name }),
    });
    if (added) {
      this.mcpFormOpen = false;
    }
  }

  private async toggleMcpServer(name: string, enabled: boolean) {
    await this.mutateMcpServers({
      buildPatch: (servers) => buildToggleMcpServerPatch(servers, name, enabled),
      note: `plugins: ${enabled ? "enable" : "disable"} MCP server ${name}`,
      successText: t(enabled ? "mcpServers.enabledSuccess" : "mcpServers.disabledSuccess", {
        name,
      }),
    });
  }

  private async removeMcpServer(name: string) {
    await this.mutateMcpServers({
      buildPatch: (servers) => buildRemoveMcpServerPatch(servers, name),
      note: `plugins: remove MCP server ${name}`,
      successText: t("mcpServers.removedSuccess", { name }),
    });
  }

  private async addConnector(connector: ConnectorSuggestion) {
    if (connector.action.kind !== "mcp") {
      return;
    }
    const mcp = connector.action.mcp;
    const rowKey = connectorRowKey(connector.id);
    const successText =
      mcp.followUp === "oauth"
        ? t("pluginsPage.connectorAddedOauth", {
            name: connector.name,
            command: `openclaw mcp login ${mcp.serverName}`,
          })
        : mcp.followUp === "endpoint"
          ? t("pluginsPage.connectorAddedEndpoint", { name: connector.name })
          : t("pluginsPage.connectorAddedReady", { name: connector.name });
    const added = await this.mutateMcpServers({
      buildPatch: (servers) =>
        buildAddMcpServerPatch(servers, mcp.serverName, structuredClone(mcp.config)),
      note: `plugins: add MCP connector ${mcp.serverName}`,
      successText,
      busyKey: rowKey,
    });
    if (added) {
      this.setMessage(rowKey, { kind: "success", text: successText });
      this.mcpMessage = null;
    }
  }

  override render() {
    const blockedReason = this.mutationBlockedReason();
    return html`
      ${renderPluginsHubHeader({
        active: this.activeTab,
        onSelect: (tab) => this.selectHubTab(tab),
      })}
      ${renderSettingsWorkspace(html`
        ${renderPlugins({
          connected: this.gateway.connected,
          loading: this.loading,
          result: this.result,
          error: this.pageError(),
          activeTab: this.activeTab,
          query: this.query,
          installedFilter: this.installedFilter,
          searchResults: this.searchResults,
          searchLoading: this.searchLoading,
          searchError: this.searchError,
          busy: this.busy,
          messages: this.messages,
          pendingRemoval: this.pendingRemoval,
          detailPluginId: this.detailPluginId,
          detailInspection: this.detailInspection,
          detailInspectionLoading: this.detailInspectionLoading,
          consent: this.consentController.consent,
          consentInspection: this.consentController.inspection,
          consentInspectionLoading: this.consentController.inspectionLoading,
          consentInspectionError: this.consentController.inspectionError,
          iconUrls: this.iconUrls,
          canMutate: this.canMutate(),
          mutationBlockedReason: blockedReason,
          pageNotice: this.pageNotice,
          mcpSettingsHref: pathForRoute("mcp", this.context?.basePath ?? ""),
          mcpServers: this.mcpServers,
          mcpMessage: this.mcpMessage,
          mcpBusy: this.mcpBusy,
          mcpFormOpen: this.mcpFormOpen,
          onQueryChange: (query) => this.changeQuery(query),
          onFilterChange: (filter) => {
            this.installedFilter = filter;
          },
          onRefresh: () => void this.refreshPage(),
          onIconError: (pluginId) => this.handlePluginIconError(pluginId),
          onShowDetails: (pluginId) => this.showDetails(pluginId),
          onSetEnabled: (pluginId, enabled, rowKey) =>
            void this.updateEnabled(pluginId, enabled, rowKey),
          onInstall: (request, installIdentity) =>
            this.consentController.requestInstallConsent(request, installIdentity),
          onCancelConsent: () => this.consentController.close(),
          onConfirmConsent: () => this.consentController.confirm(),
          onRetryConsentInspection: () => void this.consentController.inspect(),
          onDismissMessage: (rowKey) => this.setMessage(rowKey, null),
          onRequestUninstall: (rowKey) => this.setPendingRemoval(rowKey, true),
          onCancelUninstall: (rowKey) => this.setPendingRemoval(rowKey, false),
          onUninstall: (pluginId, rowKey) => void this.uninstall(pluginId, rowKey),
          onAddConnector: (connector) => void this.addConnector(connector),
          onSearchClawHub: (query) => this.openClawHubSearch(query),
          onMcpToggle: (name, enabled) => void this.toggleMcpServer(name, enabled),
          onMcpRemove: (name) => void this.removeMcpServer(name),
          onMcpFormToggle: (open) => {
            this.mcpFormOpen = open;
            if (open) {
              this.mcpMessage = null;
            }
          },
          onMcpAdd: (form) => void this.addMcpServer(form),
        })}
      `)}
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

export { PluginsPage };
