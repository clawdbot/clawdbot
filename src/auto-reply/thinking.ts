import { normalizeProviderId } from "../agents/provider-id.js";
import {
  BASE_THINKING_LEVELS,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
  THINKING_LEVEL_RANKS,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  formatXHighModelHint,
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
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderThinkingProfile,
  resolveProviderXHighThinking,
} from "../plugins/provider-thinking.js";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

type ThinkingLevelOption = {
  id: ThinkLevel;
  label: string;
  rank: number;
};

type ResolvedThinkingProfile = {
  levels: ThinkingLevelOption[];
  defaultLevel?: ThinkLevel | null;
};

function resolveThinkingPolicyContext(params: {
  provider?: string | null;
  model?: string | null;
  catalog?: ThinkingCatalogEntry[];
}) {
  const providerRaw = normalizeOptionalString(params.provider);
  const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
  const modelId = normalizeOptionalString(params.model) ?? "";
  const modelKey = normalizeOptionalLowercaseString(params.model) ?? "";
  const candidate = params.catalog?.find(
    (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
  );
  return { normalizedProvider, modelId, modelKey, reasoning: candidate?.reasoning };
}

function normalizeProfileLevel(
  level: ProviderThinkingProfile["levels"][number],
): ThinkingLevelOption | undefined {
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
  const byId = new Map<ThinkLevel, ThinkingLevelOption>();
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
  };
  const pluginProfile = resolveProviderThinkingProfile({
    provider: context.normalizedProvider,
    context: providerContext,
  });
  if (pluginProfile) {
    const normalized = normalizeThinkingProfile(pluginProfile);
    if (normalized.levels.length > 0) {
      return normalized;
    }
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
  const policyContext = {
    provider: context.normalizedProvider,
    modelId: context.modelKey || context.modelId,
  };
  if (
    resolveProviderXHighThinking({
      provider: context.normalizedProvider,
      context: policyContext,
    }) === true
  ) {
    appendProfileLevel(profile, "xhigh");
  }
  return profile;
}

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const profile = resolveThinkingProfile({ provider, model });
  return profile.levels.length === 2 && profile.levels.some((level) => level.label === "on");
}

function supportsThinkingLevel(
  provider: string | null | undefined,
  model: string | null | undefined,
  level: ThinkLevel,
): boolean {
  return resolveThinkingProfile({ provider, model }).levels.some((entry) => entry.id === level);
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  return supportsThinkingLevel(provider, model, "xhigh");
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const profile = resolveThinkingProfile({ provider, model });
  return profile.levels.map((level) => level.id);
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  const profile = resolveThinkingProfile({ provider, model });
  return profile.levels.map((level) => level.label);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevelLabels(provider, model).join(separator);
}

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
  return resolveThinkingDefaultForModelFallback(params);
}

export function resolveLargestSupportedThinkingLevel(
  provider?: string | null,
  model?: string | null,
): ThinkLevel {
  const profile = resolveThinkingProfile({ provider, model });
  return (
    profile.levels.filter((level) => level.id !== "off").toSorted((a, b) => b.rank - a.rank)[0]
      ?.id ?? "off"
  );
}

export function isThinkingLevelSupported(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
}): boolean {
  return supportsThinkingLevel(params.provider, params.model, params.level);
}

export function resolveSupportedThinkingLevel(params: {
  provider?: string | null;
  model?: string | null;
  level: ThinkLevel;
}): ThinkLevel {
  if (isThinkingLevelSupported(params)) {
    return params.level;
  }
  return resolveLargestSupportedThinkingLevel(params.provider, params.model);
}
