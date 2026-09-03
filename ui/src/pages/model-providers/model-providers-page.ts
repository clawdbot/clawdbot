import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import { renderLearnMoreLink, renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import { ModelConnectController } from "./connect-controller.ts";
import {
  buildModelProviderCards,
  buildSelectableDefaultModels,
  readModelProviderConfig,
  type DefaultModelSelection,
  type ModelProviderLogoutTarget,
} from "./data.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  loadModelProvidersData,
  MODEL_PROVIDERS_COST_DAYS,
  type ModelProvidersData,
} from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import {
  buildDefaultsPatch,
  buildProviderApiKeyPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  isMissingMethodError,
  mergeProbeResults,
  modelProviderErrorMessage,
  readModelBehaviorConfig,
  runModelProviderConfigMutation,
  type ModelBehaviorConfig,
  type ModelProviderConfigMutation,
  type ModelProviderConfigMutationResult,
} from "./page-mutations.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";
import { renderModelProviders, type ModelProviderRowMessage } from "./view.ts";

const MODEL_PROVIDERS_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type DefaultsDraft = DefaultModelSelection & ModelBehaviorConfig;
type ModelProvidersRefreshMode = "discover" | "prepared" | "revalidate";

/** Per-row page state keyed by card id; a null value clears the row. */
function withRowKey<T>(record: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const { [key]: _cleared, ...rest } = record;
  return value === null ? rest : { ...rest, [key]: value };
}

export class ModelProvidersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;
  @property({ attribute: false }) loaderPending = false;

  @state() private data: ModelProvidersData | null = null;
  @state() private busy: Record<string, true> = {};
  @state() private messages: Record<string, ModelProviderRowMessage> = {};
  @state() private probeResults: Record<string, ModelsProbeResult> = {};
  @state() private probeUnsupported = false;
  @state() private keyEditor: { provider: string; draft: string } | null = null;
  @state() private pendingLogoutProvider: string | null = null;
  @state() private defaultsDraft: DefaultsDraft | null = null;
  @state() private selectedAgentId = "";
  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  // Null Task runs supersede stale work without counting as a real load.
  private loadClient: GatewayBrowserClient | null = null;
  private revalidatePending = false;
  private routeDataObserved = false;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private probeEpochs = new Map<string, number>();
  private readonly refreshTask = new Task(this, {
    autoRun: false,
    task: (
      [client, agentId, mode]: [GatewayBrowserClient | null, string, ModelProvidersRefreshMode],
      { signal },
    ) => {
      if (!client || !agentId) {
        return initialState;
      }
      return loadModelProvidersData(client, {
        agentId,
        ...(mode === "discover" ? { refresh: true } : {}),
        signal,
      }).then((data) => ({ client, data, mode }));
    },
    onComplete: ({ client, data, mode }) => {
      this.loadClient = null;
      this.supplemental.adoptCoreData(client, data, { startSupplemental: mode !== "revalidate" });
      this.finishCoreRefresh();
    },
    onError: () => {
      this.loadClient = null;
      this.finishCoreRefresh();
    },
  });
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () =>
      this.loaderPending ||
      !this.routeDataObserved ||
      this.loadClient !== null ||
      this.supplemental.usageLoading,
    // Usage convergence must not restart the independent local-cost request.
    reload: () => this.supplemental.loadUsage(),
    onIncompleteUsageExhausted: () => this.requestUpdate(),
  });
  private readonly supplemental = new ModelProviderSupplementalLoader(this, {
    canLoad: () => this.routeData?.view !== "connect",
    isCoreLoading: () => this.loaderPending,
    getGateway: () => this.gateway,
    getData: () => this.data,
    getDataClient: () => this.dataClient,
    setData: (data) => (this.data = data),
    setDataClient: (client) => (this.dataClient = client),
    refreshPolicy: this.refreshPolicy,
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetConnectionState(),
    invalidateRequests: () => this.invalidateRequests(),
    ensureInitialData: () => this.ensureInitialData(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        // Keep the last snapshot visible while the canonical reconnect load replaces it.
        this.resetConnectionState({ preserveVisibleData: true });
      }
      if (
        change.becameConnected &&
        !change.initial &&
        this.routeDataObserved &&
        !this.loaderPending
      ) {
        void this.refresh("prepared");
      }
    },
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
      },
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      () => this.syncSelectedAgent(),
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => selection.subscribe(() => this.syncSelectedAgent()),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.context?.gateway !== gateway ||
            (event.event !== "config.changed" && event.event !== "chat.metadata.changed")
          ) {
            return;
          }
          this.revalidateAfterMetadataChange();
        }),
    );
  private readonly providerLogin = new ModelProviderLoginController(this, {
    getClient: () => this.gateway.client,
    getAgentId: () => this.selectedAgentId || null,
    getRuntimeConfig: () => this.context.runtimeConfig,
    canStart: () => this.canMutate(),
    refresh: () => this.refresh("prepared"),
    setMessage: (key, message) => this.setMessage(key, message),
  });
  private readonly connect = new ModelConnectController(this, {
    getContext: () => this.context,
    getRouteData: () => this.routeData,
    getSelectedAgentId: () => this.selectedAgentId,
  });

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.refreshPolicy.dispose();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (
      (changed.has("routeData") || changed.has("loaderPending")) &&
      this.routeData !== undefined
    ) {
      this.routeDataObserved = true;
      const selectedAgentId = this.resolveSelectedAgentId();
      this.setSelectedAgent(selectedAgentId);
      if (
        (this.routeData.agentId ?? "") === selectedAgentId &&
        this.gateway.isRouteDataCurrent(this.routeData)
      ) {
        this.supplemental.adoptCoreData(this.routeData.client, this.routeData.data, {
          startSupplemental: true,
        });
      } else {
        this.data = null;
        this.dataClient = null;
        this.refreshPolicy.resetPayload();
      }
      this.ensureInitialData();
    }
  }

  private ensureInitialData() {
    if (
      !this.context.agents.state.agentsList &&
      !this.context.agents.state.agentsLoading &&
      !this.context.agents.state.agentsError
    ) {
      void this.context.agents.ensureList();
    }
    if (this.routeData?.view === "connect") {
      return;
    }
    // The route owns initial loading, even when its page module is already cached.
    const client = this.gateway.client;
    if (
      !this.routeDataObserved ||
      this.loaderPending ||
      !this.gateway.connected ||
      !client ||
      !this.selectedAgentId ||
      this.loadClient !== null ||
      (this.data !== null && this.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh("prepared");
  }

  private invalidateRequests() {
    this.loadClient = null;
    this.revalidatePending = false;
    void this.refreshTask.run([null, this.selectedAgentId, "prepared"]);
    this.supplemental.invalidate();
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      this.data = null;
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.resetAgentScopeState();
    this.probeEpochs = new Map();
    this.probeUnsupported = false;
    this.defaultsDraft = null;
  }

  private resetAgentScopeState() {
    this.providerLogin.reset();
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.closeKeyEditor();
    this.pendingLogoutProvider = null;
  }

  private isCurrentClient(client: GatewayBrowserClient, epoch: number): boolean {
    return this.gateway.isCurrent({ client, epoch });
  }

  private resolveSelectedAgentId(): string {
    const selected = this.context.agentSelection.state.selectedId;
    return selected ? normalizeAgentId(selected) : "";
  }

  private setSelectedAgent(agentId: string): boolean {
    if (agentId === this.selectedAgentId) {
      return false;
    }
    this.selectedAgentId = agentId;
    this.agentEpoch += 1;
    this.resetAgentScopeState();
    return true;
  }

  private syncSelectedAgent() {
    const agentId = this.resolveSelectedAgentId();
    if (!this.setSelectedAgent(agentId)) {
      return;
    }
    this.invalidateRequests();
    this.data = null;
    this.dataClient = null;
    this.refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  private refresh(mode: ModelProvidersRefreshMode): Promise<void> {
    if (this.routeData?.view === "connect" || !this.selectedAgentId) {
      return Promise.resolve();
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    // Cancel the old supplemental generation before it can publish during core loading.
    if (mode !== "revalidate") {
      this.supplemental.beginCoreRefresh(mode === "discover");
    }
    this.revalidatePending = false;
    this.loadClient = client;
    return this.refreshTask.run([client, this.selectedAgentId, mode]);
  }

  private revalidateAfterMetadataChange(): void {
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      return;
    }
    if (this.loadClient !== null) {
      this.revalidatePending = true;
      return;
    }
    void this.refresh("revalidate");
  }

  private finishCoreRefresh(): void {
    if (this.revalidatePending) {
      this.revalidatePending = false;
      void this.refresh("revalidate");
      return;
    }
    // A focus request can arrive while the core read is active. Event-driven
    // reads do not restart supplemental work, so release that request here.
    this.refreshPolicy.flushPending();
  }

  private mutationBlockedReason(): string | null {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected") {
      return t("modelProviders.readOnly.disconnected");
    }
    if (this.context.runtimeConfig.canPatch !== true) {
      return t("modelProviders.readOnly.adminRequired");
    }
    if (!snapshot.client || !this.selectedAgentId || !this.data?.config) {
      return t("modelProviders.configUnavailable");
    }
    return null;
  }

  private canMutate(): boolean {
    return this.mutationBlockedReason() === null && !this.configBusy();
  }

  private configBusy(): boolean {
    const runtimeState = this.context.runtimeConfig.state;
    const update = this.context.overlays.snapshot;
    return (
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      update.updateRunning ||
      update.updateReconciliationPending
    );
  }

  private setBusy(key: string, value: boolean) {
    this.busy = withRowKey(this.busy, key, value ? true : null);
  }

  private setMessage(key: string, message: ModelProviderRowMessage | null) {
    this.messages = withRowKey(this.messages, key, message);
  }

  private clearProbe(provider: string) {
    this.probeEpochs.set(provider, (this.probeEpochs.get(provider) ?? 0) + 1);
    this.setBusy(`probe:${provider}`, false);
    const next = { ...this.probeResults };
    delete next[provider];
    this.probeResults = next;
  }

  private async patchConfig(
    params: ModelProviderConfigMutation,
  ): Promise<ModelProviderConfigMutationResult> {
    if (!this.canMutate() || this.busy[params.key]) {
      return { ok: false };
    }
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return { ok: false };
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    return runModelProviderConfigMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        agentEpoch,
        isCurrentClient: () => this.isCurrentClient(client, clientEpoch),
        isCurrentAgent: () => this.agentEpoch === agentEpoch,
        refreshProviders: () => this.refresh("discover"),
        setBusy: (busy) => this.setBusy(params.key, busy),
        setMessage: (message) => this.setMessage(params.key, message),
      },
      params,
    );
  }

  private openKeyEditor(provider: string) {
    this.keyEditor = { provider, draft: "" };
    this.setMessage(provider, null);
  }

  private closeKeyEditor() {
    this.keyEditor = null;
  }

  private async saveKey(provider: string, configKey: string) {
    const apiKey = this.keyEditor?.draft.trim() ?? "";
    if (!apiKey) {
      return;
    }
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const result = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, apiKey),
      note: t("modelProviders.notes.saveKey", { provider }),
      success: t("modelProviders.apiKey.saved"),
    });
    if (result.ok && this.agentEpoch === result.agentEpoch) {
      this.setMessage(`key:${provider}`, null);
      if (this.keyEditor?.provider === provider && this.keyEditor.draft.trim() === apiKey) {
        this.closeKeyEditor();
      }
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.apiKey.saved"),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
  }

  private async removeKey(provider: string, configKey: string) {
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const result = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, null),
      note: t("modelProviders.notes.removeKey", { provider }),
      success: t("modelProviders.apiKey.removed"),
    });
    if (result.ok && this.agentEpoch === result.agentEpoch) {
      this.setMessage(`key:${provider}`, null);
      if (this.keyEditor?.provider === provider) {
        this.closeKeyEditor();
      }
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.apiKey.removed"),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
  }

  private async probe(cardId: string, providers: string[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `probe:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key] || this.probeUnsupported) {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentId = this.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () =>
      this.isCurrentClient(client, clientEpoch) &&
      this.agentEpoch === agentEpoch &&
      this.selectedAgentId === agentId &&
      this.probeEpochs.get(cardId) === probeEpoch;
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        if (!ownsProbe()) {
          return;
        }
        results.push(
          await client.request<ModelsProbeResult>("models.probe", { provider, agentId }),
        );
      }
      if (ownsProbe()) {
        this.probeResults = {
          ...this.probeResults,
          [cardId]: mergeProbeResults(cardId, results),
        };
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      if (isMissingMethodError(error)) {
        this.probeUnsupported = true;
        this.setMessage(cardId, {
          kind: "error",
          text: t("modelProviders.probe.unavailable"),
        });
      } else {
        this.setMessage(cardId, { kind: "error", text: modelProviderErrorMessage(error) });
      }
    } finally {
      if (ownsProbe()) {
        this.setBusy(key, false);
      }
    }
  }

  private async logout(cardId: string, targets: ModelProviderLogoutTarget[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `logout:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key]) {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentId = this.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    this.clearProbe(cardId);
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      let firstError: unknown;
      for (const target of targets) {
        // OAuth profiles are agent-owned; stop undispatched targets after any
        // scope change, including a switch away from and back to this agent.
        if (!this.isCurrentClient(client, clientEpoch) || this.agentEpoch !== agentEpoch) {
          return;
        }
        try {
          await client.request("models.authLogout", { ...target, agentId });
        } catch (error) {
          firstError ??= error;
        }
      }
      if (!this.isCurrentClient(client, clientEpoch) || this.agentEpoch !== agentEpoch) {
        return;
      }
      // Logout already invalidates auth state. A prepared read reflects removal
      // without making the visible mutation wait for full provider discovery.
      await this.refresh("prepared");
      if (!this.isCurrentClient(client, clientEpoch) || this.agentEpoch !== agentEpoch) {
        return;
      }
      if (firstError) {
        this.setMessage(cardId, { kind: "error", text: modelProviderErrorMessage(firstError) });
        return;
      }
      this.pendingLogoutProvider = null;
      this.setMessage(cardId, { kind: "success", text: t("modelProviders.logout.done") });
    } catch (error) {
      if (this.isCurrentClient(client, clientEpoch) && this.agentEpoch === agentEpoch) {
        this.setMessage(cardId, { kind: "error", text: modelProviderErrorMessage(error) });
      }
    } finally {
      if (this.isCurrentClient(client, clientEpoch) && this.agentEpoch === agentEpoch) {
        this.setBusy(key, false);
      }
    }
  }

  private async saveDefaults(defaults = this.defaultsDraft) {
    if (!defaults) {
      return;
    }
    const agentEpoch = this.agentEpoch;
    const result = await this.patchConfig({
      key: "defaults",
      raw: buildDefaultsPatch(defaults),
      note: t("modelProviders.notes.defaultModel"),
      success: t("modelProviders.defaults.saved"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    });
    // Keep the draft when fresh provider data is unavailable after commit.
    if (
      this.agentEpoch === agentEpoch &&
      this.defaultsDraft === defaults &&
      (!result.ok || !result.warning)
    ) {
      this.defaultsDraft = null;
    }
  }

  override render() {
    if (this.routeData?.view === "connect") {
      return this.connect.render();
    }
    const gatewaySnapshot = this.context.gateway.snapshot;
    const agentsState = this.context.agents.state;
    const agents = agentsState.agentsList?.agents ?? [];
    const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const config = readModelProviderConfig(data.config);
    const runtimeConfig = this.context.runtimeConfig;
    const runtimeState = runtimeConfig.state;
    const configObject =
      asConfigRecord(runtimeState.configForm ?? runtimeState.configSnapshot?.config) ??
      asConfigRecord(data.config) ??
      {};
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const configuredDefaults = {
      ...config.defaults,
      ...readModelBehaviorConfig(agentsDefaults),
    };
    const defaults = this.defaultsDraft ?? configuredDefaults;
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      this.defaultsDraft = { ...(this.defaultsDraft ?? configuredDefaults), ...patch };
      this.setMessage("defaults", null);
      void this.saveDefaults(this.defaultsDraft);
    };
    // This keeps the pre-move General busy gate sourced from the same update state.
    const cards = buildModelProviderCards({
      ...data,
      providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
      configProviderIds: config.providerIds,
      configApiKeyProviderIds: config.apiKeyProviderIds,
      configProviderAuthModes: config.providerAuthModes,
    });
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const body = renderModelProviders({
      connected: gatewaySnapshot.phase === "connected",
      loading: gatewaySnapshot.phase === "connected" && this.data === null && !rosterError,
      refreshing: this.loadClient !== null,
      error: rosterError ?? data.error ?? data.catalogError,
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: this.loaderPending || this.supplemental.loading,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      cards,
      configuredModels: buildSelectableDefaultModels(data.models, defaults),
      defaultModels: defaults,
      thinkingLevel: defaults.thinkingLevel,
      thinkingOverridden: defaults.thinkingOverridden,
      fastMode: defaults.fastMode,
      fastModeOverridden: defaults.fastModeOverridden,
      configBusy: this.configBusy(),
      canMutate: this.canMutate(),
      mutationBlockedReason: this.mutationBlockedReason(),
      providerUsageStalled: this.refreshPolicy.incompleteUsageExhausted,
      probeAvailable: !this.probeUnsupported && advertised !== false,
      busy: this.busy,
      messages: this.messages,
      probeResults: this.probeResults,
      keyEditorProvider: this.keyEditor?.provider ?? null,
      keyDraft: this.keyEditor?.draft ?? "",
      pendingLogoutProvider: this.pendingLogoutProvider,
      providerLoginBusy: this.providerLogin.busy,
      onRefresh: () =>
        void (rosterError ? this.context.agents.refreshList() : this.refresh("discover")),
      onOpenKeyEditor: (provider) => this.openKeyEditor(provider),
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => {
        if (this.keyEditor) {
          this.keyEditor = { ...this.keyEditor, draft: value };
        }
      },
      onSaveKey: (provider, configKey) => void this.saveKey(provider, configKey),
      onRemoveKey: (provider, configKey) => void this.removeKey(provider, configKey),
      onProbe: (cardId, providers) => void this.probe(cardId, providers),
      onRequestLogout: (provider) => (this.pendingLogoutProvider = provider),
      onCancelLogout: () => (this.pendingLogoutProvider = null),
      onLogout: (cardId, providers) => void this.logout(cardId, providers),
      onLogin: (cardId, option) => this.providerLogin.start(cardId, option),
      onPrimaryChange: (model) => {
        const current = this.defaultsDraft ?? configuredDefaults;
        stageDefaults({
          primary: model,
          fallbacks: current.fallbacks.filter((fallback) => fallback !== model),
        });
      },
      onFallbackChange: (model) => {
        const current = this.defaultsDraft ?? configuredDefaults;
        stageDefaults({
          fallbacks: model
            ? [model, ...current.fallbacks.slice(1).filter((fallback) => fallback !== model)]
            : [],
        });
      },
      onUtilityChange: (model) => stageDefaults({ utilityModel: model }),
      onThinkingChange: (level) =>
        stageDefaults({ thinkingLevel: level, thinkingOverridden: true }),
      onThinkingReset: () => stageDefaults({ thinkingLevel: undefined, thinkingOverridden: false }),
      onFastModeChange: (mode) => stageDefaults({ fastMode: mode, fastModeOverridden: true }),
      onFastModeReset: () => stageDefaults({ fastMode: undefined, fastModeOverridden: false }),
      onOpenModelSetup: () => this.connect.open(),
    });
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("model-providers"),
        subtitle: html`${t("modelProviders.subtitle")}
        ${renderLearnMoreLink(MODEL_PROVIDERS_DOCS_URL)}`,
        actions: html`
          ${renderAgentScopeControl({
            agents,
            selection: this.context.agentSelection,
            allowAll: false,
            selectedId: this.selectedAgentId,
          })}
          <button class="btn primary" data-models-connect @click=${() => this.connect.open()}>
            ${icons.settings}<span>${t("modelProviders.configureModels")}</span>
          </button>
        `,
      })}
      ${renderSettingsWorkspace(body)} ${this.providerLogin.render()}
    `;
  }
}

if (!customElements.get("openclaw-model-providers-page")) {
  customElements.define("openclaw-model-providers-page", ModelProvidersPage);
}
