import type { GatewayAgentRow, GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelControls } from "../chat/components/chat-model-controls.ts";

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
  private requestToken = 0;
  private catalog: ModelCatalogEntry[] = [];
  private loading = false;
  selected = "";
  thinkingLevel = "";

  constructor(private readonly notify: () => void) {}

  invalidate(resetSelection = false) {
    this.requestToken += 1;
    this.loading = false;
    this.catalog = [];
    if (resetSelection) {
      this.selected = "";
      this.thinkingLevel = "";
    }
  }

  reset() {
    this.invalidate(true);
    this.notify();
  }

  load(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = normalizeAgentId(agentId);
    const requestId = ++this.requestToken;
    this.catalog = [];
    if (snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.loading = false;
      this.notify();
      return;
    }
    this.loading = true;
    this.notify();
    void client
      .request<{ models?: ModelCatalogEntry[] }>("chat.metadata", {
        agentId: normalizedAgentId,
      })
      .then((result) => {
        if (requestId === this.requestToken) {
          this.catalog = Array.isArray(result.models) ? result.models : [];
        }
      })
      .catch(() => {
        if (requestId === this.requestToken) {
          this.catalog = [];
        }
      })
      .finally(() => {
        if (requestId === this.requestToken) {
          this.loading = false;
          this.notify();
        }
      });
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
      modelsLoading: this.loading,
      sending: options.sending,
      sessionKey,
      sessionsResult: sourceResult,
      showFastMode: false,
      stream: null,
      thinkingDefaults,
      thinkingSession: draftRow,
      onModelSelect: (value) => {
        this.selected = value;
        const target = resolveDraftModelTarget(
          value || agentDefaultModel || sourceResult?.defaults.model,
          value || agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
          this.catalog,
        );
        if (target?.entry?.reasoning === false) {
          this.thinkingLevel = "";
        }
      },
      onThinkingSelect: (value) => {
        this.thinkingLevel = value;
      },
      onRequestUpdate: this.notify,
    });
  }
}
