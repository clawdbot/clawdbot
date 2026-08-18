import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { peekChatMetadata, revalidateChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import { isChatModelUnavailable } from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "../chat/components/chat-model-controls.ts";
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
type NewSessionMetadataLoad = {
  agentId: string;
  context: ApplicationContext;
  options: NewSessionMetadataLoadOptions;
  selectionGeneration: number;
};

type CatalogCreateTarget = Pick<SessionCatalog, "id" | "label">;
type ReconciledNewSessionSelection = {
  model: string;
  thinkingLevel: string;
  repaired: boolean;
};

type DraftModelTarget = {
  entry?: ModelCatalogEntry;
  model: string;
  provider: string | null;
};

function resolveDraftModelTarget(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): DraftModelTarget | null {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  const entry = catalog.find(
    (candidate) =>
      buildQualifiedChatModelValue(candidate.id, candidate.provider).toLowerCase() === normalized,
  );
  if (entry) {
    return {
      entry,
      model: entry.id,
      provider: normalizeChatModelProviderId(entry.provider) || null,
    };
  }
  const separator = value.indexOf("/");
  if (separator > 0) {
    return {
      model: value.slice(separator + 1),
      provider: normalizeChatModelProviderId(value.slice(0, separator)) || null,
    };
  }
  return {
    model: value,
    provider: normalizeChatModelProviderId(provider ?? "") || null,
  };
}

export class NewSessionModelControl {
  private selectionGeneration = 0;
  private agentId = "";
  private metadataState: NewSessionMetadataState = {
    catalog: [],
    hasSnapshot: false,
    status: "idle",
  };
  private metadataRequestId = 0;
  private activeMetadataRequest:
    | {
        agentId: string;
        client: NewSessionMetadataClient;
        id: number;
      }
    | undefined;
  private lastMetadataLoad: NewSessionMetadataLoad | undefined;
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingAgent: GatewayAgentRow | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private catalogTargets: CatalogCreateTarget[] = [];
  private catalogTargetRequestId = 0;
  private activeCatalogTargetRequest:
    | {
        agentId: string;
        client: NewSessionMetadataClient;
        controller: AbortController;
        id: number;
      }
    | undefined;
  private catalogTargetOwner:
    | { agentId: string; client: NewSessionMetadataClient; loaded: boolean }
    | undefined;
  selected = "";
  thinkingLevel = "";

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

  private cancelMetadataRequest() {
    if (!this.activeMetadataRequest) {
      return;
    }
    this.activeMetadataRequest = undefined;
    this.metadataRequestId += 1;
  }

  private clearCatalogTargets() {
    const active = this.activeCatalogTargetRequest;
    this.activeCatalogTargetRequest = undefined;
    this.catalogTargetRequestId += 1;
    active?.controller.abort();
    const changed = this.catalogTargets.length > 0 || this.catalogTargetOwner !== undefined;
    this.catalogTargets = [];
    this.catalogTargetOwner = undefined;
    if (changed) {
      this.notify();
    }
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
    if (
      this.catalogTargetOwner?.client === client &&
      this.catalogTargetOwner.agentId === normalizedAgentId &&
      (this.catalogTargetOwner.loaded || this.activeCatalogTargetRequest)
    ) {
      return;
    }

    this.clearCatalogTargets();
    const controller = new AbortController();
    const requestId = ++this.catalogTargetRequestId;
    this.catalogTargetOwner = { agentId: normalizedAgentId, client, loaded: false };
    this.activeCatalogTargetRequest = {
      agentId: normalizedAgentId,
      client,
      controller,
      id: requestId,
    };
    void client
      .request<SessionsCatalogListResult>(
        "sessions.catalog.list",
        { agentId: normalizedAgentId, limitPerHost: 1 },
        { signal: controller.signal },
      )
      .then(
        (result) => {
          if (this.activeCatalogTargetRequest?.id !== requestId) {
            return;
          }
          this.activeCatalogTargetRequest = undefined;
          this.catalogTargetOwner = { agentId: normalizedAgentId, client, loaded: true };
          this.catalogTargets = result.catalogs
            .filter((catalog) => catalog.capabilities.createSession !== undefined)
            .map(({ id, label }) => ({ id, label }));
          this.notify();
        },
        () => {
          if (this.activeCatalogTargetRequest?.id !== requestId) {
            return;
          }
          this.activeCatalogTargetRequest = undefined;
          this.catalogTargetOwner = { agentId: normalizedAgentId, client, loaded: true };
          this.catalogTargets = [];
          this.notify();
        },
      );
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
    this.cancelMetadataRequest();
    const requestId = ++this.metadataRequestId;
    this.activeMetadataRequest = {
      agentId,
      client,
      id: requestId,
    };
    const cached = peekChatMetadata(client, agentId);
    if (Array.isArray(cached?.models)) {
      this.publishMetadataCatalog(cached.models, "refreshing");
    } else {
      this.updateMetadataState({
        ...this.metadataState,
        status: this.metadataState.hasSnapshot ? "refreshing" : "loading",
      });
    }

    void revalidateChatMetadata(client, agentId, {
      startupRetryWindowMs: 60_000,
    }).then(
      (result) => {
        // Only the request that still owns the control may publish catalog data
        // or restore preferences.
        if (this.activeMetadataRequest?.id !== requestId) {
          return;
        }
        this.activeMetadataRequest = undefined;
        this.publishMetadataCatalog(Array.isArray(result.models) ? result.models : [], "ready");
      },
      () => {
        if (this.activeMetadataRequest?.id !== requestId) {
          return;
        }
        this.activeMetadataRequest = undefined;
        this.metadataState = {
          ...this.metadataState,
          status: "error",
        };
        if (
          this.pendingSelectionGeneration === this.selectionGeneration &&
          (this.pendingPreference?.model || this.pendingPreference?.thinkingLevel)
        ) {
          // A transport failure says nothing about current availability.
          // Preserve the requested pair so sessions.create remains the
          // authoritative validator instead of silently using defaults.
          this.selected = this.pendingPreference.model ?? "";
          this.thinkingLevel = this.pendingPreference.thinkingLevel ?? "";
        }
        this.restoringPreference = false;
        this.notify();
      },
    );
  }

  private readonly retryMetadata = () => {
    const pending = this.lastMetadataLoad;
    if (!pending) {
      return;
    }
    this.load(pending.context, pending.agentId, true, {
      ...pending.options,
      ...(pending.selectionGeneration === this.selectionGeneration
        ? {}
        : { preference: undefined }),
    });
  };

  invalidate(resetSelection = false) {
    this.cancelMetadataRequest();
    this.clearCatalogTargets();
    this.restoringPreference = false;
    if (resetSelection) {
      this.agentId = "";
      this.selected = "";
      this.thinkingLevel = "";
      this.lastMetadataLoad = undefined;
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
    if (this.agentId !== normalizedAgentId) {
      // Catalog availability belongs to an agent. A real owner change clears
      // the snapshot; same-agent refreshes retain it until replacement.
      this.cancelMetadataRequest();
      this.agentId = normalizedAgentId;
      this.selected = "";
      this.thinkingLevel = "";
      this.lastMetadataLoad = undefined;
      this.metadataState = {
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      };
    }
    const selectionGeneration = this.selectionGeneration;
    if (!context || snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.cancelMetadataRequest();
      this.restoringPreference = false;
      if (context && snapshot?.phase !== "connected") {
        this.metadataState = {
          ...this.metadataState,
          status: "offline",
        };
      }
      this.notify();
      return;
    }
    this.lastMetadataLoad = {
      agentId: normalizedAgentId,
      context,
      options,
      selectionGeneration,
    };
    this.pendingPreference = options.preference;
    this.pendingAgent = options.agent;
    this.pendingContext = context;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      options.preference?.model || options.preference?.thinkingLevel,
    );
    if (
      this.activeMetadataRequest?.client === client &&
      this.activeMetadataRequest.agentId === normalizedAgentId
    ) {
      this.notify();
      return;
    }
    this.startMetadataRequest(client, normalizedAgentId);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  isModelUnavailable(agent: GatewayAgentRow | undefined): boolean {
    return (
      this.metadataState.hasSnapshot &&
      (this.metadataState.status === "ready" || this.metadataState.status === "refreshing") &&
      isChatModelUnavailable(this.selected || agent?.model?.primary, undefined, this.catalog)
    );
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
        ...(this.metadataState.status === "error" ? { onRetry: this.retryMetadata } : {}),
        status:
          !agentDefaultsAvailable && this.metadataState.status !== "error"
            ? "loading"
            : this.metadataState.status,
      },
      modelOverrides: { [sessionKey]: this.selected },
      modelPickerTargetGroups:
        this.catalogTargets.length > 0
          ? [
              {
                id: "cliAgents",
                label: t("newSession.cliAgentsGroup"),
                options: this.catalogTargets.map(({ id, label }) => ({ value: id, label })),
              },
            ]
          : undefined,
      modelSwitching: false,
      sending: options.sending,
      sessionKey,
      sessionsResult: sourceResult,
      showFastMode: false,
      stream: null,
      thinkingDefaults,
      thinkingSession: thinkingTarget,
      onModelSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        const selection = this.reconcileSelection(value, this.thinkingLevel, options);
        this.selected = selection.model;
        this.thinkingLevel = selection.thinkingLevel;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onModelPickerTargetSelect: (groupId, catalogId) => {
        if (groupId === "cliAgents") {
          this.onCatalogTargetSelect(catalogId);
        }
      },
      onThinkingSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.thinkingLevel = value;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onModelSetup: () => options.context?.navigate("model-setup"),
      onRequestUpdate: this.notify,
    });
  }
}
