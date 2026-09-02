import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { FastMode, GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  peekChatMetadata,
  revalidateChatMetadata,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  isChatFastModeProviderSupported,
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "../chat/components/chat-model-controls.ts";
import type { ChatModelPickerTargetGroup } from "../chat/components/chat-model-picker-options.ts";
import { draftCloudProfileSupportsExecutionMode, type DraftCloudProfile } from "./discovery.ts";
import { resolveDraftModelTarget } from "./model-target.ts";
import type { NewSessionPreference } from "./preferences.ts";

type NewSessionMetadataClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type GatewayAgentRuntime = NonNullable<GatewayAgentRow["agentRuntime"]> & {
  cloudPlacementSupported?: boolean;
};
type NewSessionMetadataStatus = ChatModelCatalogState["status"];
type NewSessionMetadataState = {
  catalog: ModelCatalogEntry[];
  hasSnapshot: boolean;
  status: NewSessionMetadataStatus;
};
type NewSessionMetadataLoadOptions = {
  agent?: GatewayAgentRow;
  preference?: NewSessionPreference | null;
};

type CatalogCreateTarget = Pick<SessionCatalog, "id" | "label">;
type CatalogTargetOwner = { agentId: string; client: NewSessionMetadataClient };
type CatalogTargetDiscoveryState =
  | { status: "idle" }
  | {
      status: "loading";
      owner: CatalogTargetOwner;
      controller: AbortController;
      requestId: number;
    }
  | { status: "ready"; owner: CatalogTargetOwner; targets: CatalogCreateTarget[] }
  | { status: "error"; owner: CatalogTargetOwner };
type ReconciledNewSessionSelection = {
  model: string;
  thinkingLevel: string;
  repaired: boolean;
};

export class NewSessionModelControl {
  private selectionGeneration = 0;
  private agentId = "";
  private metadataState: NewSessionMetadataState = {
    catalog: [],
    hasSnapshot: false,
    status: "idle",
  };
  private metadataLoading = false;
  private metadataClient: NewSessionMetadataClient | undefined;
  private metadataUnsubscribe: (() => void) | undefined;
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingAgent: GatewayAgentRow | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private catalogTargetRequestId = 0;
  private catalogTargetDiscovery: CatalogTargetDiscoveryState = { status: "idle" };
  selected = "";
  contextWindow = "";
  thinkingLevel = "";
  fastMode: FastMode | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly onSelectionChange: (selection: {
      model: string;
      thinkingLevel: string;
    }) => void = () => undefined,
    private readonly onCatalogTargetSelect: (catalogId: string) => void = () => undefined,
  ) {}

  private get catalog(): ModelCatalogEntry[] {
    return this.metadataState.catalog;
  }

  private clearMetadataSubscription() {
    this.metadataUnsubscribe?.();
    this.metadataUnsubscribe = undefined;
  }

  private bindMetadataSubscription(client: NewSessionMetadataClient, agentId: string) {
    if (this.metadataClient === client && this.metadataUnsubscribe) {
      return;
    }
    this.clearMetadataSubscription();
    this.metadataClient = client;
    this.metadataUnsubscribe = subscribeChatMetadata(client, { agentId }, (update) => {
      if (this.metadataClient !== client || this.agentId !== agentId) {
        return;
      }
      const snapshot = this.pendingContext?.gateway.snapshot;
      if (snapshot?.phase !== "connected" || snapshot.client !== client) {
        this.metadataLoading = false;
        this.restoringPreference = false;
        this.updateMetadataState({ catalog: [], hasSnapshot: false, status: "offline" });
        return;
      }
      if (update.type === "invalidated") {
        this.startMetadataRequest(client, agentId);
        return;
      }
      this.metadataLoading = update.type === "loading";
      if (update.type === "result") {
        this.publishMetadataCatalog(
          Array.isArray(update.result.models) ? update.result.models : [],
          "ready",
        );
      } else if (update.type === "loading") {
        const status = this.metadataState.hasSnapshot ? "ready" : "loading";
        if (this.metadataState.status !== status) {
          this.updateMetadataState({ ...this.metadataState, status });
        }
      } else {
        if (
          this.pendingSelectionGeneration === this.selectionGeneration &&
          (this.pendingPreference?.model || this.pendingPreference?.thinkingLevel)
        ) {
          // A transport failure cannot authorize a model or replace the requested preference.
          this.selected = this.pendingPreference.model ?? "";
          this.thinkingLevel = this.pendingPreference.thinkingLevel ?? "";
        }
        this.restoringPreference = false;
        this.updateMetadataState({ ...this.metadataState, status: "error" });
      }
    });
  }

  private clearCatalogTargets() {
    const previous = this.catalogTargetDiscovery;
    this.catalogTargetDiscovery = { status: "idle" };
    this.catalogTargetRequestId += 1;
    if (previous.status === "loading") {
      previous.controller.abort();
    }
    if (previous.status !== "idle") {
      this.notify();
    }
  }

  private startCatalogTargetRequest(owner: CatalogTargetOwner) {
    const controller = new AbortController();
    const requestId = ++this.catalogTargetRequestId;
    this.catalogTargetDiscovery = { status: "loading", owner, controller, requestId };
    this.notify();
    void owner.client
      .request<SessionsCatalogListResult>(
        "sessions.catalog.list",
        { agentId: owner.agentId, limitPerHost: 1 },
        { signal: controller.signal },
      )
      .then(
        (result) => {
          const active = this.catalogTargetDiscovery;
          if (active.status !== "loading" || active.requestId !== requestId) {
            return;
          }
          this.catalogTargetDiscovery = {
            status: "ready",
            owner,
            targets: result.catalogs
              .filter((catalog) => catalog.capabilities.createSession !== undefined)
              .map(({ id, label }) => ({ id, label })),
          };
          this.notify();
        },
        () => {
          const active = this.catalogTargetDiscovery;
          if (active.status !== "loading" || active.requestId !== requestId) {
            return;
          }
          this.catalogTargetDiscovery = { status: "error", owner };
          this.notify();
        },
      );
  }

  loadCatalogTargets(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    if (
      !enabled ||
      snapshot?.phase !== "connected" ||
      !client ||
      !normalizedAgentId ||
      isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
    ) {
      this.clearCatalogTargets();
      return;
    }
    const owner = { agentId: normalizedAgentId, client };
    const current = this.catalogTargetDiscovery;
    if (
      current.status !== "idle" &&
      current.owner.client === owner.client &&
      current.owner.agentId === owner.agentId
    ) {
      return;
    }

    this.clearCatalogTargets();
    this.startCatalogTargetRequest(owner);
  }

  private updateMetadataState(next: NewSessionMetadataState) {
    this.metadataState = next;
    this.notify();
  }

  private publishMetadataCatalog(catalog: ModelCatalogEntry[], status: NewSessionMetadataStatus) {
    this.metadataState = { catalog, hasSnapshot: true, status };
    if (this.pendingSelectionGeneration === this.selectionGeneration) {
      this.restorePreference(this.pendingPreference, this.pendingAgent, this.pendingContext);
    }
    this.restoringPreference = false;
    this.notify();
  }

  private startMetadataRequest(client: NewSessionMetadataClient, agentId: string) {
    this.metadataLoading = true;
    const cached = peekChatMetadata(client, { agentId });
    if (Array.isArray(cached?.models)) {
      this.publishMetadataCatalog(cached.models, "ready");
    } else {
      this.updateMetadataState({
        ...this.metadataState,
        status: this.metadataState.hasSnapshot ? "ready" : "loading",
      });
    }

    void revalidateChatMetadata(
      client,
      { agentId },
      {
        startupRetryWindowMs: 60_000,
      },
    ).catch(() => undefined);
  }

  private retryPickerCatalogs(refreshReadyMetadata = false) {
    const metadataClient = this.metadataClient;
    if (this.metadataState.status === "error" && metadataClient && this.agentId) {
      this.startMetadataRequest(metadataClient, this.agentId);
    } else if (
      refreshReadyMetadata &&
      this.metadataState.status === "ready" &&
      metadataClient &&
      this.agentId
    ) {
      const agentId = this.agentId;
      void loadModelCatalog(metadataClient, {
        agentId,
        refreshIfDue: true,
        rejectOnFailure: true,
      }).catch(() => {
        if (this.metadataClient === metadataClient && this.agentId === agentId) {
          this.updateMetadataState({ ...this.metadataState, status: "error" });
        }
      });
    }
    const targetDiscovery = this.catalogTargetDiscovery;
    if (
      targetDiscovery.status === "error" &&
      targetDiscovery.owner.client === metadataClient &&
      targetDiscovery.owner.agentId === this.agentId
    ) {
      this.startCatalogTargetRequest(targetDiscovery.owner);
    }
  }

  private catalogTargetGroups(): readonly ChatModelPickerTargetGroup[] | undefined {
    const discovery = this.catalogTargetDiscovery;
    if (
      discovery.status === "idle" ||
      (discovery.status === "ready" && !discovery.targets.length)
    ) {
      return undefined;
    }
    return [
      {
        errorLabel: t("newSession.cliAgentsUnavailable"),
        id: "cliAgents",
        label: t("newSession.cliAgentsGroup"),
        options:
          discovery.status === "ready"
            ? discovery.targets.map(({ id, label }) => ({ value: id, label }))
            : [],
        status: discovery.status,
      },
    ];
  }

  invalidate(resetSelection = false) {
    this.metadataLoading = false;
    this.clearCatalogTargets();
    this.restoringPreference = false;
    if (resetSelection) {
      this.agentId = "";
      this.metadataClient = undefined;
      this.clearMetadataSubscription();
      this.selected = "";
      this.contextWindow = "";
      this.thinkingLevel = "";
      this.fastMode = undefined;
      this.updateMetadataState({
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      });
      return;
    }
    this.updateMetadataState({
      ...this.metadataState,
      status: this.metadataState.hasSnapshot ? "error" : "idle",
    });
  }

  reset() {
    this.invalidate(true);
  }

  load(
    context: ApplicationContext | undefined,
    agentId: string,
    enabled: boolean,
    options: NewSessionMetadataLoadOptions = {},
  ) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    if (
      this.agentId !== normalizedAgentId ||
      (this.metadataClient && this.metadataClient !== client)
    ) {
      // A new client retires availability, but draft choices belong to the agent.
      // Gateway-owner changes clear those choices through invalidate(true).
      this.metadataLoading = false;
      this.clearMetadataSubscription();
      if (this.agentId !== normalizedAgentId) {
        this.selected = "";
        this.contextWindow = "";
        this.thinkingLevel = "";
        this.fastMode = undefined;
      }
      this.agentId = normalizedAgentId;
      this.metadataClient = undefined;
      this.metadataState = {
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      };
    }
    const selectionGeneration = this.selectionGeneration;
    if (!context || snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.metadataLoading = false;
      this.clearMetadataSubscription();
      this.metadataClient = undefined;
      this.restoringPreference = false;
      if (context && snapshot?.phase !== "connected") {
        this.metadataState = {
          catalog: [],
          hasSnapshot: false,
          status: "offline",
        };
      }
      this.notify();
      return;
    }
    this.bindMetadataSubscription(client, normalizedAgentId);
    this.pendingPreference = options.preference;
    this.pendingAgent = options.agent;
    this.pendingContext = context;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      options.preference?.model || options.preference?.thinkingLevel,
    );
    const cached = peekChatMetadata(client, { agentId: normalizedAgentId });
    if (this.metadataLoading) {
      if (cached) {
        this.publishMetadataCatalog(Array.isArray(cached.models) ? cached.models : [], "ready");
      } else {
        this.notify();
      }
      return;
    }
    if (cached && this.metadataState.status !== "error") {
      this.publishMetadataCatalog(Array.isArray(cached.models) ? cached.models : [], "ready");
      return;
    }
    this.startMetadataRequest(client, normalizedAgentId);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  modelUnavailableReason(
    agent: GatewayAgentRow | undefined,
  ): ModelCatalogEntry["unavailableReason"] {
    return this.metadataState.hasSnapshot && this.metadataState.status !== "offline"
      ? resolveChatModelUnavailableReason(
          this.selected || agent?.model?.primary,
          undefined,
          this.catalog,
        )
      : undefined;
  }

  private restorePreference(
    preference: NewSessionPreference | null | undefined,
    agent: GatewayAgentRow | undefined,
    context: ApplicationContext | undefined,
  ) {
    if (!preference) {
      return;
    }
    const selection = this.reconcileSelection(
      preference.model ?? "",
      preference.thinkingLevel ?? "",
      { agent, context },
    );
    this.selected = selection.model;
    this.thinkingLevel = selection.thinkingLevel;
    if (selection.repaired) {
      this.onSelectionChange({ model: selection.model, thinkingLevel: selection.thinkingLevel });
    }
  }

  private reconcileSelection(
    model: string,
    thinkingLevel: string,
    options: { agent?: GatewayAgentRow; context: ApplicationContext | undefined },
  ): ReconciledNewSessionSelection {
    const requestedModel = model.trim();
    const selectedTarget = requestedModel
      ? resolveDraftModelTarget(requestedModel, undefined, this.catalog)
      : null;
    if (requestedModel && (!selectedTarget?.entry || selectedTarget.entry.available === false)) {
      return { model: "", thinkingLevel: "", repaired: true };
    }
    const selected = selectedTarget?.entry
      ? buildQualifiedChatModelValue(selectedTarget.entry.id, selectedTarget.entry.provider)
      : "";
    if (!thinkingLevel) {
      return { model: selected, thinkingLevel: "", repaired: false };
    }
    const defaults = options.context?.sessions.state.result?.defaults;
    const agentDefaultModel = options.agent?.model?.primary;
    const defaultTarget = selected
      ? null
      : resolveDraftModelTarget(
          agentDefaultModel ?? defaults?.model,
          agentDefaultModel ? undefined : defaults?.modelProvider,
          this.catalog,
        );
    const targetEntry = selectedTarget?.entry ?? defaultTarget?.entry;
    const authoritativeLevels = selected
      ? targetEntry?.thinkingLevels
      : (options.agent?.thinkingLevels ?? defaults?.thinkingLevels ?? targetEntry?.thinkingLevels);
    const normalizedThinking = normalizeThinkingOptionValue(thinkingLevel);
    const supported = authoritativeLevels?.some(
      (level) => normalizeThinkingOptionValue(level.id) === normalizedThinking,
    );
    if (targetEntry?.reasoning === false || (authoritativeLevels !== undefined && !supported)) {
      return { model: selected, thinkingLevel: "", repaired: true };
    }
    return { model: selected, thinkingLevel, repaired: false };
  }

  resolveAgentRuntime(options: {
    agent?: GatewayAgentRow;
    context: ApplicationContext | undefined;
  }): GatewayAgentRuntime | undefined {
    const defaults = options.context?.sessions.state.result?.defaults;
    const agentDefaultModel = options.agent?.model?.primary;
    let runtime: GatewayAgentRuntime | undefined;
    if (this.selected) {
      // Agent/default runtime metadata belongs to its default model. An explicit
      // model without per-model metadata is unknown, not an inherited runtime.
      runtime = resolveDraftModelTarget(this.selected, undefined, this.catalog)?.entry
        ?.agentRuntime;
    } else {
      const defaultTarget = resolveDraftModelTarget(
        agentDefaultModel ?? defaults?.model,
        agentDefaultModel ? undefined : defaults?.modelProvider,
        this.catalog,
      );
      runtime =
        defaultTarget?.entry?.agentRuntime ?? options.agent?.agentRuntime ?? defaults?.agentRuntime;
    }
    const runtimeId = runtime?.id.trim();
    // Default selectors need server-side model/provider policy before they are
    // concrete, so the UI must leave Cloud eligibility to the dispatch gate.
    if (!runtime || !runtimeId || runtimeId === "auto" || runtimeId === "default") {
      return undefined;
    }
    return runtimeId === runtime.id ? runtime : { ...runtime, id: runtimeId };
  }

  devicePlacementUnsupportedReason(): string | undefined {
    const runtime = this.resolveAgentRuntime({
      agent: this.pendingAgent,
      context: this.pendingContext,
    });
    return runtime && !runtime.devicePlacement
      ? t("newSession.deviceRuntimeUnsupported")
      : undefined;
  }

  // Worker-turn runtimes rank automatic placement by free worker slots;
  // remote-exec runtimes select by eligible device order and must not be
  // described as least-busy. Unresolved (auto/default) runtimes fall back to
  // the worker-turn description, matching the server's default policy.
  autoPlacementSelectionMode(): "least-busy" | "eligible-order" {
    const runtime = this.resolveAgentRuntime({
      agent: this.pendingAgent,
      context: this.pendingContext,
    });
    return runtime?.cloudPlacementExecutionMode === "remote-exec" ? "eligible-order" : "least-busy";
  }

  cloudRuntimeUnsupportedReason(profile?: DraftCloudProfile): string | undefined {
    const runtime = this.resolveAgentRuntime({
      agent: this.pendingAgent,
      context: this.pendingContext,
    });
    if (runtime?.cloudPlacementSupported === false) {
      return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
    }
    return runtime &&
      profile &&
      runtime.cloudPlacementExecutionMode &&
      !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
      ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
      : undefined;
  }

  render(options: {
    agent?: GatewayAgentRow;
    agentId: string;
    context: ApplicationContext | undefined;
    sending: boolean;
  }) {
    const snapshot = options.context?.gateway.snapshot;
    const sessionKey = `new-session:${normalizeAgentId(options.agentId)}`;
    const sourceResult = options.context?.sessions.state.result ?? null;
    const agentDefaultsAvailable = options.agent !== undefined;
    const agentDefaultModel = options.agent?.model?.primary;
    const defaultTarget = resolveDraftModelTarget(
      agentDefaultModel ?? sourceResult?.defaults.model,
      agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
      this.catalog,
    );
    const selectedTarget = resolveDraftModelTarget(this.selected, undefined, this.catalog);
    const contextWindowTarget = selectedTarget?.entry ?? defaultTarget?.entry;
    const contextWindowDefault = contextWindowTarget?.contextWindowDefault;
    const selectedContextWindow = this.contextWindow || contextWindowDefault;
    const thinkingTarget = {
      model: selectedTarget?.model,
      modelProvider: selectedTarget?.provider ?? undefined,
      thinkingLevel: this.thinkingLevel || undefined,
    };
    const thinkingDefaults = {
      ...sourceResult?.defaults,
      modelProvider: defaultTarget?.provider ?? sourceResult?.defaults.modelProvider ?? null,
      model: defaultTarget?.model ?? sourceResult?.defaults.model ?? null,
      contextTokens: sourceResult?.defaults.contextTokens ?? null,
      agentRuntime: options.agent?.agentRuntime ?? sourceResult?.defaults.agentRuntime,
      thinkingLevels: options.agent?.thinkingLevels ?? sourceResult?.defaults.thinkingLevels,
      thinkingOptions: options.agent?.thinkingOptions ?? sourceResult?.defaults.thinkingOptions,
      thinkingDefault:
        options.agent?.thinkingDefault ?? sourceResult?.defaults.thinkingDefault ?? "medium",
    };
    return renderChatModelControls({
      activeRunId: null,
      agentDefaultModel,
      connected: snapshot?.phase === "connected",
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelCatalogState: {
        // chat.metadata and agents.list hydrate independently. Do not expose a
        // ready catalog until the selected agent can supply its concrete defaults.
        hasSnapshot: agentDefaultsAvailable && this.metadataState.hasSnapshot,
        status:
          !agentDefaultsAvailable && this.metadataState.status !== "error"
            ? "loading"
            : this.metadataState.status,
      },
      contextWindowTarget:
        contextWindowTarget?.contextWindows && selectedContextWindow
          ? {
              contextWindow: selectedContextWindow,
              contextWindows: contextWindowTarget.contextWindows,
              ...(contextWindowDefault ? { contextWindowDefault } : {}),
            }
          : undefined,
      fastModeTarget: {
        model: selectedTarget?.model ?? defaultTarget?.model,
        modelProvider: selectedTarget?.provider ?? defaultTarget?.provider ?? undefined,
        fastMode: this.fastMode,
        effectiveFastMode:
          this.fastMode ?? (selectedTarget?.entry ?? defaultTarget?.entry)?.effectiveFastMode,
      },
      modelOverrides: { [sessionKey]: this.selected },
      modelSelectionTarget: "session",
      modelPickerTargetGroups: this.catalogTargetGroups(),
      modelSwitching: false,
      sending: options.sending,
      sessionKey,
      selectedSession: undefined,
      sessionsResult: sourceResult,
      stream: null,
      thinkingDefaults,
      thinkingSession: thinkingTarget,
      onModelSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        const selection = this.reconcileSelection(value, this.thinkingLevel, options);
        this.selected = selection.model;
        this.contextWindow = "";
        this.thinkingLevel = selection.thinkingLevel;
        this.fastMode = isChatFastModeProviderSupported(
          (resolveDraftModelTarget(selection.model, undefined, this.catalog) ?? defaultTarget)
            ?.provider,
        )
          ? this.fastMode
          : undefined;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onModelPickerTargetSelect: (groupId, catalogId) => {
        if (groupId === "cliAgents") {
          this.onCatalogTargetSelect(catalogId);
        }
      },
      onModelPickerTargetRetry: (groupId) => {
        if (groupId === "cliAgents") {
          this.retryPickerCatalogs();
        }
      },
      onThinkingSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.thinkingLevel = value;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onFastModeSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.fastMode = normalizeChatFastModeInput(value);
        this.notify();
      },
      onContextWindowSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.contextWindow = value;
        this.notify();
      },
      onModelSetup: () => options.context?.navigate("model-setup"),
      onModelPickerOpen: () => this.retryPickerCatalogs(true),
      onRequestUpdate: this.notify,
    });
  }
}
