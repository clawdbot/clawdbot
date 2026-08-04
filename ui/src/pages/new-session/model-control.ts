import { initialState, Task, TaskStatus } from "@lit/task";
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayAgentRow, GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import { resolveChatThinkingSelectState } from "../../lib/chat/thinking.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelControls } from "../chat/components/chat-model-controls.ts";
import type { NewSessionPreference } from "./preferences.ts";

const NEW_SESSION_METADATA_RETRY_WINDOW_MS = 60_000;

type NewSessionMetadataClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("New-session metadata retry aborted", "AbortError");
}

function waitForMetadataRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

async function requestNewSessionMetadata(
  client: NewSessionMetadataClient,
  agentId: string,
  signal: AbortSignal,
): Promise<{ models?: ModelCatalogEntry[] }> {
  const deadlineAt = Date.now() + NEW_SESSION_METADATA_RETRY_WINDOW_MS;
  let latestStartupError: Error | undefined;

  while (true) {
    if (signal.aborted) {
      throw abortError(signal);
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      if (latestStartupError !== undefined) {
        throw latestStartupError;
      }
      throw new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<{ models?: ModelCatalogEntry[] }>(
        "chat.metadata",
        { agentId },
        {
          signal,
          timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
        },
      );
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs), signal);
    }
  }
}

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

export class NewSessionModelControl implements ReactiveControllerHost {
  private selectionGeneration = 0;
  private agentId = "";
  private catalog: ModelCatalogEntry[] = [];
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingAgent: GatewayAgentRow | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private readonly catalogTask = new Task(this, {
    autoRun: false,
    args: () =>
      [null as ApplicationContext["gateway"]["snapshot"]["client"], "" as string] as const,
    task: ([client, agentId], { signal }) =>
      client ? requestNewSessionMetadata(client, agentId, signal) : initialState,
    onComplete: (result) => {
      this.catalog = Array.isArray(result.models) ? result.models : [];
      if (this.pendingSelectionGeneration === this.selectionGeneration) {
        this.restorePreference(this.pendingPreference, this.pendingAgent, this.pendingContext);
      }
      this.restoringPreference = false;
    },
    onError: () => {
      this.catalog = [];
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
    },
  });
  selected = "";
  thinkingLevel = "";

  constructor(
    private readonly notify: () => void,
    private readonly onSelectionChange: (selection: {
      model: string;
      thinkingLevel: string;
    }) => void = () => undefined,
  ) {}

  readonly updateComplete = Promise.resolve(true);

  addController(_controller: ReactiveController): void {}

  removeController(_controller: ReactiveController): void {}

  requestUpdate(): void {
    this.notify();
  }

  invalidate(resetSelection = false) {
    void this.catalogTask.run([null, ""]);
    this.restoringPreference = false;
    this.catalog = [];
    if (resetSelection) {
      this.agentId = "";
      this.selected = "";
      this.thinkingLevel = "";
    }
  }

  reset() {
    this.invalidate(true);
    this.notify();
  }

  load(
    context: ApplicationContext | undefined,
    agentId: string,
    enabled: boolean,
    options: { agent?: GatewayAgentRow; preference?: NewSessionPreference | null } = {},
  ) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = normalizeAgentId(agentId);
    if (this.agentId !== normalizedAgentId) {
      this.agentId = normalizedAgentId;
      this.selected = "";
      this.thinkingLevel = "";
    }
    const selectionGeneration = this.selectionGeneration;
    this.catalog = [];
    if (snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      void this.catalogTask.run([null, ""]);
      this.restoringPreference = false;
      this.notify();
      return;
    }
    this.pendingPreference = options.preference;
    this.pendingAgent = options.agent;
    this.pendingContext = context;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      options.preference?.model || options.preference?.thinkingLevel,
    );
    void this.catalogTask.run([client, normalizedAgentId]);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  private restorePreference(
    preference: NewSessionPreference | null | undefined,
    agent: GatewayAgentRow | undefined,
    context: ApplicationContext | undefined,
  ) {
    if (!preference) {
      return;
    }
    // A same-agent metadata refresh revalidates the stored pair. Clear the
    // previous restoration first so retired catalog entries cannot survive.
    this.selected = "";
    this.thinkingLevel = "";
    const preferredTarget = preference.model
      ? resolveDraftModelTarget(preference.model, undefined, this.catalog)
      : null;
    if (
      preference.model &&
      (!preferredTarget?.entry || preferredTarget.entry.available === false)
    ) {
      this.onSelectionChange({ model: "", thinkingLevel: "" });
      return;
    }
    this.selected = preferredTarget?.entry
      ? buildQualifiedChatModelValue(preferredTarget.entry.id, preferredTarget.entry.provider)
      : "";
    if (!preference.thinkingLevel) {
      return;
    }
    const sourceResult = context?.sessions.state.result ?? null;
    const agentDefaultModel = agent?.model?.primary;
    const defaultTarget = resolveDraftModelTarget(
      agentDefaultModel ?? sourceResult?.defaults.model,
      agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
      this.catalog,
    );
    const selectedTarget = resolveDraftModelTarget(this.selected, undefined, this.catalog);
    const draftRow: GatewaySessionRow = {
      key: "new-session:preference",
      kind: "direct",
      updatedAt: null,
      ...(selectedTarget
        ? { model: selectedTarget.model, modelProvider: selectedTarget.provider ?? undefined }
        : {}),
    };
    const thinking = resolveChatThinkingSelectState({
      catalog: this.catalog,
      defaults: {
        ...sourceResult?.defaults,
        modelProvider: defaultTarget?.provider ?? sourceResult?.defaults.modelProvider ?? null,
        model: defaultTarget?.model ?? sourceResult?.defaults.model ?? null,
        contextTokens: sourceResult?.defaults.contextTokens ?? null,
        agentRuntime: agent?.agentRuntime ?? sourceResult?.defaults.agentRuntime,
        thinkingLevels: agent?.thinkingLevels ?? sourceResult?.defaults.thinkingLevels,
        thinkingOptions: agent?.thinkingOptions ?? sourceResult?.defaults.thinkingOptions,
        thinkingDefault: agent?.thinkingDefault ?? sourceResult?.defaults.thinkingDefault,
      },
      session: draftRow,
      sessionKey: draftRow.key,
      sessionsResult: sourceResult,
    });
    if (thinking.options.some((entry) => entry.value === preference.thinkingLevel)) {
      this.thinkingLevel = preference.thinkingLevel;
    } else {
      this.onSelectionChange({ model: this.selected, thinkingLevel: "" });
    }
  }

  resolveAgentRuntimeId(options: {
    agent?: GatewayAgentRow;
    context: ApplicationContext | undefined;
  }): string | undefined {
    const defaults = options.context?.sessions.state.result?.defaults;
    const agentDefaultModel = options.agent?.model?.primary;
    if (this.selected) {
      // Agent/default runtime metadata belongs to its default model. An explicit
      // model without per-model metadata is unknown, not an inherited runtime.
      return resolveDraftModelTarget(
        this.selected,
        undefined,
        this.catalog,
      )?.entry?.agentRuntime?.id.trim();
    }
    const defaultTarget = resolveDraftModelTarget(
      agentDefaultModel ?? defaults?.model,
      agentDefaultModel ? undefined : defaults?.modelProvider,
      this.catalog,
    );
    const runtime =
      defaultTarget?.entry?.agentRuntime?.id.trim() ??
      options.agent?.agentRuntime?.id.trim() ??
      defaults?.agentRuntime?.id.trim();
    // Default selectors need server-side model/provider policy before they are
    // concrete, so the UI must leave Cloud eligibility to the dispatch gate.
    return runtime === "auto" || runtime === "default" ? undefined : runtime;
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
    const agentDefaultModel = options.agent?.model?.primary;
    const defaultTarget = resolveDraftModelTarget(
      agentDefaultModel ?? sourceResult?.defaults.model,
      agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
      this.catalog,
    );
    const selectedTarget = resolveDraftModelTarget(this.selected, undefined, this.catalog);
    const draftRow: GatewaySessionRow = {
      key: sessionKey,
      kind: "direct",
      updatedAt: null,
      ...(selectedTarget
        ? { model: selectedTarget.model, modelProvider: selectedTarget.provider ?? undefined }
        : {}),
      ...(this.thinkingLevel ? { thinkingLevel: this.thinkingLevel } : {}),
    };
    const thinkingDefaults = {
      ...sourceResult?.defaults,
      modelProvider: defaultTarget?.provider ?? sourceResult?.defaults.modelProvider ?? null,
      model: defaultTarget?.model ?? sourceResult?.defaults.model ?? null,
      contextTokens: sourceResult?.defaults.contextTokens ?? null,
      agentRuntime: options.agent?.agentRuntime ?? sourceResult?.defaults.agentRuntime,
      thinkingLevels: options.agent?.thinkingLevels ?? sourceResult?.defaults.thinkingLevels,
      thinkingOptions: options.agent?.thinkingOptions ?? sourceResult?.defaults.thinkingOptions,
      thinkingDefault: options.agent?.thinkingDefault ?? sourceResult?.defaults.thinkingDefault,
    };
    return renderChatModelControls({
      activeRunId: null,
      agentDefaultModel,
      connected: snapshot?.phase === "connected",
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelOverrides: { [sessionKey]: this.selected },
      modelSwitching: false,
      modelsLoading: this.catalogTask.status === TaskStatus.PENDING,
      sending: options.sending,
      sessionKey,
      sessionsResult: sourceResult,
      showFastMode: false,
      stream: null,
      thinkingDefaults,
      thinkingSession: draftRow,
      onModelSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.selected = value;
        const target = resolveDraftModelTarget(
          value || agentDefaultModel || sourceResult?.defaults.model,
          value || agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
          this.catalog,
        );
        if (target?.entry?.reasoning === false) {
          this.thinkingLevel = "";
        }
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onThinkingSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.thinkingLevel = value;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onRequestUpdate: this.notify,
    });
  }
}
