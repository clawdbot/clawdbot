import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/selection.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { parseConfiguredModelVisibilityEntries } from "../../agents/model-selection-shared.js";
import {
  buildConfiguredModelCatalog,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolvePersistedOverrideModelRef,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-codex-routing.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { ThinkLevel } from "./directives.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
import {
  isStaleHeartbeatAutoFallbackOverride,
  resolveStoredModelOverride,
} from "./stored-model-override.js";

type ModelCatalog = ModelCatalogEntry[];

type ModelSelectionState = {
  provider: string;
  model: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  resetModelOverride: boolean;
  resetModelOverrideRef?: string;
  resolveThinkingCatalog: () => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel>;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: () => Promise<"on" | "off">;
  needsModelCatalog: boolean;
};

export function createFastTestModelSelectionState(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): ModelSelectionState {
  return {
    provider: params.provider,
    model: params.model,
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resetModelOverrideRef: undefined,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
}

function shouldLogModelSelectionTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

const modelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/model-catalog.runtime.js"),
);
const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);

function loadModelCatalogRuntime() {
  return modelCatalogRuntimeLoader.load();
}

function loadSessionStoreRuntime() {
  return sessionStoreRuntimeLoader.load();
}

export async function createModelSelectionState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
  isHeartbeat?: boolean;
}): Promise<ModelSelectionState> {
  const timingEnabled = shouldLogModelSelectionTiming();
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    console.log(
      `[model-selection] session=${params.sessionKey ?? "(no-session)"} stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`,
    );
  };
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    storePath,
    defaultProvider,
    defaultModel,
  } = params;

  let provider = params.provider;
  let model = params.model;
  const primaryProvider = params.primaryProvider ?? defaultProvider;
  const primaryModel = params.primaryModel ?? defaultModel;

  const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const visibility = parseConfiguredModelVisibilityEntries({ cfg });
  const defaultProviderVisibleByWildcard = visibility.providerWildcards.has(
    normalizeProviderId(defaultProvider),
  );
  const configuredModelCatalog = buildConfiguredModelCatalog({ cfg });
  const needsModelCatalog =
    params.hasModelDirective ||
    Boolean(
      hasAllowlist && visibility.providerWildcards.size > 0 && !defaultProviderVisibleByWildcard,
    );

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog: configuredModelCatalog,
    defaultProvider,
    defaultModel,
    agentId: params.agentId,
  });
  let modelCatalog: ModelCatalog | null = null;
  let resetModelOverride = false;
  let resetModelOverrideRef: string | undefined;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;
  const directStoredOverride = resolvePersistedOverrideModelRef({
    defaultProvider,
    overrideProvider: sessionEntry?.providerOverride,
    overrideModel: sessionEntry?.modelOverride,
  });
  const directStoredModelOverride = directStoredOverride
    ? { ...directStoredOverride, source: "session" as const }
    : null;
  const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
    isHeartbeat: params.isHeartbeat,
    hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
    sessionEntry,
    storedOverride: directStoredModelOverride,
    defaultProvider,
    defaultModel,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
  });

  if (needsModelCatalog) {
    modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
    logStage("catalog-loaded", `entries=${modelCatalog.length}`);
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist) {
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: configuredModelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (configuredModelCatalog.length > 0) {
    logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
  }

  if (sessionEntry && sessionStore && sessionKey && directStoredOverride) {
    const normalizedOverride = normalizeModelRef(
      directStoredOverride.provider,
      directStoredOverride.model,
    );
    const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
    if (staleHeartbeatAutoFallbackOverride || !visibilityPolicy.allowsKey(key)) {
      const { updated } = applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: { provider: primaryProvider, model: primaryModel, isDefault: true },
        preserveAuthProfileOverride: staleHeartbeatAutoFallbackOverride,
      });
      if (updated) {
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await (
            await loadSessionStoreRuntime()
          ).updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
          });
        }
      }
      resetModelOverride = updated;
      if (updated) {
        resetModelOverrideRef = key;
      }
    }
  }
  if (staleHeartbeatAutoFallbackOverride) {
    const normalizedCurrentSelection = normalizeModelRef(provider, model);
    const currentSelectionKey = modelKey(
      normalizedCurrentSelection.provider,
      normalizedCurrentSelection.model,
    );
    const normalizedDirectOverride = directStoredOverride
      ? normalizeModelRef(directStoredOverride.provider, directStoredOverride.model)
      : null;
    const directStoredOverrideKey = normalizedDirectOverride
      ? modelKey(normalizedDirectOverride.provider, normalizedDirectOverride.model)
      : undefined;
    if (currentSelectionKey === directStoredOverrideKey) {
      provider = primaryProvider;
      model = primaryModel;
    }
  }

  const storedOverride = resolveStoredModelOverride({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey,
    defaultProvider,
  });
  // Skip stored session model override only when an explicit heartbeat.model
  // was resolved. Heartbeats without heartbeat.model still inherit normal
  // overrides unless a direct auto fallback override is stale for the current
  // configured default.
  const skipStoredOverride =
    params.hasResolvedHeartbeatModelOverride === true ||
    (staleHeartbeatAutoFallbackOverride && storedOverride?.source === "session");

  if (storedOverride?.model && !skipStoredOverride) {
    const normalizedStoredOverride = normalizeModelRef(
      storedOverride.provider || defaultProvider,
      storedOverride.model,
    );
    const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
    if (visibilityPolicy.allowsKey(key)) {
      provider = normalizedStoredOverride.provider;
      model = normalizedStoredOverride.model;
    }
  }

  if (!params.hasModelDirective) {
    const allowedInitialSelection = visibilityPolicy.resolveSelection({
      provider,
      model,
    });
    if (!allowedInitialSelection) {
      throw new Error(
        `Configured default model "${modelKey(provider, model)}" is not allowed by agents.defaults.models, and no allowed model is available.`,
      );
    }
    provider = allowedInitialSelection.provider;
    model = allowedInitialSelection.model;
  }

  if (sessionEntry && sessionStore && sessionKey && sessionEntry.authProfileOverride) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const profileProvider = profile ? normalizeProviderId(profile.provider) : undefined;
    const harnessPolicy = resolveAgentHarnessPolicy({
      provider,
      modelId: model,
      config: cfg,
      agentId: params.agentId,
      sessionKey,
    });
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider,
      harnessRuntime: harnessPolicy.runtime,
    }).map(normalizeProviderId);
    if (!profile || !acceptedAuthProviders.includes(profileProvider ?? "")) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  let thinkingCatalog: ModelCatalog | undefined;
  const resolveThinkingCatalog = async () => {
    if (thinkingCatalog) {
      return thinkingCatalog;
    }
    let catalogForThinking =
      modelCatalog && modelCatalog.length > 0 ? modelCatalog : allowedModelCatalog;
    const selectedCatalogEntry = catalogForThinking?.find(
      (entry) => entry.provider === provider && entry.id === model,
    );
    const shouldHydrateRuntimeCatalog =
      !modelCatalog && (!selectedCatalogEntry || selectedCatalogEntry.reasoning === undefined);
    if (shouldHydrateRuntimeCatalog) {
      modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
      logStage("catalog-loaded-for-thinking", `entries=${modelCatalog.length}`);
      const runtimeSelectedEntry = modelCatalog.find(
        (entry) => entry.provider === provider && entry.id === model,
      );
      catalogForThinking =
        runtimeSelectedEntry || !catalogForThinking || catalogForThinking.length === 0
          ? modelCatalog.length > 0
            ? modelCatalog
            : allowedModelCatalog
          : allowedModelCatalog;
    }
    thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
    return thinkingCatalog;
  };

  let defaultThinkingLevel: ThinkLevel | undefined;
  const resolveDefaultThinkingLevel = async () => {
    if (defaultThinkingLevel) {
      return defaultThinkingLevel;
    }
    const agentThinkingDefault = agentEntry?.thinkingDefault as ThinkLevel | undefined;
    const configuredThinkingDefault = agentCfg?.thinkingDefault as ThinkLevel | undefined;
    const explicitThinkingDefault = agentThinkingDefault ?? configuredThinkingDefault;
    if (explicitThinkingDefault) {
      defaultThinkingLevel = explicitThinkingDefault;
      return defaultThinkingLevel;
    }
    const catalogForThinking = await resolveThinkingCatalog();
    const resolved = resolveThinkingDefault({
      cfg,
      provider,
      model,
      catalog: catalogForThinking,
    });
    defaultThinkingLevel = resolved ?? "off";
    return defaultThinkingLevel;
  };

  const resolveDefaultReasoningLevel = async (): Promise<"on" | "off"> => {
    let catalogForReasoning = modelCatalog ?? allowedModelCatalog;
    if (!catalogForReasoning || catalogForReasoning.length === 0) {
      modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
      logStage("catalog-loaded-for-reasoning", `entries=${modelCatalog.length}`);
      catalogForReasoning = modelCatalog;
    }
    return resolveReasoningDefault({
      provider,
      model,
      catalog: catalogForReasoning,
    });
  };

  return {
    provider,
    model,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    resetModelOverrideRef,
    resolveThinkingCatalog,
    resolveDefaultThinkingLevel,
    resolveDefaultReasoningLevel,
    needsModelCatalog,
  };
}

export function resolveContextTokens(params: {
  cfg: OpenClawConfig;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): number {
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    allowAsyncLoad: false,
  });
  const agentContextTokens =
    typeof params.agentCfg?.contextTokens === "number" && params.agentCfg.contextTokens > 0
      ? Math.floor(params.agentCfg.contextTokens)
      : undefined;

  if (agentContextTokens !== undefined) {
    return modelContextTokens !== undefined
      ? Math.min(agentContextTokens, modelContextTokens)
      : agentContextTokens;
  }

  return modelContextTokens ?? DEFAULT_CONTEXT_TOKENS;
}
