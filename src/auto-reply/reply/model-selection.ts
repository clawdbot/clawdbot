/** Model selection state for reply runs, including catalog and override handling. */
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../../agents/auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import {
  type ModelAliasIndex,
  buildConfiguredModelCatalog,
  legacyModelKey,
  modelKey,
  normalizeProviderId,
  resolveModelAliasFromPair,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
} from "../../agents/openai-routing.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  adoptPersistedSessionSnapshot,
  sessionModelOverrideChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeThinkLevel, type ThinkLevel } from "../thinking.shared.js";
import { normalizeRuntimeRef, resolveRuntimeNormalization } from "./model-runtime-normalization.js";
import {
  isStaleHeartbeatAutoFallbackOverride,
  normalizeStoredRuntimeModelRef,
  resolveDirectStoredModelOverride,
  resolveStoredModelOverride,
} from "./stored-model-override.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
export { resolveContextTokens } from "./model-selection-context.js";

type ModelCatalog = ModelCatalogEntry[];

type ThinkingDefaultSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
};

type ModelSelectionState = {
  provider: string;
  model: string;
  requestedRouteResolution: ModelFallbackRouteResolution;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  policyAliasIndex: ModelAliasIndex;
  resetModelOverride: boolean;
  resetModelOverrideRef?: string;
  resetModelOverrideReason?: "disallowed" | "stale" | "temporarily-unavailable";
  modelPolicyConfigPath?: string;
  modelPolicyRepairConfigPath?: string;
  resolveThinkingCatalog: () => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: (selection?: ThinkingDefaultSelection) => Promise<ThinkLevel>;
  hasConfiguredThinkingDefault?: boolean;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: () => Promise<"on" | "off">;
  needsModelCatalog: boolean;
  modelContextWindow?: number;
  modelContextTokens?: number;
};

function resolveConfiguredModelThinkingDefault(raw: unknown): ThinkLevel | undefined {
  if (raw === false || raw === "disabled" || raw === "none") {
    return "off";
  }
  return typeof raw === "string" ? normalizeThinkLevel(raw) : undefined;
}

/** Creates minimal model-selection state for fast test mode. */
export function createFastTestModelSelectionState(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): ModelSelectionState {
  return {
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    policyAliasIndex: { byAlias: new Map(), byKey: new Map() },
    resetModelOverride: false,
    resetModelOverrideRef: undefined,
    resetModelOverrideReason: undefined,
    modelPolicyConfigPath: undefined,
    modelPolicyRepairConfigPath: undefined,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    hasConfiguredThinkingDefault: params.agentCfg?.thinkingDefault !== undefined,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
    modelContextWindow: undefined,
    modelContextTokens: undefined,
  };
}

const modelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/model-catalog.runtime.js"),
);
const sessionPersistenceRuntimeLoader = createLazyImportLoader(
  () => import("./session-entry-persistence.js"),
);

function loadPreparedModelCatalogRuntime() {
  return modelCatalogRuntimeLoader.load();
}

function loadSessionPersistenceRuntime() {
  return sessionPersistenceRuntimeLoader.load();
}

function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const selectedKey = modelKey(normalizedProvider, params.model);
  return params.catalog?.find((entry) => modelKey(entry.provider, entry.id) === selectedKey);
}

/** Resolves provider/model, allowlist, catalog, and thinking defaults for a reply run. */
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
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
  isHeartbeat?: boolean;
  preparedModelCatalog?: ModelCatalogSnapshot;
}): Promise<ModelSelectionState> {
  const timingEnabled = isDiagnosticFlagEnabled("ingress.timing", params.cfg);
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
  const catalogAgentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const catalogScope = {
    config: cfg,
    agentId: catalogAgentId,
    agentDir: resolveAgentDir(cfg, catalogAgentId),
  };
  const loadRuntimeCatalogSnapshot = async (): Promise<ModelCatalogSnapshot> =>
    params.preparedModelCatalog ??
    (await (
      await loadPreparedModelCatalogRuntime()
    ).loadPreparedModelCatalogSnapshot(catalogScope));
  const runtimeModelNormalization = resolveRuntimeNormalization(cfg);
  const { manifestPlugins } = runtimeModelNormalization;

  let provider = params.provider;
  let model = params.model;
  let requestedRouteResolution: ModelFallbackRouteResolution = "resolved";
  const primaryProvider = params.primaryProvider ?? defaultProvider;
  const primaryModel = params.primaryModel ?? defaultModel;
  const hasOneTurnModelOverride = params.hasOneTurnModelOverride === true;
  const modelSelectionLocked = sessionEntry?.modelSelectionLocked === true;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;

  let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog: [],
    defaultProvider,
    defaultModel,
    agentId: params.agentId,
    ...runtimeModelNormalization,
  });
  const hasAllowlist = !visibilityPolicy.allowAny;
  const hasConfiguredModels =
    Object.keys(agentCfg?.models ?? {}).length > 0 ||
    Object.keys(agentEntry?.models ?? {}).length > 0;
  const defaultModelVisibleByWildcard = visibilityPolicy.allowsByWildcard({
    provider: defaultProvider,
    model: defaultModel,
  });
  const configuredModelCatalog = buildConfiguredModelCatalog({ cfg, manifestPlugins });
  const needsModelCatalog =
    params.hasModelDirective ||
    (hasAllowlist && visibilityPolicy.hasProviderWildcards && !defaultModelVisibleByWildcard);

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  // Whether the loaded catalog is a complete/live snapshot. A degraded catalog
  // (discovery threw, static/empty fallback) must not destroy a pinned override.
  let catalogAuthoritative = true;
  let resetModelOverride = false;
  let resetModelOverrideRef: string | undefined;
  let resetModelOverrideReason: "disallowed" | "stale" | "temporarily-unavailable" | undefined;
  const directStoredModelOverride = resolveDirectStoredModelOverride({
    sessionEntry,
    defaultProvider,
  });
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
  const primaryHarnessPolicy = resolveAgentHarnessPolicy({
    provider: primaryProvider,
    modelId: primaryModel,
    config: cfg,
    agentId: params.agentId,
    sessionKey,
  });
  const staleLegacyOpenAICodexAutoOverride =
    directStoredModelOverride?.source === "session" &&
    sessionEntry?.modelOverrideSource === "auto" &&
    normalizeProviderId(directStoredModelOverride.provider ?? "") === OPENAI_CODEX_PROVIDER_ID &&
    normalizeProviderId(primaryProvider) === OPENAI_PROVIDER_ID &&
    primaryHarnessPolicy.runtime === "codex" &&
    normalizeRuntimeRef(
      OPENAI_PROVIDER_ID,
      directStoredModelOverride.model,
      runtimeModelNormalization,
    ).model ===
      normalizeRuntimeRef(OPENAI_PROVIDER_ID, primaryModel, runtimeModelNormalization).model;
  const normalizedCurrentSelection = normalizeRuntimeRef(
    provider,
    model,
    runtimeModelNormalization,
  );
  const normalizedDirectOverride = directStoredModelOverride
    ? normalizeRuntimeRef(
        directStoredModelOverride.provider ?? defaultProvider,
        directStoredModelOverride.model,
        runtimeModelNormalization,
      )
    : null;
  // A current selection equal to the stored legacy pin deliberately reapplies it; clearing then
  // would fight an explicit override, so only treat differing selections as stale.
  const staleLegacyAutoFallbackWithoutOrigin =
    directStoredModelOverride?.source === "session" &&
    hasLegacyAutoFallbackWithoutOrigin(sessionEntry) &&
    normalizedDirectOverride !== null &&
    modelKey(normalizedCurrentSelection.provider, normalizedCurrentSelection.model) !==
      modelKey(normalizedDirectOverride.provider, normalizedDirectOverride.model);
  const staleDirectStoredOverride =
    staleHeartbeatAutoFallbackOverride ||
    staleLegacyOpenAICodexAutoOverride ||
    staleLegacyAutoFallbackWithoutOrigin;

  if (needsModelCatalog) {
    const catalogSnapshot = await loadRuntimeCatalogSnapshot();
    modelCatalog = catalogSnapshot.entries;
    // Only an explicit false is degraded; absent means authoritative.
    catalogAuthoritative = catalogSnapshot.authoritative !== false;
    logStage(
      "catalog-loaded",
      `entries=${modelCatalog.length} authoritative=${catalogAuthoritative}`,
    );
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
      ...runtimeModelNormalization,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist || hasConfiguredModels) {
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: configuredModelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
      ...runtimeModelNormalization,
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

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    directStoredModelOverride &&
    !hasOneTurnModelOverride
  ) {
    const normalizedOverride = normalizeStoredRuntimeModelRef(
      directStoredModelOverride.provider ?? defaultProvider,
      directStoredModelOverride.model,
      cfg,
      sessionEntry,
      runtimeModelNormalization,
    );
    const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
    const overrideAllowed = visibilityPolicy.allowsKey(key);
    // A degraded catalog cannot prove a pin is disallowed. Preserve it while the turn falls back
    // to primary, then re-evaluate after discovery recovers; config-proven stale pins still reset.
    const shouldResetOverride =
      (staleDirectStoredOverride || !overrideAllowed) && !modelSelectionLocked;
    const overrideTemporarilyUnavailable =
      shouldResetOverride && !staleDirectStoredOverride && !catalogAuthoritative;
    if (overrideTemporarilyUnavailable) {
      resetModelOverrideRef = key;
      resetModelOverrideReason = "temporarily-unavailable";
    } else if (shouldResetOverride) {
      const initialSessionEntry = { ...sessionEntry };
      const nextSessionEntry = { ...sessionEntry };
      const { updated } = applyModelOverrideToSessionEntry({
        entry: nextSessionEntry,
        selection: { provider: primaryProvider, model: primaryModel, isDefault: true },
        preserveAuthProfileOverride: staleDirectStoredOverride,
      });
      let resetApplied = updated;
      if (updated) {
        if (storePath) {
          const { persistReplySessionEntry } = await loadSessionPersistenceRuntime();
          const persistence = await persistReplySessionEntry({
            storePath,
            sessionKey,
            initialEntry: initialSessionEntry,
            entry: nextSessionEntry,
          });
          if (persistence.status === "lifecycle-invalidated") {
            throw new SessionWorkStartInvalidatedError(persistence.error);
          }
          const persistedEntry = persistence.entry;
          resetApplied = sessionModelOverrideChangesApplied({
            initial: initialSessionEntry,
            next: nextSessionEntry,
            current: persistedEntry,
          });
          adoptPersistedSessionSnapshot(sessionEntry, persistedEntry);
        } else {
          adoptPersistedSessionSnapshot(sessionEntry, nextSessionEntry);
        }
        sessionStore[sessionKey] = sessionEntry;
      }
      resetModelOverride = resetApplied;
      if (resetApplied) {
        resetModelOverrideRef = key;
        resetModelOverrideReason = staleDirectStoredOverride ? "stale" : "disallowed";
      }
    }
  }
  if (staleDirectStoredOverride) {
    const currentSelectionKey = modelKey(
      normalizedCurrentSelection.provider,
      normalizedCurrentSelection.model,
    );
    const directStoredOverrideKey = normalizedDirectOverride
      ? modelKey(normalizedDirectOverride.provider, normalizedDirectOverride.model)
      : undefined;
    if (currentSelectionKey === directStoredOverrideKey) {
      provider = primaryProvider;
      model = primaryModel;
      requestedRouteResolution = "resolved";
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
    params.skipStoredModelOverride === true ||
    hasOneTurnModelOverride ||
    params.hasResolvedHeartbeatModelOverride === true ||
    (resetModelOverride && staleDirectStoredOverride && storedOverride?.source === "session");

  if (storedOverride?.model && !skipStoredOverride) {
    const storedProvider = storedOverride.provider || defaultProvider;
    const storedRouteCataloged = Boolean(
      findSelectedCatalogEntry({
        catalog: modelCatalog ?? allowedModelCatalog,
        provider: storedProvider,
        model: storedOverride.model,
      }),
    );
    const storedAlias =
      storedOverride.routeResolution === "raw" && !storedRouteCataloged
        ? resolveModelAliasFromPair({
            cfg,
            provider: storedProvider,
            model: storedOverride.model,
            defaultProvider,
            aliasIndex: visibilityPolicy.selectionAliasIndex,
            ...runtimeModelNormalization,
          })
        : null;
    const normalizedStoredOverride = normalizeStoredRuntimeModelRef(
      storedAlias?.provider ?? storedProvider,
      storedAlias?.model ?? storedOverride.model,
      cfg,
      sessionEntry,
      runtimeModelNormalization,
    );
    const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
    if (modelSelectionLocked || visibilityPolicy.allowsKey(key)) {
      provider = normalizedStoredOverride.provider;
      model = normalizedStoredOverride.model;
      requestedRouteResolution =
        storedAlias || storedRouteCataloged ? "resolved" : storedOverride.routeResolution;
    }
  }

  const skipResolveSelection =
    params.hasModelDirective || hasOneTurnModelOverride || modelSelectionLocked;
  if (!skipResolveSelection) {
    const unresolvedSelectionKey = modelKey(provider, model);
    const allowedInitialSelection = visibilityPolicy.resolveSelection({
      provider,
      model,
    });
    if (!allowedInitialSelection) {
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      throw new Error(
        `Configured default model "${modelKey(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
      );
    }
    provider = allowedInitialSelection.provider;
    model = allowedInitialSelection.model;
    if (modelKey(provider, model) !== unresolvedSelectionKey) {
      requestedRouteResolution = "resolved";
    }
  }

  if (
    !params.skipStoredModelOverride &&
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride
  ) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
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
      config: cfg,
    }).map(normalizeProviderId);
    // Alias-aware eligibility: a stored credential can be valid for the run
    // provider through provider-auth aliases (e.g. an `anthropic` credential
    // serving a `claude-cli` run). A raw provider-string compare wrongly
    // cleared such overrides, which then let auto-selection re-pick a
    // different profile on a later turn — flapping the CLI session's auth
    // profile and invalidating it. Mirror session-override.ts's check.
    const overrideStillEligible =
      profile != null &&
      acceptedAuthProviders.some((accepted) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg,
          provider: accepted,
          credential: profile,
        }),
      );
    if (!overrideStillEligible) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  let thinkingCatalog: ModelCatalog | undefined;
  let manifestModelCatalog: ModelCatalog | null = null;
  const buildThinkingCatalog = (catalog: ModelCatalog): ModelCatalog =>
    createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
      ...runtimeModelNormalization,
    }).allowedCatalog;
  const loadManifestCatalog = async () => {
    if (manifestModelCatalog) {
      return manifestModelCatalog;
    }
    const { loadManifestModelCatalog } = await loadPreparedModelCatalogRuntime();
    manifestModelCatalog = loadManifestModelCatalog({
      config: cfg,
      fallbackToMetadataScan: false,
    });
    logStage("manifest-catalog-loaded", `entries=${manifestModelCatalog.length}`);
    return manifestModelCatalog;
  };
  const resolveThinkingCatalog = async () => {
    if (thinkingCatalog) {
      return thinkingCatalog;
    }
    let catalogForThinking =
      allowedModelCatalog.length > 0
        ? allowedModelCatalog
        : modelCatalog && modelCatalog.length > 0
          ? buildThinkingCatalog(modelCatalog)
          : [];
    let selectedCatalogEntry = findSelectedCatalogEntry({
      catalog: catalogForThinking,
      provider,
      model,
    });
    // Prefer static manifest rows before cold runtime discovery. Synthetic
    // allowlist rows know only provider/id; manifest rows can prove reasoning
    // support without opening the Pi auth-backed model registry.
    if (!modelCatalog && selectedCatalogEntry?.reasoning === undefined) {
      const manifestCatalog = buildThinkingCatalog(await loadManifestCatalog());
      const manifestSelectedEntry = findSelectedCatalogEntry({
        catalog: manifestCatalog,
        provider,
        model,
      });
      if (manifestSelectedEntry?.reasoning !== undefined) {
        catalogForThinking = manifestCatalog;
        selectedCatalogEntry = manifestSelectedEntry;
      }
    }
    const shouldHydrateRuntimeCatalog =
      !modelCatalog && (!selectedCatalogEntry || selectedCatalogEntry.reasoning === undefined);
    if (shouldHydrateRuntimeCatalog) {
      modelCatalog = (await loadRuntimeCatalogSnapshot()).entries;
      logStage("catalog-loaded-for-thinking", `entries=${modelCatalog.length}`);
      const runtimeCatalog = buildThinkingCatalog(modelCatalog);
      const runtimeSelectedEntry = findSelectedCatalogEntry({
        catalog: runtimeCatalog,
        provider,
        model,
      });
      catalogForThinking =
        runtimeSelectedEntry || !catalogForThinking || catalogForThinking.length === 0
          ? runtimeCatalog.length > 0
            ? runtimeCatalog
            : allowedModelCatalog
          : allowedModelCatalog;
    }
    thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
    return thinkingCatalog;
  };

  const defaultThinkingLevels = new Map<string, ThinkLevel>();
  const resolveDefaultThinkingLevel = async (selection?: ThinkingDefaultSelection) => {
    const selectedProvider = selection?.provider ?? provider;
    const selectedModel = selection?.model ?? model;
    const cacheKey = `${modelKey(selectedProvider, selectedModel)}\0${selection?.agentRuntime ?? ""}`;
    const cached = defaultThinkingLevels.get(cacheKey);
    if (cached) {
      return cached;
    }
    const agentThinkingDefault = agentEntry?.thinkingDefault as ThinkLevel | undefined;
    if (agentThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, agentThinkingDefault);
      return agentThinkingDefault;
    }
    const configuredModels = cfg.agents?.defaults?.models;
    const canonicalKey = modelKey(selectedProvider, selectedModel);
    const legacyKey = legacyModelKey(selectedProvider, selectedModel);
    const configuredModelThinkingDefault =
      configuredModels?.[canonicalKey]?.params?.thinking ??
      (legacyKey ? configuredModels?.[legacyKey]?.params?.thinking : undefined);
    const resolvedConfiguredModelThinkingDefault = resolveConfiguredModelThinkingDefault(
      configuredModelThinkingDefault,
    );
    if (resolvedConfiguredModelThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, resolvedConfiguredModelThinkingDefault);
      return resolvedConfiguredModelThinkingDefault;
    }
    const configuredThinkingDefault = agentCfg?.thinkingDefault as ThinkLevel | undefined;
    if (configuredThinkingDefault) {
      defaultThinkingLevels.set(cacheKey, configuredThinkingDefault);
      return configuredThinkingDefault;
    }
    const catalogForThinking = await resolveThinkingCatalog();
    const resolved = resolveThinkingDefault({
      cfg,
      provider: selectedProvider,
      model: selectedModel,
      catalog: catalogForThinking,
      agentRuntime: selection?.agentRuntime,
    });
    const defaultThinkingLevel = resolved ?? "off";
    defaultThinkingLevels.set(cacheKey, defaultThinkingLevel);
    return defaultThinkingLevel;
  };

  let defaultReasoningLevel: "on" | "off" | undefined;
  const resolveDefaultReasoningLevel = async (): Promise<"on" | "off"> => {
    if (defaultReasoningLevel) {
      return defaultReasoningLevel;
    }
    let catalogForReasoning = modelCatalog ?? allowedModelCatalog;
    let selectedReasoningEntry = findSelectedCatalogEntry({
      catalog: catalogForReasoning,
      provider,
      model,
    });
    if (!modelCatalog && selectedReasoningEntry?.reasoning === undefined) {
      const manifestCatalog = await loadManifestCatalog();
      const manifestReasoningCatalog =
        hasAllowlist || hasConfiguredModels
          ? buildThinkingCatalog(manifestCatalog)
          : manifestCatalog;
      const manifestSelectedEntry = findSelectedCatalogEntry({
        catalog: manifestReasoningCatalog,
        provider,
        model,
      });
      if (manifestSelectedEntry?.reasoning !== undefined) {
        catalogForReasoning = manifestReasoningCatalog;
        selectedReasoningEntry = manifestSelectedEntry;
      }
    }
    if (
      (!catalogForReasoning || catalogForReasoning.length === 0) &&
      selectedReasoningEntry?.reasoning === undefined
    ) {
      modelCatalog = (await loadRuntimeCatalogSnapshot()).entries;
      logStage("catalog-loaded-for-reasoning", `entries=${modelCatalog.length}`);
      catalogForReasoning = modelCatalog;
    }
    defaultReasoningLevel = resolveReasoningDefault({
      provider,
      model,
      catalog: catalogForReasoning,
    });
    return defaultReasoningLevel;
  };
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: modelCatalog ?? allowedModelCatalog,
    provider,
    model,
  });
  const configuredModels = cfg.agents?.defaults?.models;
  const canonicalKey = modelKey(provider, model);
  const legacyKey = legacyModelKey(provider, model);
  const configuredModelThinkingDefault =
    configuredModels?.[canonicalKey]?.params?.thinking ??
    (legacyKey ? configuredModels?.[legacyKey]?.params?.thinking : undefined);
  const hasConfiguredThinkingDefault =
    agentEntry?.thinkingDefault !== undefined ||
    resolveConfiguredModelThinkingDefault(configuredModelThinkingDefault) !== undefined ||
    agentCfg?.thinkingDefault !== undefined;

  return {
    provider,
    model,
    requestedRouteResolution,
    allowedModelKeys,
    allowedModelCatalog,
    policyAliasIndex: visibilityPolicy.policyAliasIndex,
    resetModelOverride,
    resetModelOverrideRef,
    resetModelOverrideReason,
    modelPolicyConfigPath: visibilityPolicy.allowConfigPath ?? undefined,
    modelPolicyRepairConfigPath: visibilityPolicy.allowRepairConfigPath,
    resolveThinkingCatalog,
    resolveDefaultThinkingLevel,
    hasConfiguredThinkingDefault,
    resolveDefaultReasoningLevel,
    needsModelCatalog,
    modelContextWindow: selectedCatalogEntry?.contextWindow,
    modelContextTokens: selectedCatalogEntry?.contextTokens,
  };
}
