import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { renderSettingsDefaultDescription } from "../../../components/settings-ui.ts";
import { t } from "../../../i18n/index.ts";
import { currentConfigObject } from "../../../lib/config/config-state-model.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import {
  backfillDreamDiary,
  canCallDreamingMethod,
  copyDreamingArchivePath,
  createDreamingState,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiOverview,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
} from "./dreaming.ts";
import { renderDreamingToggleConfirmation } from "./toggle-confirmation.ts";
import {
  createDreamingViewState,
  renderDreaming,
  resetWikiPreview,
  type DreamingViewState,
} from "./view.ts";

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
      : t("dreaming.wiki.noContent");
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

class AgentMemoryPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) agentId = "";

  @state() private dreaming = createDreamingState();
  @state() private toggleConfirmOpen = false;
  @state() private toggleConfirmLoading = false;
  @state() private pendingEnabled: boolean | null = null;

  private readonly viewState: DreamingViewState = createDreamingViewState();
  private gatewaySource: ApplicationGateway | null = null;
  private gatewayBindingEpoch = 0;
  private gatewayEpoch = 0;
  private hasBoundGatewaySource = false;
  private selectedAgentId: string | null = null;
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
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.syncConfigSnapshot();
        return runtimeConfig.subscribe(() => {
          this.syncConfigSnapshot();
          this.requestUpdate();
        });
      },
    );

  override updated(changed: PropertyValues<this>) {
    if (changed.has("agentId")) {
      this.applyAgentId();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.gatewayBindingEpoch += 1;
    this.gatewayEpoch += 1;
    this.gatewaySource = null;
    this.resetTransientState();
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
    resetWikiPreview(this.viewState);
    this.toggleConfirmOpen = false;
    this.toggleConfirmLoading = false;
    this.pendingEnabled = null;
  }

  private createGatewayState(snapshot = this.context.gateway.snapshot): DreamingState {
    return createDreamingState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      hello: snapshot.hello,
      configSnapshot: this.context.runtimeConfig.state.configSnapshot,
      applySessionKey: snapshot.sessionKey,
      selectedAgentId: this.selectedAgentId,
    });
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    sourceBind?: "initial" | "replacement",
  ) {
    const clientChanged = this.dreaming.client !== snapshot.client;
    const connectionChanged = this.dreaming.connected !== (snapshot.phase === "connected");
    const becameConnected = snapshot.phase === "connected" && !this.dreaming.connected;
    const replaceState = sourceBind === "replacement" || clientChanged || connectionChanged;
    if (connectionChanged) {
      this.gatewayEpoch += 1;
    }
    if (replaceState) {
      this.dreaming = this.createGatewayState(snapshot);
      if (sourceBind !== "initial") {
        this.resetTransientState();
      }
    } else {
      this.dreaming.connected = snapshot.phase === "connected";
      this.dreaming.hello = snapshot.hello;
      this.dreaming.applySessionKey = snapshot.sessionKey;
    }
    if (
      snapshot.phase === "connected" &&
      this.selectedAgentId &&
      (replaceState || becameConnected)
    ) {
      void this.loadAll();
    }
    this.requestUpdate();
  }

  private applyAgentId() {
    const agentId = this.agentId.trim() || null;
    if (this.selectedAgentId === agentId) {
      return;
    }
    this.selectedAgentId = agentId;
    this.gatewayEpoch += 1;
    this.resetTransientState();
    this.dreaming = this.createGatewayState();
    if (agentId && this.dreaming.connected) {
      void this.loadAll();
    }
  }

  private syncConfigSnapshot() {
    this.dreaming.configSnapshot = this.context.runtimeConfig.state.configSnapshot;
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

  private async confirmDreamingTask(
    task: (state: DreamingState) => Promise<boolean>,
    confirmation: ConfirmDialogOptions,
  ) {
    const scope = this.captureTaskScope();
    if (!scope || !(await showConfirmDialog(confirmation)) || !this.isTaskScopeCurrent(scope)) {
      return;
    }
    await this.runDreamingTask(task, scope);
  }

  private async loadAll(refreshConfig = false) {
    const scope = this.captureTaskScope();
    if (!scope || !scope.state.client || !scope.state.connected || !scope.state.selectedAgentId) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (refreshConfig) {
      await runtimeConfig.refresh();
    } else {
      await runtimeConfig.ensureLoaded();
    }
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await Promise.all([
      this.runDreamingTask(loadDreamingStatus, scope),
      this.runDreamingTask(loadDreamDiary, scope),
      this.runDreamingTask(loadWikiImportInsights, scope),
      this.runDreamingTask(loadWikiOverview, scope),
    ]);
  }

  private setEnabled(enabled: boolean, dreamingOn: boolean) {
    if (
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin") ||
      this.dreaming.dreamingModeSaving ||
      this.toggleConfirmLoading ||
      this.toggleConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    this.pendingEnabled = enabled;
    this.toggleConfirmOpen = true;
    this.dreaming.dreamingStatusError = null;
  }

  private cancelToggle() {
    if (this.toggleConfirmLoading) {
      return;
    }
    this.toggleConfirmOpen = false;
    this.pendingEnabled = null;
    this.dreaming.dreamingStatusError = null;
  }

  private async confirmToggle() {
    const enabled = this.pendingEnabled;
    if (
      enabled == null ||
      this.toggleConfirmLoading ||
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin")
    ) {
      return;
    }
    this.toggleConfirmLoading = true;
    this.dreaming.dreamingStatusError = null;
    const scope = this.captureTaskScope();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope) {
      this.toggleConfirmLoading = false;
      return;
    }
    try {
      const canDispatch = () =>
        this.isTaskScopeCurrent(scope) &&
        this.context.runtimeConfig === runtimeConfig &&
        canCallDreamingMethod(scope.state, "config.patch", "operator.admin");
      const updated = await this.runDreamingTask(
        (dreamingState) =>
          updateDreamingEnabled(dreamingState, runtimeConfig, enabled, canDispatch),
        scope,
      );
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      if (!updated) {
        this.dreaming.dreamingStatusError ??= t("dreaming.toggleConfirmation.failed");
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
      this.toggleConfirmOpen = false;
      this.pendingEnabled = null;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.toggleConfirmLoading = false;
      }
    }
  }

  private async openWikiPage(lookup: string): Promise<WikiPagePreview | null> {
    const scope = this.captureTaskScope();
    const client = scope?.state.client;
    const agentId = scope?.state.selectedAgentId;
    if (!scope || !client || !scope.state.connected || !agentId) {
      return null;
    }
    const payload = await client.request("wiki.get", {
      lookup,
      fromLine: 1,
      lineCount: 5000,
      agentId,
    });
    if (!this.isTaskScopeCurrent(scope) || scope.state.selectedAgentId !== agentId) {
      return null;
    }
    return readWikiPagePreview(payload, lookup);
  }

  private async refreshWikiData(task: (state: DreamingState) => Promise<void>) {
    const scope = this.captureTaskScope();
    if (!scope?.state.selectedAgentId) {
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
    const configuredDreaming = resolveConfiguredDreaming(currentConfigObject(configState));
    // The status RPC can complete after config switches the engine Off. Keep the
    // cached payload for a future refresh, but never present it as current runtime state.
    const dreamingStatus = configuredDreaming.engineOff ? null : dreaming.dreamingStatus;
    const dreamingOn = dreamingStatus?.enabled ?? configuredDreaming.enabled;
    const loading = dreaming.dreamingStatusLoading || dreaming.dreamingModeSaving;
    const canUpdateConfig = canCallDreamingMethod(dreaming, "config.patch", "operator.admin");
    const refreshLoading = dreaming.dreamingStatusLoading || dreaming.dreamDiaryLoading;
    const selectedAgentId = dreaming.selectedAgentId ?? "";

    return html`
      <section class="content-header content-header--page agent-memory-panel__header">
        <div class="page-meta">
          <div class="dreaming-header-controls">
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${loading || dreaming.dreamDiaryLoading}
              @click=${() => void this.loadAll(true)}
            >
              ${refreshLoading ? t("dreaming.header.refreshing") : t("dreaming.header.refresh")}
            </button>
            <span class="muted">
              ${configuredDreaming.engineOff
                ? t("dreaming.header.engineOff")
                : renderSettingsDefaultDescription(
                    t("common.enabled"),
                    configuredDreaming.overridden,
                  )}
            </span>
            <button
              class="dreams__phase-toggle ${dreamingOn ? "dreams__phase-toggle--on" : ""}"
              ?disabled=${!canUpdateConfig || loading || configuredDreaming.engineOff}
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
        access: {
          canOpenConfig: canCallDreamingMethod(dreaming, "config.openFile", "operator.admin", {
            requireAdvertisement: false,
          }),
          canBackfillDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.backfillDreamDiary",
            "operator.write",
          ),
          canDedupeDreamDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.dedupeDreamDiary",
            "operator.write",
          ),
          canResetDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.resetDreamDiary",
            "operator.write",
          ),
          canResetGroundedShortTerm: canCallDreamingMethod(
            dreaming,
            "doctor.memory.resetGroundedShortTerm",
            "operator.write",
          ),
          canRepairDreamingArtifacts: canCallDreamingMethod(
            dreaming,
            "doctor.memory.repairDreamingArtifacts",
            "operator.write",
          ),
        },
        viewState: this.viewState,
        active: dreamingOn,
        selectedAgentId,
        shortTermCount: dreamingStatus?.shortTermCount ?? 0,
        promotedCount: dreamingStatus?.promotedToday ?? 0,
        phases: dreamingStatus?.phases ?? undefined,
        shortTermEntries: dreamingStatus?.shortTermEntries ?? [],
        promotedEntries: dreamingStatus?.promotedEntries ?? [],
        dreamingOf: null,
        nextCycle: resolveDreamingNextCycle(dreamingStatus),
        timezone: dreamingStatus?.timezone ?? null,
        statusError: dreaming.dreamingStatusError,
        modeSaving: dreaming.dreamingModeSaving,
        dreamDiaryLoading: dreaming.dreamDiaryLoading,
        dreamDiaryActionLoading: dreaming.dreamDiaryActionLoading,
        dreamDiaryActionMessage: dreaming.dreamDiaryActionMessage,
        dreamDiaryActionArchivePath: dreaming.dreamDiaryActionArchivePath,
        dreamDiaryError: dreaming.dreamDiaryError,
        dreamDiaryContent: dreaming.dreamDiaryContent,
        memoryWikiEnabled: isPluginEnabledInConfigSnapshot(
          configState.configSnapshot,
          "memory-wiki",
          { enabledByDefault: false },
        ),
        wikiImportInsightsLoading: dreaming.wikiImportInsightsLoading,
        wikiImportInsightsError: dreaming.wikiImportInsightsError,
        wikiImportInsights: dreaming.wikiImportInsights,
        wikiOverviewLoading: dreaming.wikiOverviewLoading,
        wikiOverviewError: dreaming.wikiOverviewError,
        wikiOverview: dreaming.wikiOverview,
        onRefreshDiary: () => void this.runDreamingTask(loadDreamDiary),
        onRefreshImports: () => void this.refreshWikiData(loadWikiImportInsights),
        onRefreshWikiOverview: () => void this.refreshWikiData(loadWikiOverview),
        onOpenConfig: () => void this.context.runtimeConfig.openFile(),
        onOpenWikiPage: (lookup) => this.openWikiPage(lookup),
        onBackfillDiary: () => void this.runDreamingTask(backfillDreamDiary),
        onCopyDreamingArchivePath: () => void this.runDreamingTask(copyDreamingArchivePath),
        onDedupeDreamDiary: () =>
          void this.confirmDreamingTask(dedupeDreamDiary, {
            title: t("dreaming.scene.dedupeDiary"),
            message: t("dreaming.actions.confirmDedupeDescription"),
            confirmLabel: t("dreaming.scene.dedupeDiary"),
            danger: true,
          }),
        onResetDiary: () => void this.runDreamingTask(resetDreamDiary),
        onResetGroundedShortTerm: () => void this.runDreamingTask(resetGroundedShortTerm),
        onRepairDreamingArtifacts: () =>
          void this.confirmDreamingTask(repairDreamingArtifacts, {
            title: t("dreaming.scene.repairCache"),
            message: t("dreaming.actions.confirmRepairDescription"),
            confirmLabel: t("dreaming.scene.repairCache"),
          }),
        onViewStateChange: () => this.requestUpdate(),
      })}
      ${renderDreamingToggleConfirmation({
        open: this.toggleConfirmOpen,
        enabling: this.pendingEnabled === true,
        loading: this.toggleConfirmLoading,
        onConfirm: () => void this.confirmToggle(),
        onCancel: () => this.cancelToggle(),
        hasError: Boolean(dreaming.dreamingStatusError),
      })}
    `;
  }
}

if (!customElements.get("openclaw-agent-memory-panel")) {
  customElements.define("openclaw-agent-memory-panel", AgentMemoryPanel);
}
