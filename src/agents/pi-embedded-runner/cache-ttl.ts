import { resolveProviderCacheTtlEligibility } from "../../plugins/provider-runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import {
  isAnthropicFamilyCacheTtlEligible,
  isAnthropicModelRef,
} from "./anthropic-family-cache-semantics.js";
import { isGooglePromptCacheEligible } from "./prompt-cache-retention.js";

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

type CacheTtlContext = {
  provider?: string;
  modelId?: string;
};

export function isCacheTtlEligibleProvider(
  provider: string,
  modelId: string,
  modelApi?: string,
): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const pluginEligibility = resolveProviderCacheTtlEligibility({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: normalizedModelId,
      modelApi,
    },
  });
  if (pluginEligibility !== undefined) {
    return pluginEligibility;
  }
  return (
    isAnthropicFamilyCacheTtlEligible({
      provider: normalizedProvider,
      modelId: normalizedModelId,
      modelApi,
    }) ||
    (normalizedProvider === "kilocode" && isAnthropicModelRef(normalizedModelId)) ||
    isGooglePromptCacheEligible({ modelApi, modelId: normalizedModelId })
  );
}

function normalizeCacheTtlKey(value: string | undefined): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

function matchesCacheTtlContext(
  data: Partial<CacheTtlEntryData> | undefined,
  context: CacheTtlContext | undefined,
): boolean {
  if (!context) {
    return true;
  }
  const expectedProvider = normalizeCacheTtlKey(context.provider);
  if (expectedProvider && normalizeCacheTtlKey(data?.provider) !== expectedProvider) {
    return false;
  }
  const expectedModelId = normalizeCacheTtlKey(context.modelId);
  if (expectedModelId && normalizeCacheTtlKey(data?.modelId) !== expectedModelId) {
    return false;
  }
  return true;
}

export function readLastCacheTtlTimestamp(
  sessionManager: unknown,
  context?: CacheTtlContext,
): number | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return null;
  }
  try {
    const entries = sm.getEntries();
    let last: number | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      if (!matchesCacheTtlContext(data, context)) {
        continue;
      }
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        last = ts;
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
}
