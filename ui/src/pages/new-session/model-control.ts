import type {
  ChatAccountSelection,
  ChatMetadataParams,
  UserModelAccount,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { FastMode, GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import {
  peekChatMetadata,
  revalidateChatMetadata,
  subscribeChatMetadata,
  type ChatMetadataResult,
} from "../../lib/chat/chat-metadata-store.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  isChatFastModeProviderSupported,
  chatModelUnavailableMessage,
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelAccountControl } from "../chat/components/chat-model-account-control.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "../chat/components/chat-model-controls.ts";
import { CatalogTargetDiscovery } from "./catalog-target.ts";
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
  accountSelection?: ChatAccountSelection;
  hasSnapshot: boolean;
  status: NewSessionMetadataStatus;
};
type NewSessionMetadataLoadOptions = {
  agent?: GatewayAgentRow;
  preference?: NewSessionPreference | null;
};

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
  private metadataScope: ChatMetadataParams | undefined;
  private metadataIdentityId: string | undefined;
  private metadataHello: ApplicationContext["gateway"]["snapshot"]["hello"] | undefined;
  private metadataUnsubscribe: (() => void) | undefined;
  private draftAccount:
    | (Pick<UserModelAccount, "authProfileId" | "provider"> & { model: string })
    | undefined;
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingAgent: GatewayAgentRow | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private readonly catalogTargets: CatalogTargetDiscovery;
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
  ) {
    this.catalogTargets = new CatalogTargetDiscovery(notify);
  }

  private get catalog(): ModelCatalogEntry[] {
    return this.metadataState.catalog;
  }

  private get effectiveModel(): string {
    return this.draftAccount?.model ?? this.selected;
  }

  private clearMetadataSubscription() {
    this.metadataUnsubscribe?.();
    this.metadataUnsubscribe = undefined;
    this.metadataScope = undefined;
  }

  private ownsMetadata(client: NewSessionMetadataClient, scope: ChatMetadataParams): boolean {
    const snapshot = this.pendingContext?.gateway.snapshot;
    return (
      this.metadataClient === client &&
      this.metadataScope === scope &&
      snapshot?.phase === "connected" &&
      snapshot.client === client &&
      snapshot.hello === this.metadataHello &&
      snapshot.selfUser?.id === this.metadataIdentityId
    );
  }

  private bindMetadataSubscription(client: NewSessionMetadataClient, scope: ChatMetadataParams) {
    if (
      this.metadataClient === client &&
      this.metadataScope?.agentId === scope.agentId &&
      this.metadataScope?.authProfileId === scope.authProfileId &&
      this.metadataUnsubscribe
    ) {
      return;
    }
    this.clearMetadataSubscription();
    this.metadataClient = client;
    this.metadataScope = scope;
    this.metadataUnsubscribe = subscribeChatMetadata(client, scope, (update) => {
      if (this.metadataClient !== client || this.metadataScope !== scope) {
        return;
      }
      if (!this.ownsMetadata(client, scope)) {
        this.metadataLoading = false;
        this.restoringPreference = false;
        this.draftAccount = undefined;
        this.clearMetadataSubscription();
        this.updateMetadataState({ catalog: [], hasSnapshot: false, status: "offline" });
        return;
      }
      if (update.type === "invalidated") {
        void this.startMetadataRequest(client, scope);
        return;
      }
      this.metadataLoading = update.type === "loading";
      if (update.type === "result") {
        this.publishMetadataCatalog(update.result);
      } else if (update.type === "loading") {
        const status = this.metadataState.hasSnapshot ? "ready" : "loading";
        if (this.metadataState.status !== status) {
          this.updateMetadataState({ ...this.metadataState, status });
        }
      } else {
        if (
          !this.draftAccount &&
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

  loadCatalogTargets(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    this.catalogTargets.load(context, agentId, enabled);
  }

  private updateMetadataState(next: NewSessionMetadataState) {
    this.metadataState = next;
    this.notify();
  }

  private publishMetadataCatalog(result: ChatMetadataResult) {
    this.metadataState = {
      catalog: Array.isArray(result.models) ? result.models : [],
      accountSelection: result.accountSelection,
      hasSnapshot: true,
      status: "ready",
    };
    if (!this.draftAccount && this.pendingSelectionGeneration === this.selectionGeneration) {
      this.restorePreference(this.pendingPreference, this.pendingAgent, this.pendingContext);
    }
    this.restoringPreference = false;
    this.notify();
  }

  private startMetadataRequest(client: NewSessionMetadataClient, scope: ChatMetadataParams) {
    this.metadataLoading = true;
    const cached = peekChatMetadata(client, scope);
    if (Array.isArray(cached?.models)) {
      this.publishMetadataCatalog(cached);
    } else {
      this.updateMetadataState({
        ...this.metadataState,
        status: this.metadataState.hasSnapshot ? "ready" : "loading",
      });
    }

    return revalidateChatMetadata(client, scope, {
      startupRetryWindowMs: 60_000,
    }).catch(() => undefined);
  }

  private selectDraftAccount(account: UserModelAccount, model: string): Promise<boolean> {
    const client = this.metadataClient;
    if (!client || !model) {
      return Promise.resolve(false);
    }
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.draftAccount = { authProfileId: account.authProfileId, provider: account.provider, model };
    const scope = { agentId: this.agentId, authProfileId: account.authProfileId };
    this.metadataState = {
      catalog: [],
      accountSelection: this.metadataState.accountSelection,
      hasSnapshot: false,
      status: "loading",
    };
    this.bindMetadataSubscription(client, scope);
    return this.startMetadataRequest(client, scope).then(
      (result) => Boolean(result) && this.ownsMetadata(client, scope),
    );
  }

  private clearDraftAccount() {
    if (!this.draftAccount) {
      return;
    }
    this.draftAccount = undefined;
    this.metadataLoading = false;
    this.clearMetadataSubscription();
    this.metadataState = { catalog: [], hasSnapshot: false, status: "idle" };
  }

  private retryPickerCatalogs(refreshReadyMetadata = false) {
    const metadataClient = this.metadataClient;
    const scope = this.metadataScope;
    if (this.metadataState.status === "error" && metadataClient && scope) {
      void this.startMetadataRequest(metadataClient, scope);
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
        if (this.metadataClient === metadataClient && this.metadataScope === scope) {
          this.updateMetadataState({ ...this.metadataState, status: "error" });
        }
      });
    }
    this.catalogTargets.retry(metadataClient, this.agentId);
  }

  invalidate(resetSelection = false) {
    this.metadataLoading = false;
    this.clearDraftAccount();
    this.catalogTargets.clear();
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
    this.pendingContext = context;
    if (
      this.agentId !== normalizedAgentId ||
      (this.metadataClient && this.metadataClient !== client) ||
      this.metadataIdentityId !== snapshot?.selfUser?.id ||
      (this.metadataHello && this.metadataHello !== snapshot?.hello)
    ) {
      // Model preferences belong to the agent; an explicit account belongs to this connection.
      // Neither its availability nor an in-flight preview can cross an identity change.
      this.metadataLoading = false;
      this.draftAccount = undefined;
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
    this.metadataIdentityId = snapshot?.selfUser?.id;
    this.metadataHello = snapshot?.hello;
    const selectionGeneration = this.selectionGeneration;
    if (!context || snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.metadataLoading = false;
      this.clearDraftAccount();
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
    const scope = {
      agentId: normalizedAgentId,
      ...(this.draftAccount ? { authProfileId: this.draftAccount.authProfileId } : {}),
    };
    this.bindMetadataSubscription(client, scope);
    this.pendingPreference = options.preference;
    this.pendingAgent = options.agent;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      !this.draftAccount && (options.preference?.model || options.preference?.thinkingLevel),
    );
    const cached = peekChatMetadata(client, scope);
    if (this.metadataLoading) {
      if (cached) {
        this.publishMetadataCatalog(cached);
      } else {
        this.notify();
      }
      return;
    }
    if (cached && this.metadataState.status !== "error") {
      this.publishMetadataCatalog(cached);
      return;
    }
    void this.startMetadataRequest(client, this.metadataScope ?? scope);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  modelUnavailableReason(
    agent: GatewayAgentRow | undefined,
  ): ModelCatalogEntry["unavailableReason"] {
    return this.metadataState.hasSnapshot && this.metadataState.status !== "offline"
      ? resolveChatModelUnavailableReason(
          this.effectiveModel || agent?.model?.primary,
          undefined,
          this.catalog,
        )
      : undefined;
  }

  modelSelectionBlockedReason(agent: GatewayAgentRow | undefined): string | undefined {
    if (this.draftAccount) {
      if (this.metadataState.status === "error") {
        return t("chat.modelControls.modelsUnavailable");
      }
      if (this.metadataLoading || !this.metadataState.hasSnapshot) {
        return t("chat.modelControls.loadingModels");
      }
      if (!this.accountSelectionReady()) {
        return (
          chatModelUnavailableMessage(this.modelUnavailableReason(agent)) ??
          t("chat.modelControls.modelsUnavailable")
        );
      }
    }
    return chatModelUnavailableMessage(this.modelUnavailableReason(agent));
  }

  modelForSubmission(): string {
    // Scope inspection also reads this intent while the submit gate waits for its preview.
    // The account suffix never enters the plain model preferences.
    return this.draftAccount
      ? `${this.draftAccount.model}@${this.draftAccount.authProfileId}`
      : this.selected;
  }

  accountSelectionReady(): boolean {
    if (!this.draftAccount) {
      return true;
    }
    const selection = this.metadataState.accountSelection;
    if (
      !this.metadataClient ||
      !this.metadataScope ||
      !this.ownsMetadata(this.metadataClient, this.metadataScope) ||
      this.metadataLoading ||
      this.metadataState.status !== "ready" ||
      selection?.kind !== "personal" ||
      selection.authProfileId !== this.draftAccount.authProfileId
    ) {
      return false;
    }
    const target = resolveDraftModelTarget(this.draftAccount.model, undefined, this.catalog);
    return target?.entry?.available === true && target.provider === this.draftAccount.provider;
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
    if (this.effectiveModel) {
      // Agent/default runtime metadata belongs to its default model. An explicit
      // model without per-model metadata is unknown, not an inherited runtime.
      runtime = resolveDraftModelTarget(this.effectiveModel, undefined, this.catalog)?.entry
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
    const selectedTarget = resolveDraftModelTarget(this.effectiveModel, undefined, this.catalog);
    const client = snapshot?.client;
    const scope = this.metadataScope;
    const accountSelection = this.metadataState.accountSelection;
    const ownsSelection = () =>
      Boolean(
        client &&
        scope &&
        this.ownsMetadata(client, scope) &&
        this.metadataState.accountSelection === accountSelection,
      );
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
      renderAccountControl: (model) =>
        renderChatModelAccountControl({
          owner: this,
          client,
          selection: ownsSelection() && snapshot?.selfUser ? accountSelection : undefined,
          model,
          disabled:
            options.sending || !model || !hasOperatorWriteAccess(snapshot?.hello?.auth ?? null),
          ownsSelection,
          onSelect: (account) =>
            ownsSelection() ? this.selectDraftAccount(account, model) : Promise.resolve(false),
          onAutomatic: this.draftAccount
            ? () => {
                if (ownsSelection()) {
                  this.selectionGeneration += 1;
                  this.clearDraftAccount();
                  this.load(options.context, options.agentId, true, { agent: options.agent });
                }
              }
            : undefined,
          onManage: () => options.context?.navigate("profile"),
          onRequestUpdate: this.notify,
          hint: t("chat.modelAccounts.draftHint"),
        }),
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
      modelOverrides: { [sessionKey]: this.effectiveModel },
      modelPickerTargetGroups: this.catalogTargets.groups(),
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
        const target =
          resolveDraftModelTarget(selection.model, undefined, this.catalog) ?? defaultTarget;
        if (this.draftAccount && this.draftAccount.provider !== target?.provider) {
          this.clearDraftAccount();
          this.load(options.context, options.agentId, true, { agent: options.agent });
        } else if (this.draftAccount && target) {
          this.draftAccount = {
            ...this.draftAccount,
            model: buildQualifiedChatModelValue(target.model, target.provider),
          };
        }
        this.contextWindow = "";
        this.thinkingLevel = selection.thinkingLevel;
        this.fastMode = isChatFastModeProviderSupported(
          (resolveDraftModelTarget(selection.model, undefined, this.catalog) ?? defaultTarget)
            ?.provider,
        )
          ? this.fastMode
          : undefined;
        this.onSelectionChange({ model: selection.model, thinkingLevel: this.thinkingLevel });
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
