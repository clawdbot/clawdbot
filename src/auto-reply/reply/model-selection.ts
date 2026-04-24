import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  buildConfiguredModelCatalog,
  buildAllowedModelSet,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolvePersistedOverrideModelRef,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import type { ThinkLevel } from "./directives.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

type ModelCatalog = ModelCatalogEntry[];

type ModelSelectionState = {
  provider: string;
  model: string;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  resetModelOverride: boolean;
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
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
}

function shouldLogModelSelectionTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

let modelCatalogRuntimePromise:
  | Promise<typeof import("../../agents/model-catalog.runtime.js")>
  | undefined;
let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

function loadModelCatalogRuntime() {
  modelCatalogRuntimePromise ??= import("../../agents/model-catalog.runtime.js");
  return modelCatalogRuntimePromise;
}

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
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
  provider: string;
  model: string;
  hasModelDirective: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
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

  const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const configuredModelCatalog = buildConfiguredModelCatalog({ cfg });
  const needsModelCatalog = params.hasModelDirective;

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  let resetModelOverride = false;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;
  const directStoredOverride = resolvePersistedOverrideModelRef({
    defaultProvider,
    overrideProvider: sessionEntry?.providerOverride,
    overrideModel: sessionEntry?.modelOverride,
  });
  const hadDirectAutoSessionOverride =
    sessionEntry?.modelOverrideSource === "auto" && Boolean(directStoredOverride);

  if (needsModelCatalog) {
    modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
    logStage("catalog-loaded", `entries=${modelCatalog.length}`);
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist) {
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: configuredModelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.agentId,
    });
    allowedModelCatalog = allowed.allowedCatalog;
    allowedModelKeys = allowed.allowedKeys;
    logStage(
      "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (configuredModelCatalog.length > 0) {
    logStage("configured-catalog-ready", `entries=${configuredModelCatalog.length}`);
  }

  // Auto-failover overrides are transient: on this turn, retry the configured
  // primary so the session self-heals when the primary recovers. The fallback loop
  // in runWithModelFallback will re-set the override if the primary is still down.
  // User-selected overrides (/model command) are preserved across turns.
  //
  // Clear this before allowlist validation so an old fallback outside the current
  // agent allowlist does not emit the unrelated "Model override not allowed" event.
  if (hadDirectAutoSessionOverride && sessionEntry && sessionStore && sessionKey) {
    const { updated } = applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
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
      // Reset in-memory selection to the configured primary. The caller-provided
      // provider/model may already be set to the fallback by stored-override preload
      // in get-reply.ts; updating them here ensures this turn retries the primary.
      provider = defaultProvider;
      model = defaultModel;
    }
  }

  if (
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    directStoredOverride &&
    !hadDirectAutoSessionOverride
  ) {
    const normalizedOverride = normalizeModelRef(
      directStoredOverride.provider,
      directStoredOverride.model,
    );
    const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
    if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
      const { updated } = applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
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
    }
  }

  const storedOverride = hadDirectAutoSessionOverride
    ? undefined
    : resolveStoredModelOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        parentSessionKey,
        defaultProvider,
      });
  // Skip stored session model override only when an explicit heartbeat.model
  // was resolved. Heartbeat runs without heartbeat.model should still inherit
  // the regular session/parent model override behavior.
  const skipStoredOverride = params.hasResolvedHeartbeatModelOverride === true;

  if (storedOverride?.model && !skipStoredOverride) {
    const normalizedStoredOverride = normalizeModelRef(
      storedOverride.provider || defaultProvider,
      storedOverride.model,
    );
    const key = modelKey(normalizedStoredOverride.provider, normalizedStoredOverride.model);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = normalizedStoredOverride.provider;
      model = normalizedStoredOverride.model;
    }
  }

  if (sessionEntry && sessionStore && sessionKey && sessionEntry.authProfileOverride) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const providerKey = normalizeProviderId(provider);
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

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
  return (
    params.agentCfg?.contextTokens ??
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      allowAsyncLoad: false,
    }) ??
    DEFAULT_CONTEXT_TOKENS
  );
}
