// Controller for the Memory destination page. The URL owns the active tab;
// this element owns the shared agent selection, Overview status, and global
// configuration controllers used by Settings.
import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/schema/system-info.ts";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  loadPluginCatalog,
  setPluginEnabled,
  type PluginCatalogItem,
} from "../../lib/plugins/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  resolveConfiguredDreaming,
  resolveDreamingConfigPathSupport,
  type DreamingConfigPathSupport,
} from "../agents/memory/dreaming.ts";
import "./memory-dreaming-page.ts";
import "./memory-memories.ts";
import { renderDreamingSettings, renderDreamingUnsupported } from "./memory-dreaming.ts";
import { renderMemoryOverview, type MemoryOverviewStatus } from "./memory-overview.ts";
import {
  canonicalMemoryRouteLocation,
  DEFAULT_MEMORY_ENGINE_ID,
  memoryTabForRoute,
  memorySchemaKeysForTab,
  resolveMemoryBackend,
  resolveMemoryEngineSelection,
  selectedEngineId,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";
import {
  renderMemory,
  type MemoryAddonRow,
  type MemoryEngineOption,
  type MemoryPluginState,
} from "./memory.ts";
import type { ConfigRouteData } from "./route-data.ts";

const MEMORY_ADDON_PLUGINS = [
  { id: "active-memory", labelKey: "memoryPage.addons.activeMemory.title" },
  { id: "memory-wiki", labelKey: "memoryPage.addons.memoryWiki.title" },
] as const;

/** Explicit-off sentinel; resolveSlotSelection maps it to an `off` selection. */
const MEMORY_SLOT_OFF = "none";
const MEMORY_SLOT_PATH = ["plugins", "slots", "memory"];
const DREAMING_DOCS_URL = "https://docs.openclaw.ai/concepts/dreaming";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

/** Object identity is the connection generation for both catalog and status reads. */
type CatalogConnection = {
  client: GatewayClient | null;
  connected: boolean;
};

type MemoryCatalog =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; plugins: readonly PluginCatalogItem[]; mutationAllowed: boolean };

type MemoryAddonNotice = {
  message: string;
  processInstanceId: string | null;
};

type MemoryPageProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  memoryImportHref: string;
  routeData: ConfigRouteData | null;
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

function isMemoryEngine(plugin: PluginCatalogItem): boolean {
  return plugin.installed && plugin.kind?.includes("memory") === true;
}

function pluginState(
  catalog: MemoryCatalog,
  entry: PluginCatalogItem | undefined,
): MemoryPluginState {
  switch (catalog.kind) {
    case "loading":
      return "loading";
    case "unavailable":
      return "unknown";
    default:
      if (!entry?.installed || entry.state === "not-installed" || entry.state === "error") {
        return "unknown";
      }
      return entry.enabled ? "enabled" : "disabled";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MemorySettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property() pluginsHref = "";
  @property() memoryImportHref = "";
  @property({ attribute: false }) routeData: ConfigRouteData | null = null;
  @property({ attribute: false }) buildEditor: MemoryPageProps["buildEditor"] = () => html``;

  @state() private catalog: MemoryCatalog = { kind: "unavailable" };
  @state() private engineBusy = false;
  @state() private engineError: string | null = null;
  @state() private addonBusy = new Set<string>();
  @state() private addonErrors = new Map<string, string>();
  @state() private addonNotices = new Map<string, MemoryAddonNotice>();
  @state() private selectedAgentId: string | null = null;
  @state() private overviewStatus: MemoryOverviewStatus = { kind: "idle" };
  @state() private probingEmbeddings = false;
  @state() private support: DreamingConfigPathSupport = "unknown";

  private connection: CatalogConnection | null = null;
  private catalogRequest = 0;
  private overviewRequest: {
    connection: CatalogConnection;
    agentId: string;
    probeEmbeddings: boolean;
  } | null = null;
  private supportPluginId: string | null = null;
  private supportProbe: { pluginId: string } | null = null;
  private normalizedLocation = "";

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) =>
        this.syncGateway(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.syncSupport(runtimeConfig),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      (agents) => {
        if (!agents.state.agentsList && !agents.state.agentsLoading) {
          void agents.ensureList().catch(() => undefined);
        }
        void this.loadOverviewStatus();
      },
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.connection = null;
    this.overviewRequest = null;
    this.probingEmbeddings = false;
    this.catalog = { kind: "unavailable" };
    this.supportPluginId = null;
    this.supportProbe = null;
    super.disconnectedCallback();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncCanonicalLocation();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      const previous = this.activeTab(
        (changed.get("routeData") as ConfigRouteData | null | undefined) ?? null,
      );
      const current = this.activeTab();
      if (previous !== current) {
        this.overviewRequest = null;
        this.probingEmbeddings = false;
        void this.loadOverviewStatus();
      }
      this.syncCanonicalLocation();
    }
    if (changed.has("configObject")) {
      const previous = changed.get("configObject") as Record<string, unknown> | undefined;
      const previousEngine = previous
        ? selectedEngineId(resolveMemoryEngineSelection(previous))
        : null;
      const currentEngine = selectedEngineId(resolveMemoryEngineSelection(this.configObject));
      if (previous && previousEngine !== currentEngine) {
        this.overviewRequest = null;
        this.probingEmbeddings = false;
        void this.loadOverviewStatus();
      }
    }
  }

  private activeTab(routeData = this.routeData): MemoryTab {
    return memoryTabForRoute(routeData ?? {}, this.context?.basePath ?? "") ?? "overview";
  }

  private syncCanonicalLocation() {
    const context = this.context;
    const routeData = this.routeData;
    if (!context || !routeData) {
      return;
    }
    const canonical = canonicalMemoryRouteLocation(routeData, context.basePath);
    if (!canonical) {
      this.normalizedLocation = "";
      return;
    }
    const source = `${routeData.pathname}${routeData.search}${routeData.hash}`;
    if (this.normalizedLocation === source) {
      return;
    }
    // One source location gets one replace. Route-data updates clear the guard
    // once the canonical path arrives, so returning to an old link still works.
    this.normalizedLocation = source;
    context.replace("memory", canonical);
  }

  private syncGateway(client: GatewayClient | null, connected: boolean) {
    if (this.connection?.client === client && this.connection.connected === connected) {
      return;
    }
    const connection: CatalogConnection = { client, connected };
    this.connection = connection;
    this.overviewRequest = null;
    this.probingEmbeddings = false;
    if (!client || !connected) {
      this.catalog = { kind: "unavailable" };
      if (this.activeTab() === "overview") {
        this.overviewStatus = {
          kind: "error",
          message: t("memoryPage.overview.hero.gatewayOffline"),
        };
      }
      return;
    }
    this.catalog = { kind: "loading" };
    void this.loadCatalog(client, connection);
    void this.reconcileAddonNotices(client, connection);
    void this.loadOverviewStatus();
  }

  private async readProcessInstanceId(client: GatewayClient): Promise<string | null> {
    if (!isGatewayMethodAdvertised(this.context.gateway.snapshot, "system.info")) {
      return null;
    }
    try {
      const info = await client.request<SystemInfoResult>("system.info", {});
      return info.processInstanceId ?? null;
    } catch {
      return null;
    }
  }

  private async reconcileAddonNotices(client: GatewayClient, connection: CatalogConnection) {
    if (this.addonNotices.size === 0) {
      return;
    }
    const processInstanceId = await this.readProcessInstanceId(client);
    if (!processInstanceId || !this.isConnected || this.connection !== connection) {
      return;
    }
    const notices = new Map<string, MemoryAddonNotice>();
    for (const [pluginId, notice] of this.addonNotices) {
      if (notice.processInstanceId === null) {
        notices.set(pluginId, { ...notice, processInstanceId });
      } else if (notice.processInstanceId === processInstanceId) {
        notices.set(pluginId, notice);
      }
    }
    if (
      notices.size !== this.addonNotices.size ||
      [...notices].some(([pluginId, notice]) => this.addonNotices.get(pluginId) !== notice)
    ) {
      this.addonNotices = notices;
    }
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    const request = ++this.catalogRequest;
    try {
      const result = await loadPluginCatalog(client);
      this.applyCatalog(connection, request, {
        kind: "ready",
        plugins: result.plugins,
        mutationAllowed: result.mutationAllowed,
      });
    } catch {
      this.applyCatalog(connection, request, { kind: "unavailable" });
    }
  }

  private applyCatalog(connection: CatalogConnection, request: number, catalog: MemoryCatalog) {
    if (!this.isConnected || this.connection !== connection || this.catalogRequest !== request) {
      return;
    }
    this.catalog = catalog;
  }

  private resolveAgentId(): string | null {
    const agentsList = this.context.agents.state.agentsList;
    const selectable = listSelectableAgents(agentsList?.agents ?? []);
    if (this.selectedAgentId && selectable.some((agent) => agent.id === this.selectedAgentId)) {
      return this.selectedAgentId;
    }
    return agentsList?.defaultId ?? selectable[0]?.id ?? null;
  }

  private agentOptions(): AgentSelectOption[] {
    return listSelectableAgents(this.context.agents.state.agentsList?.agents ?? []).map(
      (agent) => ({
        value: agent.id,
        label: normalizeAgentLabel(agent),
        agent,
      }),
    );
  }

  private selectAgent(agentId: string | null) {
    if (this.selectedAgentId === agentId) {
      return;
    }
    this.selectedAgentId = agentId;
    this.overviewRequest = null;
    this.probingEmbeddings = false;
    void this.loadOverviewStatus();
  }

  private async loadOverviewStatus(options: { force?: boolean; probeEmbeddings?: boolean } = {}) {
    if (this.activeTab() !== "overview") {
      return;
    }
    if (resolveMemoryEngineSelection(this.configObject).kind === "off") {
      this.overviewRequest = null;
      this.overviewStatus = { kind: "idle" };
      this.probingEmbeddings = false;
      return;
    }
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    const agentId = this.resolveAgentId();
    if (!connection || !client) {
      this.overviewStatus = {
        kind: "error",
        message: t("memoryPage.overview.hero.gatewayOffline"),
      };
      this.probingEmbeddings = false;
      return;
    }
    if (!agentId) {
      return;
    }
    if (
      !options.force &&
      this.overviewRequest?.connection === connection &&
      this.overviewRequest.agentId === agentId
    ) {
      return;
    }
    const probeEmbeddings = options.probeEmbeddings === true;
    const request = { connection, agentId, probeEmbeddings };
    this.overviewRequest = request;
    this.probingEmbeddings = probeEmbeddings;
    if (!probeEmbeddings) {
      this.overviewStatus = { kind: "loading" };
    }
    try {
      const payload = await client.request<DoctorMemoryStatusPayload>("doctor.memory.status", {
        agentId,
        ...(probeEmbeddings ? { probe: true } : {}),
      });
      if (!this.isConnected || this.overviewRequest !== request) {
        return;
      }
      this.overviewStatus = { kind: "ready", payload };
    } catch (error) {
      if (!this.isConnected || this.overviewRequest !== request) {
        return;
      }
      this.overviewStatus = { kind: "error", message: errorMessage(error) };
    } finally {
      if (this.overviewRequest === request) {
        this.probingEmbeddings = false;
      }
    }
  }

  private engineOptions(): MemoryEngineOption[] {
    if (this.catalog.kind !== "ready") {
      return [];
    }
    return this.catalog.plugins
      .filter(isMemoryEngine)
      .map((plugin) => ({ id: plugin.id, label: plugin.name }))
      .toSorted((left, right) => {
        const leftIsDefault = left.id === DEFAULT_MEMORY_ENGINE_ID;
        const rightIsDefault = right.id === DEFAULT_MEMORY_ENGINE_ID;
        if (leftIsDefault !== rightIsDefault) {
          return leftIsDefault ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
  }

  private engineState(selection: MemoryEngineSelection): MemoryPluginState {
    const engineId = selectedEngineId(selection);
    if (engineId === null) {
      return "unknown";
    }
    const catalog = this.catalog;
    const entry =
      catalog.kind === "ready"
        ? catalog.plugins.find((plugin) => plugin.id === engineId)
        : undefined;
    return pluginState(catalog, entry);
  }

  private addonRows(): MemoryAddonRow[] {
    const catalog = this.catalog;
    return MEMORY_ADDON_PLUGINS.map((addon) => {
      const entry =
        catalog.kind === "ready"
          ? catalog.plugins.find((plugin) => plugin.id === addon.id)
          : undefined;
      return {
        id: addon.id,
        label: t(addon.labelKey),
        description: entry?.description ?? addon.id,
        state: pluginState(catalog, entry),
        busy: this.addonBusy.has(addon.id),
        error: this.addonErrors.get(addon.id) ?? null,
        notice: this.addonNotices.get(addon.id)?.message ?? null,
      };
    });
  }

  private async changeAddon(pluginId: string, enabled: boolean) {
    if (
      this.addonBusy.has(pluginId) ||
      this.catalog.kind !== "ready" ||
      !this.catalog.mutationAllowed ||
      !readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin
    ) {
      return;
    }
    const catalog = this.catalog;
    const entry =
      catalog.kind === "ready"
        ? catalog.plugins.find((plugin) => plugin.id === pluginId)
        : undefined;
    const addonState = pluginState(catalog, entry);
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client || (addonState !== "enabled" && addonState !== "disabled")) {
      return;
    }
    this.addonBusy = new Set(this.addonBusy).add(pluginId);
    const errors = new Map(this.addonErrors);
    errors.delete(pluginId);
    this.addonErrors = errors;
    try {
      try {
        const processInstanceIdPromise = this.readProcessInstanceId(client);
        const result = await setPluginEnabled(client, pluginId, enabled);
        if (result.restartRequired) {
          const key = enabled ? "pluginsPage.enabledRestart" : "pluginsPage.disabledRestart";
          const warnings = "warnings" in result ? (result.warnings ?? []) : [];
          const processInstanceId = await processInstanceIdPromise;
          this.addonNotices = new Map(this.addonNotices).set(pluginId, {
            message: [t(key, { name: result.plugin.name }), ...warnings].filter(Boolean).join(" "),
            processInstanceId,
          });
          const currentConnection = this.connection;
          if (currentConnection?.connected && currentConnection.client) {
            void this.reconcileAddonNotices(currentConnection.client, currentConnection);
          }
        } else {
          const notices = new Map(this.addonNotices);
          notices.delete(pluginId);
          this.addonNotices = notices;
        }
      } catch (error) {
        this.addonErrors = new Map(this.addonErrors).set(pluginId, errorMessage(error));
        return;
      }
      const currentConnection = this.connection;
      const catalogReload =
        currentConnection?.connected && currentConnection.client
          ? this.loadCatalog(currentConnection.client, currentConnection)
          : Promise.resolve();
      await Promise.allSettled([this.context.runtimeConfig.refresh(), catalogReload]);
    } finally {
      const busy = new Set(this.addonBusy);
      busy.delete(pluginId);
      this.addonBusy = busy;
    }
  }

  private async changeEngine(engineId: string | null, currentSelection: MemoryEngineSelection) {
    if (this.engineBusy) {
      return;
    }
    if (engineId === selectedEngineId(currentSelection)) {
      if (engineId === null || this.engineState(currentSelection) === "enabled") {
        return;
      }
    }
    if (!engineId) {
      this.engineError = null;
      this.context.runtimeConfig.patchForm(MEMORY_SLOT_PATH, MEMORY_SLOT_OFF);
      return;
    }
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client) {
      return;
    }
    this.engineBusy = true;
    this.engineError = null;
    try {
      // `Off` is an autosaved form edit. Let it adopt its ack hash before the
      // plugin RPC performs its own CAS write, or rapid Off -> engine changes
      // can race each other and reject the second write as stale.
      await this.context.runtimeConfig.waitForPendingWrites();
      await setPluginEnabled(client, engineId, true);
      await this.context.runtimeConfig.refresh();
      await this.loadCatalog(client, connection);
    } catch (error) {
      this.engineError = errorMessage(error);
    } finally {
      this.engineBusy = false;
    }
  }

  private configObjectFromController(): Record<string, unknown> | null {
    return currentConfigObject(this.context.runtimeConfig.state);
  }

  private dreamingPluginId(): string {
    return resolveConfiguredDreaming(this.configObjectFromController()).pluginId;
  }

  private dreamingConfig(): Record<string, unknown> | null {
    const plugins = asConfigRecord(this.configObjectFromController()?.plugins);
    const entry = asConfigRecord(asConfigRecord(plugins?.entries)?.[this.dreamingPluginId()]);
    return asConfigRecord(asConfigRecord(entry?.config)?.dreaming);
  }

  private syncSupport(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const pluginId = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state)).pluginId;
    if (pluginId !== this.supportPluginId) {
      this.supportPluginId = pluginId;
      this.support = "unknown";
    }
    const connected = runtimeConfig.state.connected;
    if (this.supportProbe && (this.supportProbe.pluginId !== pluginId || !connected)) {
      this.supportProbe = null;
    }
    if (this.support !== "unknown" || this.supportProbe || !connected) {
      return;
    }
    const probe = { pluginId };
    this.supportProbe = probe;
    void resolveDreamingConfigPathSupport(runtimeConfig, pluginId).then((support) => {
      if (this.supportProbe !== probe) {
        return;
      }
      this.supportProbe = null;
      if (this.isConnected) {
        this.support = support;
      }
    });
  }

  private patchDreaming(path: readonly string[], value: unknown) {
    const runtimeConfig = this.context.runtimeConfig;
    const writePath = [
      "plugins",
      "entries",
      this.dreamingPluginId(),
      "config",
      "dreaming",
      ...path,
    ];
    if (value === undefined) {
      runtimeConfig.removeFormValue(writePath);
      return;
    }
    runtimeConfig.patchForm(writePath, value);
  }

  private renderDreamingControls() {
    const pluginId = this.dreamingPluginId();
    return html`
      <p class="settings-page__intro">
        ${t("memoryPage.dreaming.intro", { plugin: pluginId })}
        ${renderDocsLink(DREAMING_DOCS_URL, t("common.learnMore"))}
      </p>
      ${this.support === "unsupported"
        ? renderDreamingUnsupported(pluginId)
        : renderDreamingSettings({
            dreaming: this.dreamingConfig(),
            onPatch: (path, value) => this.patchDreaming(path, value),
          })}
    `;
  }

  private navigateTab(tab: MemoryTab) {
    this.context.navigate("memory", {
      pathname: pathForMemoryTab(tab, this.context.basePath),
    });
  }

  override render() {
    const runtimeConfig = this.context.runtimeConfig;
    const engineSelection = resolveMemoryEngineSelection(this.configObject);
    const backend = resolveMemoryBackend(this.configObject);
    const activeTab = this.activeTab();
    const agentId = this.resolveAgentId();
    const agents = this.agentOptions();
    return renderMemory({
      activeTab,
      onTabChange: (tab) => this.navigateTab(tab),
      engineOptions: this.engineOptions(),
      engineSelection,
      engineState: this.engineState(engineSelection),
      engineBusy: this.engineBusy,
      engineError: this.engineError,
      onEngineChange: (nextEngineId) => void this.changeEngine(nextEngineId, engineSelection),
      backend,
      backendBusy: runtimeConfig.state.configSaving || runtimeConfig.state.configApplying,
      onBackendChange: (next) => runtimeConfig.patchForm(["memory", "backend"], next),
      addons: this.addonRows(),
      canToggleAddons:
        this.catalog.kind === "ready" &&
        this.catalog.mutationAllowed &&
        readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin,
      onAddonChange: (pluginId, enabled) => void this.changeAddon(pluginId, enabled),
      pluginsHref: this.pluginsHref,
      memoryImportHref: this.memoryImportHref,
      agentId,
      agents,
      onAgentChange: (next) => this.selectAgent(next),
      overview: renderMemoryOverview({
        agentId,
        engineSelection,
        engineDisabled: this.engineState(engineSelection) === "disabled",
        status: this.overviewStatus,
        probingEmbeddings: this.probingEmbeddings,
        onRefresh: () => void this.loadOverviewStatus({ force: true }),
        onProbeEmbeddings: () =>
          void this.loadOverviewStatus({ force: true, probeEmbeddings: true }),
        onNavigate: (tab) => this.navigateTab(tab),
      }),
      memories: html`
        <openclaw-memory-memories
          .client=${this.context.gateway.snapshot.client}
          .connected=${this.context.gateway.snapshot.phase === "connected"}
          .methodAdvertised=${isGatewayMethodAdvertised(
            this.context.gateway.snapshot,
            "memory.search",
          ) === true}
          .agentId=${agentId}
        ></openclaw-memory-memories>
      `,
      dreams: html` <openclaw-memory-dreaming .agentId=${agentId}></openclaw-memory-dreaming> `,
      editor:
        activeTab === "settings"
          ? this.buildEditor(memorySchemaKeysForTab("settings", backend))
          : html``,
      dreamingSettings: activeTab === "settings" ? this.renderDreamingControls() : html``,
    });
  }
}

if (!customElements.get("openclaw-memory-settings")) {
  customElements.define("openclaw-memory-settings", MemorySettingsPage);
}

export function renderMemoryPage(props: MemoryPageProps) {
  return html`
    <openclaw-memory-settings
      .configObject=${props.configObject}
      .pluginsHref=${props.pluginsHref}
      .memoryImportHref=${props.memoryImportHref}
      .routeData=${props.routeData}
      .buildEditor=${props.buildEditor}
    ></openclaw-memory-settings>
  `;
}
