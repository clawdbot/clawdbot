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
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  loadPluginCatalog,
  runPluginConfigMutation,
  setPluginEnabled,
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
import { dreamingConfigPath, resolveDreamingTimezoneDefault } from "./memory-defaults.ts";
import { renderDreamingSettings, renderDreamingUnsupported } from "./memory-dreaming.ts";
import { renderMemoryOverview, type MemoryOverviewStatus } from "./memory-overview.ts";
import {
  canonicalMemoryRouteLocation,
  memoryTabForRoute,
  memorySchemaKeysForTab,
  resolveMemoryEngineSelection,
  selectedEngineId,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";
import {
  buildMemoryAddonRows,
  buildMemoryEngineOptions,
  renderMemory,
  findMemoryCatalogPlugin as findMemoryPlugin,
  resolveMemoryPluginState as pluginState,
  type MemoryCatalogState as MemoryCatalog,
  type MemoryEngineOutcome,
  type MemoryPluginState,
} from "./memory.ts";
import type { ConfigRouteData } from "./route-data.ts";

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

type MemoryAddonNotice = {
  message: string;
  processInstanceId: string | null;
};

type MemoryPageProps = {
  configObject: Record<string, unknown>;
  mutationDisabled: boolean;
  pluginsHref: string;
  memoryImportHref: string;
  routeData: ConfigRouteData | null;
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

class MemorySettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property({ type: Boolean }) mutationDisabled = false;
  @property() pluginsHref = "";
  @property() memoryImportHref = "";
  @property({ attribute: false }) routeData: ConfigRouteData | null = null;
  @property({ attribute: false }) buildEditor: MemoryPageProps["buildEditor"] = () => html``;

  @state() private catalog: MemoryCatalog = { kind: "unavailable" };
  @state() private engineBusy = false;
  @state() private engineOutcome: MemoryEngineOutcome | null = null;
  @state() private addonBusy = new Set<string>();
  @state() private addonErrors = new Map<string, string>();
  @state() private addonNotices = new Map<string, MemoryAddonNotice>();
  @state() private addonRefreshWarnings = new Map<string, string>();
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
  private readonly addonNoticeOperations = new Map<string, object>();
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
    this.addonNoticeOperations.clear();
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
    this.engineBusy = false;
    this.engineOutcome = null;
    this.addonBusy = new Set();
    this.addonRefreshWarnings = new Map();
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
      this.overviewStatus = {
        kind: "error",
        message: formatUiError(error),
      };
    } finally {
      if (this.overviewRequest === request) {
        this.probingEmbeddings = false;
      }
    }
  }

  private engineState(selection: MemoryEngineSelection): MemoryPluginState {
    const engineId = selectedEngineId(selection);
    return engineId === null
      ? "unknown"
      : pluginState(this.catalog, findMemoryPlugin(this.catalog, engineId));
  }

  private applyPluginRefreshOutcome(
    connection: CatalogConnection,
    refreshError: string | null,
    pluginId?: string,
  ) {
    if (this.connection !== connection) {
      return;
    }
    if (!refreshError) {
      this.addonRefreshWarnings = new Map();
      if (this.engineOutcome?.kind === "warning") {
        this.engineOutcome = null;
      }
      return;
    }
    const message = t("pluginsPage.configRefreshFailed", { error: refreshError });
    if (pluginId) {
      this.addonRefreshWarnings = new Map(this.addonRefreshWarnings).set(pluginId, message);
    } else {
      this.engineOutcome = { kind: "warning", message };
    }
  }

  private async changeAddon(pluginId: string, enabled: boolean) {
    if (
      this.addonBusy.has(pluginId) ||
      this.mutationDisabled ||
      this.catalog.kind !== "ready" ||
      !this.catalog.mutationAllowed ||
      !readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin
    ) {
      return;
    }
    const entry = findMemoryPlugin(this.catalog, pluginId);
    const addonState = pluginState(this.catalog, entry);
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client || (addonState !== "enabled" && addonState !== "disabled")) {
      return;
    }
    const noticeOperation = {};
    this.addonNoticeOperations.set(pluginId, noticeOperation);
    this.addonBusy = new Set(this.addonBusy).add(pluginId);
    const errors = new Map(this.addonErrors);
    errors.delete(pluginId);
    this.addonErrors = errors;
    const refreshWarnings = new Map(this.addonRefreshWarnings);
    refreshWarnings.delete(pluginId);
    this.addonRefreshWarnings = refreshWarnings;
    try {
      const mutation = await runPluginConfigMutation(
        this.context.runtimeConfig,
        client,
        async (current) => {
          const processInstanceId = this.readProcessInstanceId(current);
          return {
            result: await setPluginEnabled(current, pluginId, enabled),
            processInstanceId,
          };
        },
      );
      const { result, processInstanceId } = mutation.value;
      const key = enabled ? "pluginsPage.enabledRestart" : "pluginsPage.disabledRestart";
      const warnings = "warnings" in result ? (result.warnings ?? []) : [];
      const notice = [
        result.restartRequired ? t(key, { name: result.plugin.name }) : null,
        ...warnings,
      ]
        .filter(Boolean)
        .join(" ");
      if (this.addonNoticeOperations.get(pluginId) === noticeOperation) {
        this.applyPluginRefreshOutcome(connection, mutation.refreshError, pluginId);
        const noticeProcessInstanceId = notice ? await processInstanceId : null;
        if (this.addonNoticeOperations.get(pluginId) === noticeOperation) {
          const notices = new Map(this.addonNotices);
          if (notice) {
            notices.set(pluginId, {
              message: notice,
              processInstanceId: noticeProcessInstanceId,
            });
          } else {
            notices.delete(pluginId);
          }
          this.addonNotices = notices;
          if (notice) {
            const noticeConnection = this.connection;
            if (noticeConnection?.connected && noticeConnection.client) {
              void this.reconcileAddonNotices(noticeConnection.client, noticeConnection);
            }
          }
        }
      }
      const currentConnection = this.connection;
      if (currentConnection?.connected && currentConnection.client) {
        await this.loadCatalog(currentConnection.client, currentConnection);
      }
    } catch (error) {
      if (this.connection === connection) {
        this.addonErrors = new Map(this.addonErrors).set(pluginId, formatUiError(error));
      }
    } finally {
      if (this.addonNoticeOperations.get(pluginId) === noticeOperation) {
        this.addonNoticeOperations.delete(pluginId);
      }
      if (this.connection === connection) {
        const busy = new Set(this.addonBusy);
        busy.delete(pluginId);
        this.addonBusy = busy;
      }
    }
  }

  private async changeEngine(engineId: string | null, currentSelection: MemoryEngineSelection) {
    if (
      this.engineBusy ||
      this.mutationDisabled ||
      (this.catalog.kind === "ready" && !this.catalog.mutationAllowed)
    ) {
      return;
    }
    if (engineId === selectedEngineId(currentSelection)) {
      if (engineId === null || this.engineState(currentSelection) === "enabled") {
        return;
      }
    }
    this.engineOutcome = null;
    if (!engineId) {
      this.context.runtimeConfig.patchForm(MEMORY_SLOT_PATH, MEMORY_SLOT_OFF);
      return;
    }
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client) {
      return;
    }
    this.engineBusy = true;
    try {
      const mutation = await runPluginConfigMutation(
        this.context.runtimeConfig,
        client,
        (current) => setPluginEnabled(current, engineId, true),
      );
      this.applyPluginRefreshOutcome(connection, mutation.refreshError);
      const currentConnection = this.connection;
      if (currentConnection?.connected && currentConnection.client) {
        await this.loadCatalog(currentConnection.client, currentConnection);
      }
    } catch (error) {
      if (this.connection === connection) {
        this.engineOutcome = {
          kind: "error",
          message: formatUiError(error),
        };
      }
    } finally {
      if (this.connection === connection) {
        this.engineBusy = false;
      }
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
    if (this.mutationDisabled) {
      return;
    }
    const writePath = dreamingConfigPath(this.dreamingPluginId(), path);
    if (value === undefined) {
      this.context.runtimeConfig.removeFormValue(writePath);
      return;
    }
    this.context.runtimeConfig.patchForm(writePath, value);
  }

  private renderDreamingControls() {
    const pluginId = this.dreamingPluginId();
    return html`
      <p class="settings-page__intro">
        ${t("memoryPage.dreaming.intro", { plugin: pluginId })}
        ${renderLearnMoreLink(DREAMING_DOCS_URL)}
      </p>
      ${
        this.support === "unsupported"
          ? renderDreamingUnsupported(pluginId)
          : renderDreamingSettings({
              dreaming: this.dreamingConfig(),
              timezoneDefault: resolveDreamingTimezoneDefault(this.configObjectFromController()),
              disabled: this.mutationDisabled,
              onPatch: (path, value) => this.patchDreaming(path, value),
            })
      }
    `;
  }

  private navigateTab(tab: MemoryTab) {
    this.context.navigate("memory", {
      pathname: pathForMemoryTab(tab, this.context.basePath),
    });
  }

  override render() {
    const engineSelection = resolveMemoryEngineSelection(this.configObject);
    const engineMutationDisabled =
      this.mutationDisabled || (this.catalog.kind === "ready" && !this.catalog.mutationAllowed);
    const activeTab = this.activeTab();
    const agentId = this.resolveAgentId();
    return renderMemory({
      activeTab,
      onTabChange: (tab) => this.navigateTab(tab),
      engineOptions: buildMemoryEngineOptions(this.catalog, engineSelection),
      engineSelection,
      engineState: this.engineState(engineSelection),
      engineBusy: this.engineBusy || engineMutationDisabled,
      engineOutcome: this.engineOutcome,
      onEngineChange: (nextEngineId) => void this.changeEngine(nextEngineId, engineSelection),
      addons: buildMemoryAddonRows(this.catalog, {
        busy: this.addonBusy,
        errors: this.addonErrors,
        notices: this.addonNotices,
        refreshWarnings: this.addonRefreshWarnings,
      }),
      canToggleAddons:
        this.catalog.kind === "ready" &&
        this.catalog.mutationAllowed &&
        !this.mutationDisabled &&
        readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin,
      onAddonChange: (pluginId, enabled) => void this.changeAddon(pluginId, enabled),
      pluginsHref: this.pluginsHref,
      memoryImportHref: this.memoryImportHref,
      canImportMemory: readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin,
      agentId,
      agents: this.agentOptions(),
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
          .methodAdvertised=${
            isGatewayMethodAdvertised(this.context.gateway.snapshot, "memory.search") === true
          }
          .agentId=${agentId}
        ></openclaw-memory-memories>
      `,
      dreams: html` <openclaw-memory-dreaming .agentId=${agentId}></openclaw-memory-dreaming> `,
      editor:
        activeTab === "settings" ? this.buildEditor(memorySchemaKeysForTab("settings")) : html``,
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
      .mutationDisabled=${props.mutationDisabled}
      .pluginsHref=${props.pluginsHref}
      .memoryImportHref=${props.memoryImportHref}
      .routeData=${props.routeData}
      .buildEditor=${props.buildEditor}
    ></openclaw-memory-settings>
  `;
}
