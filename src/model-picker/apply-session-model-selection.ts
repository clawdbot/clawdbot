import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { modelKey, normalizeProviderId } from "../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../agents/openai-routing.js";
import {
  resolveCompatibleAgentRuntimeForProvider,
  resolveSessionRuntimeOverrideForProvider,
} from "../agents/session-runtime-compat.js";
import { persistStickyModelSelectionBestEffort } from "../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { applyModelRuntimeDirective } from "../auto-reply/reply/directive-handling.model-runtime.js";
import { resolveContextTokens } from "../auto-reply/reply/model-selection-context.js";
import { refreshQueuedFollowupSession } from "../auto-reply/reply/queue.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { isThinkingLevelSupported, resolveSupportedThinkingLevel } from "../auto-reply/thinking.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import {
  adoptPersistedSessionSnapshot,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
} from "../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";

export type SessionModelSelectionRequest = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
  profileOverride?: string;
  runtime: { kind: "unchanged" } | { kind: "clear" } | { kind: "set"; runtime: string };
};

export type ApplySessionModelSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  allowedModelKeys: ReadonlySet<string>;
  modelCatalog: readonly ModelCatalogEntry[];
  thinkingCatalog?: readonly ModelCatalogEntry[];
  canPersistStickyModelSelection?: boolean;
  request: SessionModelSelectionRequest;
  /** Raw directive text used only by the existing session patch hook. */
  patchModel?: string;
  markLiveSwitchPending: true;
};

export type ApplySessionModelSelectionResult =
  | {
      status: "applied";
      provider: string;
      model: string;
      effectiveModelRef: string;
      changed: boolean;
      contextTokens: number;
      runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
      thinkingRemap?: {
        from: ThinkLevel;
        to: ThinkLevel;
        provider: string;
        model: string;
      };
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "invalid-runtime";
      message: string;
    }
  | { status: "conflict"; message: string };

type AppliedRuntimeDirective =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; runtime: string };

type ApplySessionModelSelectionToEntryResult = {
  changed: boolean;
  runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
};

/** Applies the model transaction field family to one caller-owned snapshot. */
function applySessionModelSelectionToEntry(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: SessionEntry;
  currentProvider: string;
  request: SessionModelSelectionRequest;
  runtime: AppliedRuntimeDirective;
  markLiveSwitchPending?: boolean;
}): ApplySessionModelSelectionToEntryResult {
  const modelChange = applyModelOverrideWithAuthProfileCompatibility({
    cfg: params.cfg,
    agentDir: params.agentDir,
    entry: params.entry,
    currentProvider: params.currentProvider,
    selection: params.request,
    profileOverride: params.request.profileOverride,
    markLiveSwitchPending: params.markLiveSwitchPending,
  });
  const runtimeChange = applyModelRuntimeDirective(params.entry, params.runtime);
  return {
    changed: modelChange.updated || runtimeChange.updated,
    ...(params.runtime.kind === "clear" || params.runtime.kind === "set"
      ? { runtimeChange: params.runtime }
      : {}),
  };
}

function resolveRuntimeDirective(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  provider: string;
  request: SessionModelSelectionRequest["runtime"];
}): AppliedRuntimeDirective | { kind: "invalid"; message: string } {
  if (params.request.kind === "unchanged") {
    const persistedRuntime = params.entry.agentRuntimeOverride?.trim();
    if (
      persistedRuntime &&
      !resolveSessionRuntimeOverrideForProvider({
        provider: params.provider,
        entry: params.entry,
        cfg: params.cfg,
      })
    ) {
      return { kind: "clear" };
    }
    return params.request;
  }
  if (params.request.kind === "clear") {
    return params.request;
  }
  const runtime = normalizeOptionalAgentRuntimeId(params.request.runtime);
  if (isDefaultAgentRuntimeId(runtime)) {
    return { kind: "clear" };
  }
  const provider = normalizeProviderId(params.provider);
  const compatibleRuntime = resolveCompatibleAgentRuntimeForProvider({
    provider,
    runtime,
    cfg: params.cfg,
  });
  return compatibleRuntime
    ? { kind: "set", runtime: compatibleRuntime }
    : {
        kind: "invalid",
        message: `Runtime "${params.request.runtime}" is not supported for ${provider || params.provider}.`,
      };
}

function formatModelSwitchEvent(provider: string, model: string, alias?: string): string {
  const label = `${provider}/${model}`;
  return alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
}

function rejectNotAllowed(provider: string, model: string): ApplySessionModelSelectionResult {
  return {
    status: "rejected",
    reason: "not-allowed",
    message: `Model ${provider}/${model} is not available for this agent.`,
  };
}

/** Applies one validated picker selection to the authoritative live session. */
export async function applySessionModelSelection(
  params: ApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  const startingEntry = params.storePath
    ? params.sessionEntry
    : (params.sessionStore[params.sessionKey] ?? params.sessionEntry);
  if (isModelSelectionLocked(startingEntry)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }

  const normalizedModelKey = modelKey(params.request.provider, params.request.model);
  if (
    (params.allowedModelKeys.size > 0 && !params.allowedModelKeys.has(normalizedModelKey)) ||
    !params.modelCatalog.some((entry) => modelKey(entry.provider, entry.id) === normalizedModelKey)
  ) {
    return rejectNotAllowed(params.request.provider, params.request.model);
  }
  const request: SessionModelSelectionRequest = {
    ...params.request,
    isDefault: normalizedModelKey === modelKey(params.defaultProvider, params.defaultModel),
  };

  const runtime = resolveRuntimeDirective({
    cfg: params.cfg,
    entry: startingEntry,
    provider: request.provider,
    request: request.runtime,
  });
  if (runtime.kind === "invalid") {
    return { status: "rejected", reason: "invalid-runtime", message: runtime.message };
  }

  const initialEntry = { ...startingEntry };
  const nextEntry = { ...startingEntry };
  const applied = applySessionModelSelectionToEntry({
    cfg: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    entry: nextEntry,
    currentProvider: params.currentProvider,
    request,
    runtime,
    markLiveSwitchPending: params.markLiveSwitchPending,
  });
  const thinkingCatalog = params.thinkingCatalog ?? params.modelCatalog;
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: request.provider,
    modelId: request.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: nextEntry,
  });
  const currentThinkingLevel = nextEntry.thinkingLevel as ThinkLevel | undefined;
  let thinkingRemap: Extract<
    ApplySessionModelSelectionResult,
    { status: "applied" }
  >["thinkingRemap"];
  if (
    currentThinkingLevel &&
    !isThinkingLevelSupported({
      provider: request.provider,
      model: request.model,
      level: currentThinkingLevel,
      catalog: [...thinkingCatalog],
      agentRuntime: thinkingRuntime,
    })
  ) {
    const remapped = resolveSupportedThinkingLevel({
      provider: request.provider,
      model: request.model,
      level: currentThinkingLevel,
      catalog: [...thinkingCatalog],
      agentRuntime: thinkingRuntime,
    });
    if (remapped !== currentThinkingLevel) {
      nextEntry.thinkingLevel = remapped;
      thinkingRemap = {
        from: currentThinkingLevel,
        to: remapped,
        provider: request.provider,
        model: request.model,
      };
    }
  }

  // An explicit selection retains the existing persistence and conflict semantics even when idempotent.
  nextEntry.updatedAt = Date.now();
  let persistedEntry: SessionEntry;
  if (params.storePath) {
    const persistence = await persistReplySessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      initialEntry,
      entry: nextEntry,
      reassertLiveModelSwitchPending: applied.changed && nextEntry.liveModelSwitchPending === true,
      requireModelSelectionUnlocked: true,
      touchedFields: SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
    });
    if (persistence.entry) {
      params.sessionStore[params.sessionKey] = persistence.entry;
      adoptPersistedSessionSnapshot(params.sessionEntry, persistence.entry);
    }
    if (persistence.status === "model-selection-locked") {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    if (
      persistence.status !== "current" ||
      !sessionModelOverrideChangesApplied({
        initial: initialEntry,
        next: nextEntry,
        current: persistence.entry,
        reassertLiveModelSwitchPending:
          applied.changed && nextEntry.liveModelSwitchPending === true,
      })
    ) {
      return {
        status: "conflict",
        message: "Model change was not applied because the session changed. Retry.",
      };
    }
    persistedEntry = persistence.entry;
  } else {
    adoptPersistedSessionSnapshot(params.sessionEntry, nextEntry);
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    persistedEntry = params.sessionEntry;
  }

  const provider = request.provider;
  const model = request.model;
  const effectiveModelRef = `${provider}/${model}`;
  const changed = applied.changed || thinkingRemap !== undefined;
  if (params.canPersistStickyModelSelection === true && !request.isDefault) {
    persistStickyModelSelectionBestEffort({ agentId: params.agentId, model: effectiveModelRef });
  }
  if (changed) {
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: persistedEntry,
      sessionKey: params.sessionKey,
      patch: { key: params.sessionKey, model: params.patchModel ?? effectiveModelRef },
    });
    refreshQueuedFollowupSession({
      key: params.sessionKey,
      nextProvider: provider,
      nextModel: model,
      nextRouteResolution: "resolved",
      nextModelOverrideSource: "user",
      nextAuthProfileId: persistedEntry.authProfileOverride,
      nextAuthProfileIdSource: persistedEntry.authProfileOverrideSource,
      nextThinking: {
        level: persistedEntry.thinkingLevel,
        catalog: [...thinkingCatalog],
        agentRuntime: resolveEffectiveAgentRuntime({
          cfg: params.cfg,
          provider,
          modelId: model,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionEntry: persistedEntry,
        }),
      },
    });
  }

  if (`${params.currentProvider}/${params.currentModel}` !== effectiveModelRef) {
    enqueueSystemEvent(formatModelSwitchEvent(provider, model, request.alias), {
      sessionKey: params.sessionKey,
      contextKey: `model:${effectiveModelRef}`,
    });
  }

  const selectedCatalogEntry = params.modelCatalog.find(
    (entry) => modelKey(entry.provider, entry.id) === normalizedModelKey,
  );
  const contextProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider,
      modelId: model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: persistedEntry,
    }),
    config: params.cfg,
  });
  return {
    status: "applied",
    provider,
    model,
    effectiveModelRef,
    changed,
    contextTokens: resolveContextTokens({
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      provider: contextProvider,
      model,
      modelContextWindow: selectedCatalogEntry?.contextWindow,
      modelContextTokens: selectedCatalogEntry?.contextTokens,
    }),
    ...(applied.runtimeChange ? { runtimeChange: applied.runtimeChange } : {}),
    ...(thinkingRemap ? { thinkingRemap } : {}),
  };
}
