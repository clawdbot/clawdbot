import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  buildConfiguredModelCatalog,
  buildAllowedModelSet,
  type ModelAliasIndex,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolveModelRefFromString,
  resolvePersistedOverrideModelRef,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { ThinkLevel } from "./directives.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

export type ModelDirectiveSelection = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
};

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

const FUZZY_VARIANT_TOKENS = [
  "lightning",
  "preview",
  "mini",
  "fast",
  "turbo",
  "lite",
  "beta",
  "small",
  "nano",
];

function boundedLevenshteinDistance(a: string, b: string, maxDistance: number): number | null {
  if (a === b) {
    return 0;
  }
  if (!a || !b) {
    return null;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (Math.abs(aLen - bLen) > maxDistance) {
    return null;
  }

  // Standard DP with early exit. O(maxDistance * minLen) in common cases.
  const prev = Array.from({ length: bLen + 1 }, (_, idx) => idx);
  const curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }

    if (rowMin > maxDistance) {
      return null;
    }

    for (let j = 0; j <= bLen; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }

  const dist = prev[bLen] ?? null;
  if (dist == null || dist > maxDistance) {
    return null;
  }
  return dist;
}

function scoreFuzzyMatch(params: {
  provider: string;
  model: string;
  fragment: string;
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  defaultModel: string;
}): {
  score: number;
  isDefault: boolean;
  variantCount: number;
  variantMatchCount: number;
  modelLength: number;
  key: string;
} {
  const provider = normalizeProviderId(params.provider);
  const model = params.model;
  const fragment = normalizeLowercaseStringOrEmpty(params.fragment);
  const providerLower = normalizeLowercaseStringOrEmpty(provider);
  const modelLower = normalizeLowercaseStringOrEmpty(model);
  const haystack = `${providerLower}/${modelLower}`;
  const key = modelKey(provider, model);

  const scoreFragment = (
    value: string,
    weights: { exact: number; starts: number; includes: number },
  ) => {
    if (!fragment) {
      return 0;
    }
    let score = 0;
    if (value === fragment) {
      score = Math.max(score, weights.exact);
    }
    if (value.startsWith(fragment)) {
      score = Math.max(score, weights.starts);
    }
    if (value.includes(fragment)) {
      score = Math.max(score, weights.includes);
    }
    return score;
  };

  let score = 0;
  score += scoreFragment(haystack, { exact: 220, starts: 140, includes: 110 });
  score += scoreFragment(providerLower, {
    exact: 180,
    starts: 120,
    includes: 90,
  });
  score += scoreFragment(modelLower, {
    exact: 160,
    starts: 110,
    includes: 80,
  });

  // Best-effort typo tolerance for common near-misses like "claud" vs "claude".
  // Bounded to keep this cheap across large model sets.
  const distModel = boundedLevenshteinDistance(fragment, modelLower, 3);
  if (distModel != null) {
    score += (3 - distModel) * 70;
  }

  const aliases = params.aliasIndex.byKey.get(key) ?? [];
  for (const alias of aliases) {
    score += scoreFragment(normalizeLowercaseStringOrEmpty(alias), {
      exact: 140,
      starts: 90,
      includes: 60,
    });
  }

  if (modelLower.startsWith(providerLower)) {
    score += 30;
  }

  const fragmentVariants = FUZZY_VARIANT_TOKENS.filter((token) => fragment.includes(token));
  const modelVariants = FUZZY_VARIANT_TOKENS.filter((token) => modelLower.includes(token));
  const variantMatchCount = fragmentVariants.filter((token) => modelLower.includes(token)).length;
  const variantCount = modelVariants.length;
  if (fragmentVariants.length === 0 && variantCount > 0) {
    score -= variantCount * 30;
  } else if (fragmentVariants.length > 0) {
    if (variantMatchCount > 0) {
      score += variantMatchCount * 40;
    }
    if (variantMatchCount === 0) {
      score -= 20;
    }
  }

  const defaultProvider = normalizeProviderId(params.defaultProvider);
  const isDefault = provider === defaultProvider && model === params.defaultModel;
  if (isDefault) {
    score += 20;
  }

  return {
    score,
    isDefault,
    variantCount,
    variantMatchCount,
    modelLength: modelLower.length,
    key,
  };
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
    if (!modelCatalog) {
      modelCatalog = await (await loadModelCatalogRuntime()).loadModelCatalog({ config: cfg });
      logStage("catalog-loaded-for-thinking", `entries=${modelCatalog.length}`);
    }
    const catalogForThinking = modelCatalog.length > 0 ? modelCatalog : allowedModelCatalog;
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

export function resolveModelDirectiveSelection(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): { selection?: ModelDirectiveSelection; error?: string } {
  const { raw, defaultProvider, defaultModel, aliasIndex, allowedModelKeys } = params;

  const rawTrimmed = raw.trim();
  const rawLower = normalizeLowercaseStringOrEmpty(rawTrimmed);

  const pickAliasForKey = (provider: string, model: string): string | undefined =>
    aliasIndex.byKey.get(modelKey(provider, model))?.[0];

  const buildSelection = (provider: string, model: string): ModelDirectiveSelection => {
    const alias = pickAliasForKey(provider, model);
    return {
      provider,
      model,
      isDefault: provider === defaultProvider && model === defaultModel,
      ...(alias ? { alias } : undefined),
    };
  };

  const resolveFuzzy = (params: {
    provider?: string;
    fragment: string;
  }): { selection?: ModelDirectiveSelection; error?: string } => {
    const fragment = normalizeLowercaseStringOrEmpty(params.fragment);
    if (!fragment) {
      return {};
    }

    const providerFilter = params.provider ? normalizeProviderId(params.provider) : undefined;

    const candidates: Array<{ provider: string; model: string }> = [];
    for (const key of allowedModelKeys) {
      const slash = key.indexOf("/");
      if (slash <= 0) {
        continue;
      }
      const provider = normalizeProviderId(key.slice(0, slash));
      const model = key.slice(slash + 1);
      if (providerFilter && provider !== providerFilter) {
        continue;
      }
      candidates.push({ provider, model });
    }

    // Also allow partial alias matches when the user didn't specify a provider.
    if (!params.provider) {
      const aliasMatches: Array<{ provider: string; model: string }> = [];
      for (const [aliasKey, entry] of aliasIndex.byAlias.entries()) {
        if (!aliasKey.includes(fragment)) {
          continue;
        }
        aliasMatches.push({
          provider: entry.ref.provider,
          model: entry.ref.model,
        });
      }
      for (const match of aliasMatches) {
        const key = modelKey(match.provider, match.model);
        if (!allowedModelKeys.has(key)) {
          continue;
        }
        if (!candidates.some((c) => c.provider === match.provider && c.model === match.model)) {
          candidates.push(match);
        }
      }
    }

    if (candidates.length === 0) {
      return {};
    }

    const scored = candidates
      .map((candidate) => {
        const details = scoreFuzzyMatch({
          provider: candidate.provider,
          model: candidate.model,
          fragment,
          aliasIndex,
          defaultProvider,
          defaultModel,
        });
        return Object.assign({ candidate }, details);
      })
      .toSorted((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.isDefault !== b.isDefault) {
          return a.isDefault ? -1 : 1;
        }
        if (a.variantMatchCount !== b.variantMatchCount) {
          return b.variantMatchCount - a.variantMatchCount;
        }
        if (a.variantCount !== b.variantCount) {
          return a.variantCount - b.variantCount;
        }
        if (a.modelLength !== b.modelLength) {
          return a.modelLength - b.modelLength;
        }
        return a.key.localeCompare(b.key);
      });

    const bestScored = scored[0];
    const best = bestScored?.candidate;
    if (!best || !bestScored) {
      return {};
    }

    const minScore = providerFilter ? 90 : 120;
    if (bestScored.score < minScore) {
      return {};
    }

    return { selection: buildSelection(best.provider, best.model) };
  };

  const resolved = resolveModelRefFromString({
    raw: rawTrimmed,
    defaultProvider,
    aliasIndex,
  });

  if (!resolved) {
    const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
    if (fuzzy.selection || fuzzy.error) {
      return fuzzy;
    }
    return {
      error: `Unrecognized model "${rawTrimmed}". Use /models to list providers, or /models <provider> to list models.`,
    };
  }

  const resolvedKey = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowedModelKeys.size === 0 || allowedModelKeys.has(resolvedKey)) {
    return {
      selection: {
        provider: resolved.ref.provider,
        model: resolved.ref.model,
        isDefault: resolved.ref.provider === defaultProvider && resolved.ref.model === defaultModel,
        alias: resolved.alias,
      },
    };
  }

  // If the user specified a provider/model but the exact model isn't allowed,
  // attempt a fuzzy match within that provider.
  if (rawLower.includes("/")) {
    const slash = rawTrimmed.indexOf("/");
    const provider = normalizeProviderId(rawTrimmed.slice(0, slash).trim());
    const fragment = rawTrimmed.slice(slash + 1).trim();
    const fuzzy = resolveFuzzy({ provider, fragment });
    if (fuzzy.selection || fuzzy.error) {
      return fuzzy;
    }
  }

  // Otherwise, try fuzzy matching across allowlisted models.
  const fuzzy = resolveFuzzy({ fragment: rawTrimmed });
  if (fuzzy.selection || fuzzy.error) {
    return fuzzy;
  }

  return {
    error: `Model "${resolved.ref.provider}/${resolved.ref.model}" is not allowed. Use /models to list providers, or /models <provider> to list models.`,
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
