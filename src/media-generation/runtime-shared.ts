import { listProfilesForProvider } from "../agents/auth-profiles.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getProviderEnvVars as getDefaultProviderEnvVars } from "../secrets/provider-env-vars.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  MediaGenerationNormalizationMetadataInput,
  MediaNormalizationEntry,
  MediaNormalizationValue,
} from "./normalization.types.js";

export type ParsedProviderModelRef = {
  provider: string;
  model: string;
};
export type {
  MediaGenerationNormalizationMetadataInput,
  MediaNormalizationEntry,
  MediaNormalizationValue,
} from "./normalization.types.js";

export function recordCapabilityCandidateFailure(params: {
  attempts: FallbackAttempt[];
  provider: string;
  model: string;
  error: unknown;
}): void {
  const described = isFailoverError(params.error) ? describeFailoverError(params.error) : undefined;
  params.attempts.push({
    provider: params.provider,
    model: params.model,
    error: described?.message ?? formatErrorMessage(params.error),
    reason: described?.reason,
    status: described?.status,
    code: described?.code,
  });
}

export function hasMediaNormalizationEntry<TValue extends MediaNormalizationValue>(
  entry: MediaNormalizationEntry<TValue> | undefined,
): entry is MediaNormalizationEntry<TValue> {
  return Boolean(
    entry &&
    (entry.requested !== undefined ||
      entry.applied !== undefined ||
      entry.derivedFrom !== undefined ||
      (entry.supportedValues?.length ?? 0) > 0),
  );
}

const IMAGE_RESOLUTION_ORDER = ["1K", "2K", "4K"] as const;

type CapabilityProviderCandidate = {
  id: string;
  aliases?: readonly string[];
  defaultModel?: string | null;
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

type ParsedAspectRatio = {
  width: number;
  height: number;
  value: number;
};

type ParsedSize = {
  width: number;
  height: number;
  aspectRatio: number;
  area: number;
};

function resolveCurrentDefaultProviderId(cfg?: OpenClawConfig): string {
  const configured = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.model);
  const trimmed = normalizeOptionalString(configured);
  if (!trimmed) {
    return DEFAULT_PROVIDER;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return DEFAULT_PROVIDER;
  }
  const provider = normalizeOptionalString(trimmed.slice(0, slash));
  return provider || DEFAULT_PROVIDER;
}

function isCapabilityProviderConfigured(params: {
  provider: CapabilityProviderCandidate;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (params.provider.isConfigured) {
    return params.provider.isConfigured({
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  }
  if (resolveEnvApiKey(params.provider.id)?.apiKey) {
    return true;
  }
  const agentDir = normalizeOptionalString(params.agentDir);
  if (!agentDir) {
    return false;
  }
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(store, params.provider.id).length > 0;
}

function resolveAutoCapabilityFallbackRefs(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  listProviders: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
}): string[] {
  const providerDefaults = new Map<string, { ref: string; aliases: string[] }>();
  for (const provider of params.listProviders(params.cfg)) {
    const providerId = normalizeOptionalString(provider.id);
    const modelId = normalizeOptionalString(provider.defaultModel);
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !isCapabilityProviderConfigured({
        provider,
        cfg: params.cfg,
        agentDir: params.agentDir,
      })
    ) {
      continue;
    }
    const aliases = (provider.aliases ?? []).flatMap((alias) => {
      const normalized = normalizeOptionalString(alias);
      return normalized ? [normalized] : [];
    });
    providerDefaults.set(providerId, { ref: `${providerId}/${modelId}`, aliases });
  }

  const defaultProvider = resolveCurrentDefaultProviderId(params.cfg);
  const providerIds = [...providerDefaults.keys()].toSorted();
  const matchesDefaultProvider = (providerId: string): boolean => {
    const entry = providerDefaults.get(providerId);
    return providerId === defaultProvider || (entry?.aliases ?? []).includes(defaultProvider);
  };
  const orderedProviders = [
    ...providerIds.filter(matchesDefaultProvider),
    ...providerIds.filter((providerId) => !matchesDefaultProvider(providerId)),
  ];
  return orderedProviders.flatMap((providerId) => {
    const entry = providerDefaults.get(providerId);
    return entry ? [entry.ref] : [];
  });
}

export function resolveCapabilityModelCandidates(params: {
  cfg: OpenClawConfig;
  modelConfig: AgentModelConfig | undefined;
  modelOverride?: string;
  parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
  agentDir?: string;
  listProviders?: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
  autoProviderFallback?: boolean;
}): ParsedProviderModelRef[] {
  const candidates: ParsedProviderModelRef[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = params.parseModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(parsed);
  };

  const override = params.parseModelRef(params.modelOverride);
  if (override) {
    return [override];
  }

  add(params.modelOverride);
  add(resolveAgentModelPrimaryValue(params.modelConfig));
  for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) {
    add(fallback);
  }
  const autoProviderFallbackEnabled =
    params.autoProviderFallback ??
    params.cfg.agents?.defaults?.mediaGenerationAutoProviderFallback !== false;
  if (autoProviderFallbackEnabled && params.listProviders) {
    for (const candidate of resolveAutoCapabilityFallbackRefs({
      cfg: params.cfg,
      agentDir: params.agentDir,
      listProviders: params.listProviders,
    })) {
      add(candidate);
    }
  }
  return candidates;
}

function normalizeSupportedValues<TValue extends string>(values?: readonly TValue[]): TValue[] {
  return (values ?? []).flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized ? [entry] : [];
  });
}

function compareScores(
  next: { primary: number; secondary: number; tertiary: string },
  best: { primary: number; secondary: number; tertiary: string } | null,
): boolean {
  if (!best) {
    return true;
  }
  if (next.primary !== best.primary) {
    return next.primary < best.primary;
  }
  if (next.secondary !== best.secondary) {
    return next.secondary < best.secondary;
  }
  return next.tertiary.localeCompare(best.tertiary) < 0;
}

function parsePositiveDimensionPair(
  raw: string | null | undefined,
  pattern: RegExp,
): { width: number; height: number } | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const match = pattern.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parseAspectRatioValue(raw?: string | null): ParsedAspectRatio | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!pair) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    value: pair.width / pair.height,
  };
}

function parseSizeValue(raw?: string | null): ParsedSize | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+)\s*x\s*(\d+)$/i);
  if (!pair) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    aspectRatio: pair.width / pair.height,
    area: pair.width * pair.height,
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

export function deriveAspectRatioFromSize(size?: string): string | undefined {
  const parsed = parseSizeValue(size);
  if (!parsed) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(parsed.width, parsed.height);
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

export function resolveClosestAspectRatio(params: {
  requestedAspectRatio?: string;
  requestedSize?: string;
  supportedAspectRatios?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedAspectRatios);
  if (supported.length === 0) {
    return params.requestedAspectRatio ?? deriveAspectRatioFromSize(params.requestedSize);
  }
  if (params.requestedAspectRatio && supported.includes(params.requestedAspectRatio)) {
    return params.requestedAspectRatio;
  }
  const requested =
    parseAspectRatioValue(params.requestedAspectRatio) ??
    parseAspectRatioValue(deriveAspectRatioFromSize(params.requestedSize));
  if (!requested) {
    return undefined;
  }

  let bestValue: string | undefined;
  let bestScore: { primary: number; secondary: number; tertiary: string } | null = null;
  for (const candidate of supported) {
    const parsed = parseAspectRatioValue(candidate);
    if (!parsed) {
      continue;
    }
    const score = {
      primary: Math.abs(Math.log(parsed.value / requested.value)),
      secondary: Math.abs(parsed.width * requested.height - requested.width * parsed.height),
      tertiary: candidate,
    };
    if (compareScores(score, bestScore)) {
      bestValue = candidate;
      bestScore = score;
    }
  }
  return bestValue;
}

export function resolveClosestSize(params: {
  requestedSize?: string;
  requestedAspectRatio?: string;
  supportedSizes?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedSizes);
  if (supported.length === 0) {
    return params.requestedSize;
  }
  if (params.requestedSize && supported.includes(params.requestedSize)) {
    return params.requestedSize;
  }
  const requested = parseSizeValue(params.requestedSize);
  const requestedAspectRatio = parseAspectRatioValue(params.requestedAspectRatio);
  if (!requested && !requestedAspectRatio) {
    return undefined;
  }

  let bestValue: string | undefined;
  let bestScore: { primary: number; secondary: number; tertiary: string } | null = null;
  for (const candidate of supported) {
    const parsed = parseSizeValue(candidate);
    if (!parsed) {
      continue;
    }
    const score = {
      primary: Math.abs(
        Math.log(parsed.aspectRatio / (requested?.aspectRatio ?? requestedAspectRatio!.value)),
      ),
      secondary: requested ? Math.abs(Math.log(parsed.area / requested.area)) : parsed.area,
      tertiary: candidate,
    };
    if (compareScores(score, bestScore)) {
      bestValue = candidate;
      bestScore = score;
    }
  }
  return bestValue;
}

export function resolveClosestResolution<TResolution extends string>(params: {
  requestedResolution?: TResolution;
  supportedResolutions?: readonly TResolution[];
  order?: readonly TResolution[];
}): TResolution | undefined {
  const supported = normalizeSupportedValues(params.supportedResolutions);
  if (supported.length === 0) {
    return params.requestedResolution;
  }
  if (params.requestedResolution && supported.includes(params.requestedResolution)) {
    return params.requestedResolution;
  }
  const order: readonly string[] = params.order ?? IMAGE_RESOLUTION_ORDER;
  const requestedIndex = params.requestedResolution
    ? order.indexOf(params.requestedResolution)
    : -1;
  if (requestedIndex < 0) {
    return undefined;
  }

  let bestValue: TResolution | undefined;
  let bestScore: { primary: number; secondary: number; tertiary: string } | null = null;
  for (const candidate of supported) {
    const candidateIndex = order.indexOf(candidate);
    if (candidateIndex < 0) {
      continue;
    }
    const score = {
      primary: Math.abs(candidateIndex - requestedIndex),
      secondary: candidateIndex,
      tertiary: candidate,
    };
    if (compareScores(score, bestScore)) {
      bestValue = candidate;
      bestScore = score;
    }
  }
  return bestValue;
}

export function normalizeDurationToClosestMax(
  durationSeconds?: number,
  maxDurationSeconds?: number,
) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(durationSeconds));
  if (
    typeof maxDurationSeconds !== "number" ||
    !Number.isFinite(maxDurationSeconds) ||
    maxDurationSeconds <= 0
  ) {
    return rounded;
  }
  return Math.min(rounded, Math.max(1, Math.round(maxDurationSeconds)));
}

export function buildMediaGenerationNormalizationMetadata(params: {
  normalization?: MediaGenerationNormalizationMetadataInput;
  requestedSizeForDerivedAspectRatio?: string;
  includeSupportedDurationSeconds?: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const { normalization } = params;
  if (normalization?.size?.requested !== undefined && normalization.size.applied !== undefined) {
    metadata.requestedSize = normalization.size.requested;
    metadata.normalizedSize = normalization.size.applied;
  }
  if (normalization?.aspectRatio?.applied !== undefined) {
    if (normalization.aspectRatio.requested !== undefined) {
      metadata.requestedAspectRatio = normalization.aspectRatio.requested;
    }
    metadata.normalizedAspectRatio = normalization.aspectRatio.applied;
    if (
      normalization.aspectRatio.derivedFrom === "size" &&
      params.requestedSizeForDerivedAspectRatio
    ) {
      metadata.requestedSize = params.requestedSizeForDerivedAspectRatio;
      metadata.aspectRatioDerivedFromSize = deriveAspectRatioFromSize(
        params.requestedSizeForDerivedAspectRatio,
      );
    }
  }
  if (
    normalization?.resolution?.requested !== undefined &&
    normalization.resolution.applied !== undefined
  ) {
    metadata.requestedResolution = normalization.resolution.requested;
    metadata.normalizedResolution = normalization.resolution.applied;
  }
  if (
    normalization?.durationSeconds?.requested !== undefined &&
    normalization.durationSeconds.applied !== undefined
  ) {
    metadata.requestedDurationSeconds = normalization.durationSeconds.requested;
    metadata.normalizedDurationSeconds = normalization.durationSeconds.applied;
    if (
      params.includeSupportedDurationSeconds &&
      normalization.durationSeconds.supportedValues?.length
    ) {
      metadata.supportedDurationSeconds = normalization.durationSeconds.supportedValues;
    }
  }
  return metadata;
}

export function throwCapabilityGenerationFailure(params: {
  capabilityLabel: string;
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0
      ? params.attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(
    `All ${params.capabilityLabel} models failed (${params.attempts.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

export function buildNoCapabilityModelConfiguredMessage(params: {
  capabilityLabel: string;
  modelConfigKey: string;
  providers: Array<{ id: string; defaultModel?: string | null }>;
  fallbackSampleRef?: string;
  getProviderEnvVars?: typeof getDefaultProviderEnvVars;
}): string {
  const getProviderEnvVars = params.getProviderEnvVars ?? getDefaultProviderEnvVars;
  const sampleModel = params.providers.find(
    (provider) =>
      normalizeOptionalString(provider.id) && normalizeOptionalString(provider.defaultModel),
  );
  const sampleRef = sampleModel
    ? `${sampleModel.id}/${sampleModel.defaultModel}`
    : (params.fallbackSampleRef ?? "<provider>/<model>");
  const authHints = params.providers
    .flatMap((provider) => {
      const envVars = getProviderEnvVars(provider.id);
      if (envVars.length === 0) {
        return [];
      }
      return [`${provider.id}: ${envVars.join(" / ")}`];
    })
    .slice(0, 3);
  return [
    `No ${params.capabilityLabel} model configured. Set agents.defaults.${params.modelConfigKey}.primary to a provider/model like "${sampleRef}".`,
    authHints.length > 0
      ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).`
      : "If you want a specific provider, also configure that provider's auth/API key first.",
  ].join(" ");
}
