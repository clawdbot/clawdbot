// Thinking/reasoning level catalog helpers for auto-reply model controls.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveClaudeThinkingProfile } from "../plugins/provider-claude-thinking.js";
import {
  BASE_THINKING_LEVELS,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
  THINKING_LEVEL_RANKS,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  isSessionDefaultDirectiveValue,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveEffectiveResponseUsage,
  resolveResponseUsageMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  FastMode,
  ReasoningLevel,
  TraceLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveProviderThinkingProfile } from "../plugins/provider-thinking.js";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";

/** UI-facing thinking level option. */
type ThinkingLevelOption = {
  id: ThinkLevel;
  label: string;
};

type RankedThinkingLevelOption = ThinkingLevelOption & {
  rank: number;
};

type ResolvedThinkingProfile = {
  levels: RankedThinkingLevelOption[];
  defaultLevel?: ThinkLevel | null;
};

function buildCatalogModelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeOptionalLowercaseString(modelId)?.startsWith(
    `${normalizeOptionalLowercaseString(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

function resolveThinkingPolicyContext(params: {
  provider?: string | null;
  model?: string | null;
  catalog?: ThinkingCatalogEntry[];
}) {
  const providerRaw = normalizeOptionalString(params.provider);
  const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
  const modelId = normalizeOptionalString(params.model) ?? "";
  const modelKey = normalizeOptionalLowercaseString(params.model) ?? "";
  const selectedCatalogKey =
    normalizedProvider && modelId ? buildCatalogModelKey(normalizedProvider, modelId) : undefined;
  const candidate = params.catalog?.find(
    (entry) =>
      selectedCatalogKey !== undefined &&
      buildCatalogModelKey(normalizeProviderId(entry.provider), entry.id) === selectedCatalogKey,
  );
  return {
    normalizedProvider,
    modelId,
    modelKey,
    api: candidate?.api,
    reasoning: candidate?.reasoning,
    ...(candidate?.params ? { params: candidate.params } : {}),
    compat: candidate?.compat,
  };
}

function catalogSupportsXHigh(compat: ThinkingCatalogEntry["compat"]): boolean {
  const efforts = compat?.supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return false;
  }
  return efforts.some((effort) => normalizeThinkLevel(effort) === "xhigh");
}

function normalizeProfileLevel(
  level: ProviderThinkingProfile["levels"][number],
): RankedThinkingLevelOption | undefined {
  const normalized = normalizeThinkLevel(level.id);
  if (!normalized) {
    return undefined;
  }
  return {
    id: normalized,
    label: normalizeOptionalString(level.label) ?? normalized,
    rank: Number.isFinite(level.rank) ? (level.rank as number) : THINKING_LEVEL_RANKS[normalized],
  };
}

function normalizeThinkingProfile(profile: ProviderThinkingProfile): ResolvedThinkingProfile {
  const byId = new Map<ThinkLevel, RankedThinkingLevelOption>();
  for (const raw of profile.levels) {
    const level = normalizeProfileLevel(raw);
    if (level) {
      byId.set(level.id, level);
    }
  }
  const levels = [...byId.values()].toSorted((a, b) => a.rank - b.rank);
  const rawDefaultLevel = profile.defaultLevel
    ? normalizeThinkLevel(profile.defaultLevel)
    : undefined;
  const defaultLevel = rawDefaultLevel && byId.has(rawDefaultLevel) ? rawDefaultLevel : undefined;
  return { levels, defaultLevel };
}

function buildBaseThinkingProfile(defaultLevel?: ThinkLevel | null): ResolvedThinkingProfile {
  return {
    levels: BASE_THINKING_LEVELS.map((id) => ({
      id,
      label: id,
      rank: THINKING_LEVEL_RANKS[id],
    })),
    defaultLevel,
  };
}

function buildOffOnlyThinkingProfile(): ResolvedThinkingProfile {
  return {
    levels: [{ id: "off", label: "off", rank: THINKING_LEVEL_RANKS.off }],
    defaultLevel: "off",
  };
}

function appendProfileLevel(profile: ResolvedThinkingProfile, id: ThinkLevel) {
  if (profile.levels.some((level) => level.id === id)) {
    return;
  }
  profile.levels.push({ id, label: id, rank: THINKING_LEVEL_RANKS[id] });
  profile.levels = profile.levels.toSorted((a, b) => a.rank - b.rank);
}

/** Resolve supported thinking levels and default for a provider/model pair. */
export function resolveThinkingProfile(params: {
  provider?: string | null;
  model?: string | null;
  catalog?: ThinkingCatalogEntry[];
  agentRuntime?: string | null;
  providerPolicySource?: "active" | "active-or-bundled";
}): ResolvedThinkingProfile {
  const context = resolveThinkingPolicyContext(params);
  if (!context.normalizedProvider) {
    return buildBaseThinkingProfile();
  }
  const providerContext = {
    provider: context.normalizedProvider,
    modelId: context.modelId,
    agentRuntime: params.agentRuntime,
    api: context.api,
    reasoning: context.reasoning,
    ...(context.params ? { params: context.params } : {}),
    compat: context.compat,
  };
  const providerProfileParams = {
    provider: context.normalizedProvider,
    context: providerContext,
  };
  const providerProfile =
    params.providerPolicySource === "active"
      ? resolveProviderThinkingProfile(providerProfileParams, {
          allowPublicArtifactFallback: false,
        })
      : resolveProviderThinkingProfile(providerProfileParams);
  // Any anthropic-messages catalog row routes through the canonical Claude
  // resolver: Claude families get the proper profile (incl. xhigh/adaptive/max);
  // non-Claude models on the anthropic-messages transport collapse to the Claude
  // base set, deliberately bypassing the later compat-driven xhigh upgrade —
  // anthropic-messages does not carry a generic xhigh contract.
  const anthropicMessagesProfile =
    context.api === "anthropic-messages"
      ? resolveClaudeThinkingProfile(context.modelId, context.params, {
          includeNativeMax: true,
        })
      : undefined;
  const pluginProfile = providerProfile ?? anthropicMessagesProfile;
  if (pluginProfile) {
    const normalized = normalizeThinkingProfile(pluginProfile);
    if (
      normalized.levels.length > 0 &&
      (context.reasoning !== false || pluginProfile.preserveWhenCatalogReasoningFalse === true)
    ) {
      return normalized;
    }
  }
  if (context.reasoning === false) {
    return buildOffOnlyThinkingProfile();
  }

  const profile = buildBaseThinkingProfile();
  if (catalogSupportsXHigh(context.compat)) {
    appendProfileLevel(profile, "xhigh");
  }
  return profile;
}

function supportsThinkingLevel(
  provider: string | null | undefined,
  model: string | null | undefined,
  level: ThinkLevel,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): boolean {
  return resolveThinkingProfile({ provider, model, catalog, agentRuntime }).levels.some(
    (entry) => entry.id === level,
  );
}

/** List thinking level ids supported by provider/model. */
export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): ThinkLevel[] {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map((level) => level.id);
}

/** List labeled thinking level options supported by provider/model. */
export function listThinkingLevelOptions(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): ThinkingLevelOption[] {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map(({ id, label }) => ({ id, label }));
}

/** List display labels for thinking levels supported by provider/model. */
export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): string[] {
  return listThinkingLevelOptions(provider, model, catalog, agentRuntime).map(
    (level) => level.label,
  );
}

/** Format supported thinking level labels for command/status output. */
export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): string {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map(({ label }) => label).join(separator);
}

/** Resolve the default thinking level for a provider/model pair. */
export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
  agentRuntime?: string | null;
}): ThinkLevel {
  const profile = resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
    agentRuntime: params.agentRuntime,
  });
  if (profile.defaultLevel) {
    return profile.defaultLevel;
  }
  const fallback = resolveThinkingDefaultForModelFallback(params);
  if (fallback === "off") {
    return "off";
  }
  return resolveSupportedThinkingLevelFromProfile(profile, "medium");
}

/** Return whether a specific thinking level is supported by provider/model. */
export function isThinkingLevelSupported(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
  agentRuntime?: string | null;
}): boolean {
  return supportsThinkingLevel(
    params.provider,
    params.model,
    params.level,
    params.catalog,
    params.agentRuntime,
  );
}

function resolveSupportedThinkingLevelFromProfile(
  profile: ResolvedThinkingProfile,
  level: ThinkLevel,
): ThinkLevel {
  if (profile.levels.some((entry) => entry.id === level)) {
    return level;
  }
  const requestedRank = THINKING_LEVEL_RANKS[level];
  const ranked = profile.levels.toSorted((a, b) => b.rank - a.rank);
  return (
    ranked.find((entry) => entry.id !== "off" && entry.rank <= requestedRank)?.id ??
    ranked.findLast((entry) => entry.id !== "off")?.id ??
    "off"
  );
}

/** Clamp a requested thinking level to the closest supported provider/model level. */
export function resolveSupportedThinkingLevel(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
  agentRuntime?: string | null;
  providerPolicySource?: "active" | "active-or-bundled";
}): ThinkLevel {
  const profile = resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
    agentRuntime: params.agentRuntime,
    providerPolicySource: params.providerPolicySource,
  });
  return resolveSupportedThinkingLevelFromProfile(profile, params.level);
}
