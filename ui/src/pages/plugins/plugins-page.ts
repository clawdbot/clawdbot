import { consume } from "@lit/context";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderPluginsHubTabs, type PluginsHubTab } from "../../components/plugins-hub-tabs.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/index.ts";
import {
  installPlugin,
  loadPluginCatalog,
  pluginInstallNeedsRiskAcknowledgement,
  readPluginInstallTrustError,
  searchPluginCatalog,
  setPluginEnabled,
  uninstallPlugin,
  type PluginCatalogItem,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginMutationResult,
  type PluginSearchResult,
} from "../../lib/plugins/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { ConnectorSuggestion } from "./presentation.ts";
import {
  connectorRowKey,
  pluginRowKey,
  renderPlugins,
  type InstalledFilter,
  type McpServerForm,
  type McpServerSummary,
  type PluginRowMessage,
  type PluginsTab,
} from "./view.ts";

export type PluginsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  result: PluginListResult | null;
  error: string | null;
  /** Tab requested via ?tab=; lets other hub pages deep-link Discover. */
  initialTab: PluginsTab | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function mutationSuccessMessage(
  action: "installed" | "enabled" | "disabled",
  result: PluginMutationResult,
): string {
  const key = result.restartRequired
    ? `pluginsPage.${action}Restart`
    : `pluginsPage.${action}Success`;
  const warnings = "warnings" in result ? (result.warnings ?? []) : [];
  const lines = [t(key, { name: result.plugin.name }), ...warnings];
  return lines.filter(Boolean).join("\n");
}

/** Cold MCP server summary mirroring the config page's row projection. */
function summarizeMcpServers(config: Record<string, unknown> | null): McpServerSummary[] | null {
  if (!config) {
    return null;
  }
  const servers = asRecord(asRecord(config.mcp)?.servers) ?? {};
  return Object.entries(servers)
    .map(([name, value]) => {
      const server = asRecord(value) ?? {};
      const url = typeof server.url === "string" ? server.url : "";
      // Command only, mirroring the config page: stdio args routinely carry
      // tokens and this surface is visible to read-only operators.
      const command = typeof server.command === "string" ? server.command : "";
      const launch = url || command || "missing transport";
      return {
        name,
        enabled: server.enabled !== false,
        transport: url ? ("http" as const) : command ? ("stdio" as const) : ("invalid" as const),
        target: url ? redactSensitiveUrlLikeString(launch) : launch,
        auth: typeof server.auth === "string" ? server.auth : null,
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function parseMcpTarget(target: string): Record<string, unknown> | null {
  if (/^https?:\/\//i.test(target)) {
    // The runtime defaults URL-only servers to SSE; modern MCP endpoints are
    // streamable HTTP unless the /sse path convention says otherwise.
    const transport = /\/sse\/?$/i.test(target.split("?")[0] ?? target) ? "sse" : "streamable-http";
    return { url: target, transport };
  }
  const [command, ...args] = target.trim().split(/\s+/u);
  if (!command) {
    return null;
  }
  return args.length > 0 ? { command, args } : { command };
}

class PluginsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: PluginsRouteData;

  @state() private client: GatewayBrowserClient | null = null;
  @state() private connected = false;
  @state() private loading = false;
  @state() private result: PluginListResult | null = null;
  @state() private error: string | null = null;
  @state() private configRefreshError: string | null = null;
  @state() private activeTab: PluginsTab = "installed";
  @state() private query = "";
  @state() private installedFilter: InstalledFilter = "all";
  @state() private searchResults: PluginSearchResult[] | null = null;
  @state() private searchLoading = false;
  @state() private searchError: string | null = null;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, PluginRowMessage> = {};
  @state() private pendingRemoval: Record<string, boolean> = {};
  @state() private detailPluginId: string | null = null;
  @state() private pageNotice: PluginRowMessage | null = null;
  @state() private mcpServers: McpServerSummary[] | null = null;
  @state() private mcpMessage: PluginRowMessage | null = null;
  @state() private mcpBusy = false;
  @state() private mcpFormOpen = false;

  private gatewaySource?: ApplicationContext["gateway"];
  private sourceGeneration = 0;
  private catalogRequestGeneration = 0;
  private configRequestGeneration = 0;
  private searchRequestGeneration = 0;
  private routeDataConsumed = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationToken = 0;
  private readonly mutationTokens = new Map<string, number>();

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
        return gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway) {
            this.applyGatewaySnapshot(snapshot, false);
          }
        });
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.syncMcpServers();
        return runtimeConfig.subscribe(() => this.syncMcpServers());
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
    this.clearSearchTimer();
    this.invalidateRequests();
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    if (this.detailPluginId) {
      this.detailPluginId = null;
      event.stopPropagation();
    }
  };

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, sourceChanged: boolean) {
    const connectionChanged = snapshot.connected !== this.connected;
    const clientChanged = snapshot.client !== this.client;
    const shouldRefreshAfterChange =
      (sourceChanged || connectionChanged || clientChanged) &&
      snapshot.connected &&
      this.routeDataConsumed;
    if (sourceChanged || connectionChanged || clientChanged) {
      this.invalidateRequests();
      this.client = snapshot.client;
      this.connected = snapshot.connected;
      this.loading = false;
      this.searchLoading = false;
      this.busy = {};
      this.mcpBusy = false;
      this.configRefreshError = null;
      this.searchResults = null;
      this.searchError = null;
      if (sourceChanged || clientChanged) {
        this.result = null;
        this.error = null;
        this.messages = {};
        this.pendingRemoval = {};
        this.detailPluginId = null;
        this.pageNotice = null;
        this.mcpMessage = null;
      }
    }
    if (shouldRefreshAfterChange) {
      void this.refreshPage();
    } else {
      this.ensureInitialData();
    }
    if (snapshot.connected) {
      void this.context?.runtimeConfig.ensureLoaded().then(() => this.syncMcpServers());
    }
    if (
      (sourceChanged || connectionChanged || clientChanged) &&
      snapshot.connected &&
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
    // Honor ?tab= even when the loader snapshot is stale; the tab choice is
    // navigation intent, not catalog data. A bare URL means Installed so
    // history back/forward always restores the tab the URL describes.
    const urlTab = data.initialTab ?? "installed";
    if (urlTab !== this.activeTab) {
      this.changeTab(urlTab);
    }
    const snapshot = this.context.gateway.snapshot;
    if (data.gateway !== this.context.gateway || data.gatewaySnapshot !== snapshot) {
      this.ensureInitialData();
      return;
    }
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.loading = false;
    this.result = data.result;
    this.error = data.error;
    this.ensureInitialData();
  }

  private invalidateRequests() {
    this.sourceGeneration += 1;
    this.catalogRequestGeneration += 1;
    this.configRequestGeneration += 1;
    this.searchRequestGeneration += 1;
    this.clearSearchTimer();
    this.mutationTokens.clear();
  }

  private clearSearchTimer() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private isCurrentSource(client: GatewayBrowserClient, sourceGeneration: number): boolean {
    return (
      this.isConnected &&
      this.connected &&
      this.client === client &&
      this.sourceGeneration === sourceGeneration
    );
  }

  private ensureInitialData() {
    if (!this.connected || !this.client || this.loading || this.result || this.error) {
      return;
    }
    if (this.routeData && !this.routeDataConsumed) {
      return;
    }
    void this.refreshCatalog();
  }

  private async refreshCatalog(): Promise<void> {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    const sourceGeneration = this.sourceGeneration;
    const requestGeneration = ++this.catalogRequestGeneration;
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      requestGeneration === this.catalogRequestGeneration;
    this.loading = true;
    this.error = null;
    try {
      const result = await loadPluginCatalog(client);
      if (isCurrent()) {
        this.result = result;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = errorMessage(error);
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
      }
    }
  }

  private async refreshRuntimeConfig(): Promise<void> {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    const sourceGeneration = this.sourceGeneration;
    const requestGeneration = ++this.configRequestGeneration;
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      requestGeneration === this.configRequestGeneration;
    this.configRefreshError = null;
    let refreshError: string | null = null;
    try {
      // Keep app-global pending config edits; the new snapshot/base hash still refreshes.
      await runtimeConfig.refresh();
    } catch (error) {
      refreshError = errorMessage(error);
    }
    if (!isCurrent()) {
      return;
    }
    this.syncMcpServers();
    const failure = refreshError ?? runtimeConfig.state.lastError;
    this.configRefreshError = failure
      ? t("pluginsPage.configRefreshFailed", { error: failure })
      : null;
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
      // Switch locally for instant feedback, then navigate so the URL and
      // history match the documented ?tab=discover deep link.
      this.changeTab(tab);
      this.context.navigate(
        "plugins",
        tab === "discover" ? { search: "?tab=discover" } : undefined,
      );
      return;
    }
    this.context.navigate(tab === "skills" ? "skills" : "skill-workshop");
  }

  private changeTab(tab: PluginsTab) {
    this.activeTab = tab;
    this.clearSearchTimer();
    this.searchRequestGeneration += 1;
    this.searchLoading = false;
    this.searchResults = null;
    this.searchError = null;
    if (tab === "discover") {
      this.scheduleSearch();
    }
  }

  private changeQuery(query: string) {
    this.query = query;
    this.clearSearchTimer();
    this.searchRequestGeneration += 1;
    this.searchLoading = false;
    this.searchResults = null;
    this.searchError = null;
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
    if (query.length < 2 || !this.connected || !this.client) {
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.searchClawHub(query);
    }, 300);
  }

  private async searchClawHub(query: string) {
    const client = this.client;
    if (!client || !this.connected || query.length < 2) {
      return;
    }
    const sourceGeneration = this.sourceGeneration;
    const requestGeneration = ++this.searchRequestGeneration;
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      requestGeneration === this.searchRequestGeneration &&
      this.activeTab === "discover" &&
      this.query.trim() === query;
    this.searchLoading = true;
    this.searchError = null;
    this.searchResults = null;
    try {
      const response = await searchPluginCatalog(client, query);
      if (isCurrent()) {
        this.searchResults = response.results;
      }
    } catch (error) {
      if (isCurrent()) {
        this.searchError = errorMessage(error);
      }
    } finally {
      if (isCurrent()) {
        this.searchLoading = false;
      }
    }
  }

  private mutationBlockedReason(): string | null {
    if (!this.connected) {
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
    this.result = withPlugin(this.result, result.plugin);
  }

  /** Plugin changes can affect both catalog state and route visibility (for example Workboard). */
  private async refreshAfterMutation(
    client: GatewayBrowserClient,
    sourceGeneration: number,
  ): Promise<void> {
    const requestGeneration = ++this.catalogRequestGeneration;
    // This authoritative refresh supersedes a visible catalog refresh and owns its cleanup.
    this.loading = false;
    this.error = null;
    const [catalogResult] = await Promise.allSettled([
      loadPluginCatalog(client),
      this.refreshRuntimeConfig(),
    ]);
    if (
      !this.isCurrentSource(client, sourceGeneration) ||
      requestGeneration !== this.catalogRequestGeneration
    ) {
      return;
    }
    if (catalogResult.status === "fulfilled") {
      this.result = catalogResult.value;
    } else {
      this.error = errorMessage(catalogResult.reason);
    }
  }

  private pageError(): string | null {
    const errors = [this.error, this.configRefreshError].filter((message): message is string =>
      Boolean(message),
    );
    return errors.length > 0 ? errors.join(" ") : null;
  }

  private async install(rowKey: string, request: PluginInstallRequest) {
    const client = this.client;
    if (!client || !this.canMutate() || this.busy[rowKey]) {
      return;
    }
    const sourceGeneration = this.sourceGeneration;
    const mutationToken = ++this.mutationToken;
    this.mutationTokens.set(rowKey, mutationToken);
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      this.mutationTokens.get(rowKey) === mutationToken;
    this.setBusy(rowKey, true);
    this.setMessage(rowKey, null);
    try {
      const result = await installPlugin(client, request);
      if (!isCurrent()) {
        return;
      }
      this.applyMutationResult(result);
      this.setMessage(rowKey, {
        kind: "success",
        text: mutationSuccessMessage("installed", result),
      });
      await this.refreshAfterMutation(client, sourceGeneration);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      const trust = readPluginInstallTrustError(error);
      const packageName = request.source === "clawhub" ? request.packageName : null;
      if (packageName && pluginInstallNeedsRiskAcknowledgement(error)) {
        this.setMessage(rowKey, {
          kind: "error",
          text: trust?.warning ?? t("pluginsPage.defaultRiskWarning"),
          acknowledge: {
            packageName,
            ...(trust?.version ? { version: trust.version } : {}),
          },
        });
      } else {
        this.setMessage(rowKey, { kind: "error", text: errorMessage(error) });
      }
    } finally {
      if (this.mutationTokens.get(rowKey) === mutationToken) {
        this.mutationTokens.delete(rowKey);
        this.setBusy(rowKey, false);
      }
    }
  }

  private async updateEnabled(pluginId: string, enabled: boolean, key = pluginRowKey(pluginId)) {
    const client = this.client;
    if (!client || !this.canMutate() || this.busy[key]) {
      return;
    }
    const sourceGeneration = this.sourceGeneration;
    const mutationToken = ++this.mutationToken;
    this.mutationTokens.set(key, mutationToken);
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      this.mutationTokens.get(key) === mutationToken;
    this.setBusy(key, true);
    this.setMessage(key, null);
    try {
      const result = await setPluginEnabled(client, pluginId, enabled);
      if (!isCurrent()) {
        return;
      }
      this.applyMutationResult(result);
      this.setMessage(key, {
        kind: "success",
        text: mutationSuccessMessage(enabled ? "enabled" : "disabled", result),
      });
      await this.refreshAfterMutation(client, sourceGeneration);
    } catch (error) {
      if (isCurrent()) {
        this.setMessage(key, { kind: "error", text: errorMessage(error) });
      }
    } finally {
      if (this.mutationTokens.get(key) === mutationToken) {
        this.mutationTokens.delete(key);
        this.setBusy(key, false);
      }
    }
  }

  private async uninstall(pluginId: string, rowKey: string) {
    const client = this.client;
    if (!client || !this.canMutate() || this.busy[rowKey]) {
      return;
    }
    const sourceGeneration = this.sourceGeneration;
    const mutationToken = ++this.mutationToken;
    this.mutationTokens.set(rowKey, mutationToken);
    const isCurrent = () =>
      this.isCurrentSource(client, sourceGeneration) &&
      this.mutationTokens.get(rowKey) === mutationToken;
    this.setBusy(rowKey, true);
    this.setMessage(rowKey, null);
    try {
      const result = await uninstallPlugin(client, pluginId);
      if (!isCurrent()) {
        return;
      }
      this.setPendingRemoval(rowKey, false);
      // The uninstalled row disappears after refresh, so the restart reminder
      // lives in the page-level notice instead of the vanishing row.
      this.pageNotice = {
        kind: "success",
        text: [
          t("pluginsPage.removedRestart", { name: result.pluginId }),
          ...(result.warnings ?? []),
        ]
          .filter(Boolean)
          .join("\n"),
      };
      await this.refreshAfterMutation(client, sourceGeneration);
    } catch (error) {
      if (isCurrent()) {
        this.setMessage(rowKey, { kind: "error", text: errorMessage(error) });
      }
    } finally {
      if (this.mutationTokens.get(rowKey) === mutationToken) {
        this.mutationTokens.delete(rowKey);
        this.setBusy(rowKey, false);
      }
    }
  }

  /**
   * Apply one mutation to config.mcp.servers through the shared config seam.
   * config.patch uses RFC 7396 merge semantics, so `buildPatch` must return a
   * minimal fragment (with explicit nulls for deletions), never a full config.
   */
  private async mutateMcpServers(params: {
    buildPatch: (
      servers: Readonly<Record<string, unknown>>,
    ) => { patch: Record<string, unknown> } | { error: string };
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
      await runtimeConfig.ensureLoaded();
      const base = resolveEditableSnapshotConfig(runtimeConfig.state.configSnapshot);
      if (!base) {
        return fail(t("pluginsPage.mcpConfigUnavailable"));
      }
      const servers = asRecord(asRecord(base.mcp)?.servers) ?? {};
      const built = params.buildPatch(servers);
      if ("error" in built) {
        return fail(built.error);
      }
      const patched = await runtimeConfig.patch({
        raw: { mcp: { servers: built.patch } },
        note: params.note,
      });
      if (!patched) {
        return fail(runtimeConfig.state.lastError ?? t("pluginsPage.mcpConfigUnavailable"));
      }
      await runtimeConfig.refresh();
      this.syncMcpServers();
      this.mcpMessage = { kind: "success", text: params.successText };
      return true;
    } catch (error) {
      return fail(errorMessage(error));
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
      this.mcpMessage = { kind: "error", text: t("pluginsPage.mcpNameInvalid") };
      return;
    }
    const config = parseMcpTarget(form.target);
    if (!config) {
      this.mcpMessage = { kind: "error", text: t("pluginsPage.mcpTargetInvalid") };
      return;
    }
    const added = await this.mutateMcpServers({
      buildPatch: (servers) =>
        servers[name]
          ? { error: t("pluginsPage.mcpNameTaken", { name }) }
          : { patch: { [name]: config } },
      note: `plugins: add MCP server ${name}`,
      successText: t("pluginsPage.mcpAddedSuccess", { name }),
    });
    if (added) {
      this.mcpFormOpen = false;
    }
  }

  private async toggleMcpServer(name: string, enabled: boolean) {
    await this.mutateMcpServers({
      buildPatch: (servers) =>
        servers[name]
          ? // Enabling deletes the key so the config keeps its enabled-by-default shape.
            { patch: { [name]: { enabled: enabled ? null : false } } }
          : { error: t("pluginsPage.mcpMissing", { name }) },
      note: `plugins: ${enabled ? "enable" : "disable"} MCP server ${name}`,
      successText: t(enabled ? "pluginsPage.enabledSuccess" : "pluginsPage.disabledSuccess", {
        name,
      }),
    });
  }

  private async removeMcpServer(name: string) {
    await this.mutateMcpServers({
      buildPatch: (servers) =>
        servers[name]
          ? { patch: { [name]: null } }
          : { error: t("pluginsPage.mcpMissing", { name }) },
      note: `plugins: remove MCP server ${name}`,
      successText: t("pluginsPage.mcpRemovedSuccess", { name }),
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
        servers[mcp.serverName]
          ? { error: t("pluginsPage.mcpNameTaken", { name: mcp.serverName }) }
          : { patch: { [mcp.serverName]: structuredClone(mcp.config) } },
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
      <section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${titleForRoute("plugins")}</h1>
          <div class="page-sub">${subtitleForRoute("plugins")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(html`
        <div class="plugins-hub-tabs-row">
          ${renderPluginsHubTabs({
            active: this.activeTab,
            installedCount: this.result?.plugins.filter((plugin) => plugin.installed).length ?? 0,
            onSelect: (tab) => this.selectHubTab(tab),
          })}
        </div>
        ${renderPlugins({
          connected: this.connected,
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
          onShowDetails: (pluginId) => {
            this.detailPluginId = pluginId;
          },
          onSetEnabled: (pluginId, enabled, rowKey) =>
            void this.updateEnabled(pluginId, enabled, rowKey),
          onInstall: (rowKey, request) => void this.install(rowKey, request),
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
