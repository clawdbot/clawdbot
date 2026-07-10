import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { isPluginEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import {
  resolveSessionAgentFilterId,
  resolveSessionAgentFilterOptions,
} from "../../lib/sessions/session-options.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  createDreamingState,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
} from "./dreaming.ts";
import { renderDreamingRestartConfirmation } from "./restart-confirmation.ts";
import { createDreamingViewState, renderDreaming, type DreamingViewState } from "./view.ts";

export type DreamsRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationGateway;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  state: DreamingState;
};

type WikiPagePreview = {
  title: string;
  path: string;
  content: string;
  totalLines?: number;
  truncated?: boolean;
  updatedAt?: string;
};

type DreamingTaskScope = {
  gateway: ApplicationGateway;
  epoch: number;
  state: DreamingState;
};

function formatDreamNextCycle(nextRunAtMs: number | undefined): string | null {
  return formatTimeMs(nextRunAtMs, { hour: "numeric", minute: "2-digit" }, "") || null;
}

function resolveDreamingNextCycle(status: DreamingState["dreamingStatus"]): string | null {
  const nextRunAtMs = Object.values(status?.phases ?? {})
    .filter((phase) => phase.enabled && typeof phase.nextRunAtMs === "number")
    .map((phase) => phase.nextRunAtMs as number)
    .toSorted((a, b) => a - b)[0];
  return nextRunAtMs === undefined ? null : formatDreamNextCycle(nextRunAtMs);
}

function readWikiPagePreview(value: unknown, lookup: string): WikiPagePreview {
  const payload =
    value && typeof value === "object"
      ? (value as {
          title?: unknown;
          path?: unknown;
          content?: unknown;
          updatedAt?: unknown;
          totalLines?: unknown;
          truncated?: unknown;
        })
      : null;
  const title =
    typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : lookup;
  const path =
    typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : lookup;
  const content =
    typeof payload?.content === "string" && payload.content.length > 0
      ? payload.content
      : "No wiki content available.";
  const updatedAt =
    typeof payload?.updatedAt === "string" && payload.updatedAt.trim()
      ? payload.updatedAt.trim()
      : undefined;
  const totalLines =
    typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
      ? Math.max(0, Math.floor(payload.totalLines))
      : undefined;
  return {
    title,
    path,
    content,
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(payload?.truncated === true ? { truncated: true } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

class DreamsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: DreamsRouteData;

  @state() private dreaming = createDreamingState();
  @state() private awaitingRouteData = true;
  @state() private restartConfirmOpen = false;
  @state() private restartConfirmLoading = false;
  @state() private pendingEnabled: boolean | null = null;

  private readonly viewState: DreamingViewState = createDreamingViewState();
  private routeDataEnabled = true;
  private gatewaySource: ApplicationGateway | null = null;
  private gatewayBindingEpoch = 0;
  private gatewayEpoch = 0;
  private hasBoundGatewaySource = false;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceReplaced = this.hasBoundGatewaySource;
        this.hasBoundGatewaySource = true;
        this.gatewaySource = gateway;
        const bindingEpoch = ++this.gatewayBindingEpoch;
        this.gatewayEpoch += 1;
        const cleanup = gateway.subscribe((snapshot) => {
          if (this.isGatewayBindingCurrent(gateway, bindingEpoch)) {
            this.applyGatewaySnapshot(snapshot);
          }
        });
        this.applyGatewaySnapshot(gateway.snapshot, sourceReplaced ? "replacement" : "initial");
        return cleanup;
      },
    )
    .effect(
      () => this.context?.agents,
      (agents) => agents.subscribe(() => this.applyAgentsState()),
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.syncConfigSnapshot();
        return runtimeConfig.subscribe(() => {
          this.syncConfigSnapshot();
          this.requestUpdate();
        });
      },
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.gatewayBindingEpoch += 1;
    this.gatewayEpoch += 1;
    this.gatewaySource = null;
    this.resetTransientState();
    this.awaitingRouteData = true;
    this.routeDataEnabled = true;
    this.dreaming = createDreamingState();
    super.disconnectedCallback();
  }

  private isGatewayBindingCurrent(gateway: ApplicationGateway, bindingEpoch: number): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === gateway &&
      this.gatewayBindingEpoch === bindingEpoch &&
      this.context.gateway === gateway
    );
  }

  private captureTaskScope(): DreamingTaskScope | null {
    const gateway = this.gatewaySource;
    if (!gateway) {
      return null;
    }
    return { gateway, epoch: this.gatewayEpoch, state: this.dreaming };
  }

  private isTaskScopeCurrent(scope: DreamingTaskScope): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === scope.gateway &&
      this.gatewayEpoch === scope.epoch &&
      this.context.gateway === scope.gateway &&
      this.dreaming === scope.state
    );
  }

  private resetTransientState() {
    this.resetWikiPreview();
    this.restartConfirmOpen = false;
    this.restartConfirmLoading = false;
    this.pendingEnabled = null;
  }

  private resetWikiPreview() {
    this.viewState.wikiPreviewRequestId += 1;
    this.viewState.wikiPreviewOpen = false;
    this.viewState.wikiPreviewLoading = false;
    this.viewState.wikiPreviewTitle = "";
    this.viewState.wikiPreviewPath = "";
    this.viewState.wikiPreviewUpdatedAt = null;
    this.viewState.wikiPreviewContent = "";
    this.viewState.wikiPreviewTotalLines = null;
    this.viewState.wikiPreviewTruncated = false;
    this.viewState.wikiPreviewError = null;
  }

  private createGatewayState(snapshot = this.context.gateway.snapshot): DreamingState {
    return createDreamingState({
      client: snapshot.client,
      connected: snapshot.connected,
      hello: snapshot.hello,
      configSnapshot: this.context.runtimeConfig.state.configSnapshot,
      applySessionKey: snapshot.sessionKey,
      selectedAgentId: this.resolveSelectedAgentId(),
    });
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    sourceBind?: "initial" | "replacement",
  ) {
    const clientChanged = this.dreaming.client !== snapshot.client;
    const connectionChanged = this.dreaming.connected !== snapshot.connected;
    const becameConnected = snapshot.connected && !this.dreaming.connected;
    const replaceState = sourceBind === "replacement" || clientChanged || connectionChanged;
    if (connectionChanged) {
      this.gatewayEpoch += 1;
    }
    if (replaceState) {
      this.dreaming = this.createGatewayState(snapshot);
      if (sourceBind !== "initial") {
        this.routeDataEnabled = false;
        this.awaitingRouteData = false;
        this.resetTransientState();
      }
    } else {
      this.dreaming.connected = snapshot.connected;
      this.dreaming.hello = snapshot.hello;
      this.dreaming.applySessionKey = snapshot.sessionKey;
    }
    if (!this.awaitingRouteData && snapshot.connected && (replaceState || becameConnected)) {
      void this.loadAll();
    }
    this.requestUpdate();
  }

  private applyAgentsState() {
    const agentsList = this.context.agents.state.agentsList;
    const selected = this.dreaming.selectedAgentId;
    if (agentsList && (!selected || !agentsList.agents.some((agent) => agent.id === selected))) {
      this.resetWikiPreview();
      this.dreaming.selectedAgentId = this.resolveSelectedAgentId();
      if (!this.awaitingRouteData) {
        this.routeDataEnabled = false;
        this.loadSelectedAgentData();
      }
    }
    this.requestUpdate();
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.awaitingRouteData = false;
    if (!this.routeDataEnabled) {
      return;
    }
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    if (data.gateway !== gateway || data.gatewaySnapshot !== snapshot) {
      this.routeDataEnabled = false;
      this.dreaming = this.createGatewayState(snapshot);
      void this.loadAll();
      return;
    }
    this.dreaming = {
      ...data.state,
      configSnapshot: this.context.runtimeConfig.state.configSnapshot ?? data.state.configSnapshot,
    };
  }

  private syncConfigSnapshot() {
    this.dreaming.configSnapshot = this.context.runtimeConfig.state.configSnapshot;
  }

  private resolveSelectedAgentId(): string {
    const sessionKey = this.context.gateway.snapshot.sessionKey;
    return resolveSessionAgentFilterId(
      {
        agentsList: this.context.agents.state.agentsList,
        sessionKey,
      },
      sessionKey,
    );
  }

  private resolveAgentOptions() {
    const sessionKey = this.context.gateway.snapshot.sessionKey;
    return resolveSessionAgentFilterOptions({
      agentsList: this.context.agents.state.agentsList,
      sessionKey,
    });
  }

  private async runDreamingTask<T>(
    task: (state: DreamingState) => Promise<T>,
    scope = this.captureTaskScope(),
  ): Promise<T | undefined> {
    if (!scope || !this.isTaskScopeCurrent(scope)) {
      return undefined;
    }
    const result = task(scope.state);
    this.requestUpdate();
    try {
      const value = await result;
      return this.isTaskScopeCurrent(scope) ? value : undefined;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.requestUpdate();
      }
    }
  }

  private async loadAll(refreshConfig = false) {
    const scope = this.captureTaskScope();
    if (!scope || !scope.state.client || !scope.state.connected) {
      return;
    }
    this.routeDataEnabled = false;
    if (refreshConfig) {
      const runtimeConfig = this.context.runtimeConfig;
      await runtimeConfig.refresh();
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
    }
    this.syncConfigSnapshot();
    await Promise.all([
      this.runDreamingTask(loadDreamingStatus, scope),
      this.runDreamingTask(loadDreamDiary, scope),
      this.runDreamingTask(loadWikiImportInsights, scope),
      this.runDreamingTask(loadWikiMemoryPalace, scope),
    ]);
  }

  private loadSelectedAgentData() {
    const scope = this.captureTaskScope();
    void Promise.all([
      this.runDreamingTask(loadDreamingStatus, scope),
      this.runDreamingTask(loadDreamDiary, scope),
      this.runDreamingTask(loadWikiImportInsights, scope),
      this.runDreamingTask(loadWikiMemoryPalace, scope),
    ]);
  }

  private selectAgent(agentId: string) {
    if (agentId === this.dreaming.selectedAgentId) {
      return;
    }
    this.routeDataEnabled = false;
    this.resetWikiPreview();
    this.dreaming.selectedAgentId = agentId;
    this.loadSelectedAgentData();
  }

  private setEnabled(enabled: boolean, dreamingOn: boolean) {
    if (
      this.dreaming.dreamingModeSaving ||
      this.restartConfirmLoading ||
      this.restartConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    this.pendingEnabled = enabled;
    this.restartConfirmOpen = true;
    this.dreaming.dreamingStatusError = null;
  }

  private cancelRestart() {
    if (this.restartConfirmLoading) {
      return;
    }
    this.restartConfirmOpen = false;
    this.pendingEnabled = null;
    this.dreaming.dreamingStatusError = null;
  }

  private async confirmRestart() {
    const enabled = this.pendingEnabled;
    if (enabled == null || this.restartConfirmLoading) {
      return;
    }
    this.routeDataEnabled = false;
    this.restartConfirmLoading = true;
    this.dreaming.dreamingStatusError = null;
    const scope = this.captureTaskScope();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope) {
      this.restartConfirmLoading = false;
      return;
    }
    try {
      const updated = await this.runDreamingTask(
        (dreamingState) => updateDreamingEnabled(dreamingState, runtimeConfig, enabled),
        scope,
      );
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      if (!updated) {
        this.dreaming.dreamingStatusError ??= t("dreaming.restartConfirmation.failed");
        return;
      }
      await runtimeConfig.refresh();
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      this.syncConfigSnapshot();
      await this.runDreamingTask(loadDreamingStatus, scope);
      if (!this.isTaskScopeCurrent(scope)) {
        return;
      }
      this.restartConfirmOpen = false;
      this.pendingEnabled = null;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.restartConfirmLoading = false;
      }
    }
  }

  private async openWikiPage(lookup: string): Promise<WikiPagePreview | null> {
    const scope = this.captureTaskScope();
    const client = scope?.state.client;
    if (!scope || !client || !scope.state.connected) {
      return null;
    }
    const agentId = scope.state.selectedAgentId?.trim() || null;
    const payload = await client.request("wiki.get", {
      lookup,
      fromLine: 1,
      lineCount: 5000,
      ...(agentId ? { agentId } : {}),
    });
    if (
      !this.isTaskScopeCurrent(scope) ||
      (scope.state.selectedAgentId?.trim() || null) !== agentId
    ) {
      return null;
    }
    return readWikiPagePreview(payload, lookup);
  }

  private async refreshWikiData(task: (state: DreamingState) => Promise<void>) {
    const scope = this.captureTaskScope();
    if (!scope) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    await runtimeConfig.refresh();
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await this.runDreamingTask(task, scope);
  }

  override render() {
    const dreaming = this.dreaming;
    const configState = this.context.runtimeConfig.state;
    const dreamingOn =
      dreaming.dreamingStatus?.enabled ??
      resolveConfiguredDreaming(currentConfigObject(configState)).enabled;
    const loading =
      this.awaitingRouteData || dreaming.dreamingStatusLoading || dreaming.dreamingModeSaving;
    const refreshLoading =
      this.awaitingRouteData || dreaming.dreamingStatusLoading || dreaming.dreamDiaryLoading;
    const selectedAgentId = dreaming.selectedAgentId ?? this.resolveSelectedAgentId();

    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("dreams")}</div>
          <div class="page-sub">${subtitleForRoute("dreams")}</div>
        </div>
        <div class="page-meta">
          <div class="dreaming-header-controls">
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${loading || dreaming.dreamDiaryLoading}
              @click=${() => void this.loadAll(true)}
            >
              ${refreshLoading ? t("dreaming.header.refreshing") : t("dreaming.header.refresh")}
            </button>
            <button
              class="dreams__phase-toggle ${dreamingOn ? "dreams__phase-toggle--on" : ""}"
              ?disabled=${loading}
              @click=${() => this.setEnabled(!dreamingOn, dreamingOn)}
            >
              <span class="dreams__phase-toggle-dot"></span>
              <span class="dreams__phase-toggle-label">
                ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
              </span>
            </button>
          </div>
        </div>
      </section>
      ${renderDreaming({
        viewState: this.viewState,
        active: dreamingOn,
        selectedAgentId,
        agentOptions: this.resolveAgentOptions(),
        shortTermCount: dreaming.dreamingStatus?.shortTermCount ?? 0,
        groundedSignalCount: dreaming.dreamingStatus?.groundedSignalCount ?? 0,
        totalSignalCount: dreaming.dreamingStatus?.totalSignalCount ?? 0,
        promotedCount: dreaming.dreamingStatus?.promotedToday ?? 0,
        phases: dreaming.dreamingStatus?.phases ?? undefined,
        shortTermEntries: dreaming.dreamingStatus?.shortTermEntries ?? [],
        promotedEntries: dreaming.dreamingStatus?.promotedEntries ?? [],
        dreamingOf: null,
        nextCycle: resolveDreamingNextCycle(dreaming.dreamingStatus),
        timezone: dreaming.dreamingStatus?.timezone ?? null,
        statusLoading: this.awaitingRouteData || dreaming.dreamingStatusLoading,
        statusError: dreaming.dreamingStatusError,
        modeSaving: dreaming.dreamingModeSaving,
        dreamDiaryLoading: this.awaitingRouteData || dreaming.dreamDiaryLoading,
        dreamDiaryActionLoading: dreaming.dreamDiaryActionLoading,
        dreamDiaryActionMessage: dreaming.dreamDiaryActionMessage,
        dreamDiaryActionArchivePath: dreaming.dreamDiaryActionArchivePath,
        dreamDiaryError: dreaming.dreamDiaryError,
        dreamDiaryPath: dreaming.dreamDiaryPath,
        dreamDiaryContent: dreaming.dreamDiaryContent,
        memoryWikiEnabled: isPluginEnabledInConfigSnapshot(
          configState.configSnapshot,
          "memory-wiki",
          { enabledByDefault: false },
        ),
        wikiImportInsightsLoading: this.awaitingRouteData || dreaming.wikiImportInsightsLoading,
        wikiImportInsightsError: dreaming.wikiImportInsightsError,
        wikiImportInsights: dreaming.wikiImportInsights,
        wikiMemoryPalaceLoading: this.awaitingRouteData || dreaming.wikiMemoryPalaceLoading,
        wikiMemoryPalaceError: dreaming.wikiMemoryPalaceError,
        wikiMemoryPalace: dreaming.wikiMemoryPalace,
        onRefresh: () => void this.loadAll(true),
        onSelectAgent: (agentId) => this.selectAgent(agentId),
        onRefreshDiary: () => void this.runDreamingTask(loadDreamDiary),
        onRefreshImports: () => void this.refreshWikiData(loadWikiImportInsights),
        onRefreshMemoryPalace: () => void this.refreshWikiData(loadWikiMemoryPalace),
        onOpenConfig: () => void this.context.runtimeConfig.openFile(),
        onOpenWikiPage: (lookup) => this.openWikiPage(lookup),
        onBackfillDiary: () => void this.runDreamingTask(backfillDreamDiary),
        onCopyDreamingArchivePath: () => void this.runDreamingTask(copyDreamingArchivePath),
        onDedupeDreamDiary: () => void this.runDreamingTask(dedupeDreamDiary),
        onResetDiary: () => void this.runDreamingTask(resetDreamDiary),
        onResetGroundedShortTerm: () => void this.runDreamingTask(resetGroundedShortTerm),
        onRepairDreamingArtifacts: () => void this.runDreamingTask(repairDreamingArtifacts),
        onViewStateChange: () => this.requestUpdate(),
      })}
      ${renderDreamingRestartConfirmation({
        open: this.restartConfirmOpen,
        loading: this.restartConfirmLoading,
        onConfirm: () => void this.confirmRestart(),
        onCancel: () => this.cancelRestart(),
        hasError: Boolean(dreaming.dreamingStatusError),
      })}
    `;
  }
}

if (!customElements.get("openclaw-dreams-page")) {
  customElements.define("openclaw-dreams-page", DreamsPage);
}
