// Thinking/reasoning level catalog helpers for auto-reply model controls.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  BASE_THINKING_LEVELS,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
  THINKING_LEVEL_RANKS,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  formatXHighModelHint,
  isSessionDefaultDirectiveValue,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveResponseUsageMode,
  resolveElevatedMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  TraceLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderThinkingProfile,
  resolveProviderXHighThinking,
} from "../plugins/provider-thinking.js";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";

/** UI-facing thinking level option. */
export type ThinkingLevelOption = {
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
    reasoning: candidate?.reasoning,
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

function buildBinaryThinkingProfile(defaultLevel?: ThinkLevel | null): ResolvedThinkingProfile {
  return {
    levels: [
      { id: "off", label: "off", rank: THINKING_LEVEL_RANKS.off },
      { id: "low", label: "on", rank: THINKING_LEVEL_RANKS.low },
    ],
    defaultLevel,
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
}): ResolvedThinkingProfile {
  const context = resolveThinkingPolicyContext(params);
  if (!context.normalizedProvider) {
    return buildBaseThinkingProfile();
  }
  const providerContext = {
    provider: context.normalizedProvider,
    modelId: context.modelId,
    reasoning: context.reasoning,
    compat: context.compat,
  };
  const pluginProfile = resolveProviderThinkingProfile({
    provider: context.normalizedProvider,
    context: providerContext,
  });
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

  const defaultLevel = resolveProviderDefaultThinkingLevel({
    provider: context.normalizedProvider,
    context: providerContext,
  });
  const binaryDecision = resolveProviderBinaryThinking({
    provider: context.normalizedProvider,
    context: {
      provider: context.normalizedProvider,
      modelId: context.modelId,
    },
  });
  const profile =
    binaryDecision === true
      ? buildBinaryThinkingProfile(defaultLevel)
      : buildBaseThinkingProfile(defaultLevel);
  if (binaryDecision !== true && catalogSupportsXHigh(context.compat)) {
    appendProfileLevel(profile, "xhigh");
  }
  const policyContext = {
    provider: context.normalizedProvider,
    modelId: context.modelKey || context.modelId,
  };
  if (
    binaryDecision !== true &&
    resolveProviderXHighThinking({
      provider: context.normalizedProvider,
      context: policyContext,
    }) === true
  ) {
    appendProfileLevel(profile, "xhigh");
  }
  return profile;
}

/** Return whether provider/model exposes only off/on thinking controls. */
export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const profile = resolveThinkingProfile({ provider, model });
  return profile.levels.length === 2 && profile.levels.some((level) => level.label === "on");
}

function supportsThinkingLevel(
  provider: string | null | undefined,
  model: string | null | undefined,
  level: ThinkLevel,
  catalog?: ThinkingCatalogEntry[],
): boolean {
  return resolveThinkingProfile({ provider, model, catalog }).levels.some(
    (entry) => entry.id === level,
  );
}

/** Return whether provider/model supports the xhigh thinking level. */
export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  return supportsThinkingLevel(provider, model, "xhigh");
}

/** List thinking level ids supported by provider/model. */
export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
): ThinkLevel[] {
  const profile = resolveThinkingProfile({ provider, model, catalog });
  return profile.levels.map((level) => level.id);
}

/** List labeled thinking level options supported by provider/model. */
export function listThinkingLevelOptions(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
): ThinkingLevelOption[] {
  const profile = resolveThinkingProfile({ provider, model, catalog });
  return profile.levels.map(({ id, label }) => ({ id, label }));
}

/** List display labels for thinking levels supported by provider/model. */
export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
): string[] {
  return listThinkingLevelOptions(provider, model, catalog).map((level) => level.label);
}

/** Format supported thinking level labels for command/status output. */
export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  catalog?: ThinkingCatalogEntry[],
): string {
  const profile = resolveThinkingProfile({ provider, model, catalog });
  return profile.levels.map(({ label }) => label).join(separator);
}

/** Resolve the default thinking level for a provider/model pair. */
export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const profile = resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
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

/** Resolve the highest non-off thinking level supported by provider/model. */
export function resolveLargestSupportedThinkingLevel(
  provider?: string | null,
  model?: string | null,
): ThinkLevel {
  const profile = resolveThinkingProfile({ provider, model });
  let bestLevel: ResolvedThinkingProfile["levels"][number] | undefined;
  for (const level of profile.levels) {
    if (level.id === "off") {
      continue;
    }
    if (!bestLevel || level.rank > bestLevel.rank) {
      bestLevel = level;
    }
  }
  return bestLevel?.id ?? "off";
}

/** Return whether a specific thinking level is supported by provider/model. */
export function isThinkingLevelSupported(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
}): boolean {
  return supportsThinkingLevel(params.provider, params.model, params.level, params.catalog);
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
    ranked.find((entry) => entry.id !== "off")?.id ??
    "off"
  );
}

/** Clamp a requested thinking level to the closest supported provider/model level. */
export function resolveSupportedThinkingLevel(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const profile = resolveThinkingProfile({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
  });
  return resolveSupportedThinkingLevelFromProfile(profile, params.level);
}
