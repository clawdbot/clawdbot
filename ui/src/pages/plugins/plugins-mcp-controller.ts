import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { McpServerForm } from "../../components/mcp-server-form.ts";
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
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { ConnectorSuggestion } from "./presentation.ts";
import { connectorRowKey, type PluginRowMessage } from "./view.ts";

type PluginsMcpControllerHost = {
  element: ReactiveControllerHost;
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
  canMutate: () => boolean;
  setRowBusy: (rowKey: string, busy: boolean) => void;
  setRowMessage: (rowKey: string, message: PluginRowMessage | null) => void;
};

export class PluginsMcpController {
  private servers: McpServerSummary[] | null = null;
  private message: PluginRowMessage | null = null;
  private busy = false;
  private busyKey: string | null = null;
  private formOpen = false;
  private feedbackGeneration = 0;
  private readonly configTask: Task<
    readonly [
      ApplicationContext["gateway"]["snapshot"]["client"],
      ApplicationContext["runtimeConfig"] | null,
    ],
    string | null
  >;
  private readonly subscriptions: SubscriptionsController;

  constructor(private readonly host: PluginsMcpControllerHost) {
    this.configTask = new Task(host.element, {
      autoRun: false,
      args: () =>
        [
          this.host.gateway.connected ? this.host.gateway.client : null,
          this.host.getContext()?.runtimeConfig ?? null,
        ] as const,
      task: async ([client, runtimeConfig]) => {
        if (!client || !runtimeConfig) {
          return initialState;
        }
        await runtimeConfig.refresh();
        return runtimeConfig.state.lastError;
      },
      onComplete: () => {
        this.syncServers();
      },
      onError: () => {
        this.syncServers();
      },
    });
    this.subscriptions = new SubscriptionsController(host.element).effect(
      () => this.host.getContext()?.runtimeConfig,
      (runtimeConfig) => {
        this.syncServers();
        const unsubscribe = runtimeConfig.subscribe(() => this.syncServers());
        return () => {
          this.resetFeedback();
          unsubscribe();
        };
      },
    );
  }

  private get refreshError(): string | null {
    const failure =
      this.configTask.status === TaskStatus.ERROR
        ? formatUiError(this.configTask.error)
        : this.configTask.status === TaskStatus.COMPLETE
          ? this.configTask.value
          : null;
    return failure ? t("pluginsPage.configRefreshFailed", { error: failure }) : null;
  }

  get viewState() {
    return {
      mcpSettingsHref: pathForRoute("mcp", this.host.getContext()?.basePath ?? ""),
      mcpServers: this.servers,
      mcpMessage: this.message,
      mcpBusy: this.busy,
      mcpFormOpen: this.formOpen,
      onAddConnector: (connector: ConnectorSuggestion) => void this.addConnector(connector),
      onMcpToggle: (name: string, enabled: boolean) => void this.toggleServer(name, enabled),
      onMcpRemove: (name: string) => void this.removeServer(name),
      onMcpFormToggle: (open: boolean) => {
        this.formOpen = open;
        if (open) {
          this.message = null;
        }
        this.host.element.requestUpdate();
      },
      onMcpAdd: (form: McpServerForm) => void this.addServer(form),
    };
  }

  disconnect(): void {
    this.subscriptions.clear();
  }

  invalidate(): void {
    void this.configTask.run([null, this.host.getContext().runtimeConfig]);
  }

  syncServers(): void {
    const snapshot = this.host.getContext()?.runtimeConfig.state.configSnapshot;
    this.servers = summarizeMcpServers(resolveEditableSnapshotConfig(snapshot));
    this.host.element.requestUpdate();
  }

  resetFeedback(): void {
    this.feedbackGeneration += 1;
    this.busy = false;
    this.message = null;
    if (this.busyKey) {
      this.host.setRowBusy(this.busyKey, false);
      this.busyKey = null;
    }
    this.host.element.requestUpdate();
  }

  ensureLoaded(connected: boolean): void {
    if (!connected) {
      return;
    }
    void this.host
      .getContext()
      ?.runtimeConfig.ensureLoaded()
      .then(() => this.syncServers());
  }

  pageError(catalogError: string | null): string | null {
    const errors = [catalogError, this.refreshError].filter((message): message is string =>
      Boolean(message),
    );
    return errors.length > 0 ? errors.join(" ") : null;
  }

  async refreshPage(refreshCatalog: () => Promise<void>): Promise<void> {
    await Promise.all([refreshCatalog(), this.refresh()]);
  }

  private async refresh(): Promise<void> {
    const client = this.host.gateway.client;
    if (!client || !this.host.gateway.connected) {
      return;
    }
    const runtimeConfig = this.host.getContext().runtimeConfig;
    await this.configTask.run([client, runtimeConfig]);
  }

  async addServer(form: McpServerForm): Promise<void> {
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      this.message = { kind: "error", text: t("mcpServers.nameInvalid") };
      this.host.element.requestUpdate();
      return;
    }
    const config = parseMcpTarget(form.target, form.transport);
    if (!config) {
      this.message = { kind: "error", text: t("mcpServers.targetInvalid") };
      this.host.element.requestUpdate();
      return;
    }
    const added = await this.mutateServers({
      buildPatch: (servers) => buildAddMcpServerPatch(servers, name, config),
      note: `plugins: add MCP server ${name}`,
      successText: t("mcpServers.addedSuccess", { name }),
    });
    if (added) {
      this.formOpen = false;
      this.host.element.requestUpdate();
    }
  }

  async toggleServer(name: string, enabled: boolean): Promise<void> {
    await this.mutateServers({
      buildPatch: (servers) => buildToggleMcpServerPatch(servers, name, enabled),
      note: `plugins: ${enabled ? "enable" : "disable"} MCP server ${name}`,
      successText: t(enabled ? "mcpServers.enabledSuccess" : "mcpServers.disabledSuccess", {
        name,
      }),
    });
  }

  async removeServer(name: string): Promise<void> {
    await this.mutateServers({
      buildPatch: (servers) => buildRemoveMcpServerPatch(servers, name),
      note: `plugins: remove MCP server ${name}`,
      successText: t("mcpServers.removedSuccess", { name }),
    });
  }

  async addConnector(connector: ConnectorSuggestion): Promise<void> {
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
    const added = await this.mutateServers({
      buildPatch: (servers) =>
        buildAddMcpServerPatch(servers, mcp.serverName, structuredClone(mcp.config)),
      note: `plugins: add MCP connector ${mcp.serverName}`,
      successText,
      busyKey: rowKey,
    });
    if (added) {
      this.host.setRowMessage(rowKey, { kind: "success", text: successText });
      this.message = null;
      this.host.element.requestUpdate();
    }
  }

  private async mutateServers(params: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
    busyKey?: string;
  }): Promise<boolean> {
    if (!this.host.canMutate() || this.busy) {
      return false;
    }
    const generation = this.feedbackGeneration;
    const runtimeConfig = this.host.getContext().runtimeConfig;
    this.busy = true;
    this.busyKey = params.busyKey ?? null;
    if (params.busyKey) {
      this.host.setRowBusy(params.busyKey, true);
      this.host.setRowMessage(params.busyKey, null);
    }
    this.message = null;
    this.host.element.requestUpdate();
    const result = await patchMcpServers(runtimeConfig, {
      buildPatch: params.buildPatch,
      note: params.note,
    });
    if (generation !== this.feedbackGeneration) {
      return false;
    }
    this.busy = false;
    this.busyKey = null;
    if (params.busyKey) {
      this.host.setRowBusy(params.busyKey, false);
    }
    // Failures surface where the action started: on the triggering card when
    // one exists (Discover connectors), otherwise in the MCP section.
    if (!result.ok) {
      if (params.busyKey) {
        this.host.setRowMessage(params.busyKey, { kind: "error", text: result.error });
      } else {
        this.message = { kind: "error", text: result.error };
      }
      this.host.element.requestUpdate();
      return false;
    }
    this.syncServers();
    this.message = { kind: "success", text: params.successText };
    this.host.element.requestUpdate();
    return true;
  }
}
