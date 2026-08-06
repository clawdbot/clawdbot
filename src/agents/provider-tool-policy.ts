import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { ToolPolicyConfig } from "../config/types.tools.js";

export function normalizeToolProviderPolicyKey(value: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return normalizeProviderId(normalized);
  }
  const provider = normalizeProviderId(normalized.slice(0, slashIndex));
  const modelId = normalized.slice(slashIndex + 1);
  return modelId ? `${provider}/${modelId}` : provider;
}

export function isCanonicalToolProviderPolicyKey(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value) === normalizeToolProviderPolicyKey(value);
}

type ProviderToolPolicyEntry = {
  key: string;
  policy: ToolPolicyConfig;
};

export function resolveProviderToolPolicyEntry(params: {
  byProvider?: Record<string, unknown>;
  modelProvider?: string;
  modelId?: string;
}): ProviderToolPolicyEntry | undefined {
  const provider = params.modelProvider?.trim();
  if (!provider || !params.byProvider) {
    return undefined;
  }

  const lookup = new Map<
    string,
    ProviderToolPolicyEntry & {
      canonical: boolean;
    }
  >();
  for (const [key, value] of Object.entries(params.byProvider)) {
    if (!hasRecord(value)) {
      continue;
    }
    const normalized = normalizeToolProviderPolicyKey(key);
    if (!normalized) {
      continue;
    }
    const canonical = isCanonicalToolProviderPolicyKey(key);
    const existing = lookup.get(normalized);
    if (!existing || (canonical && !existing.canonical)) {
      lookup.set(normalized, {
        key,
        policy: value as ToolPolicyConfig,
        canonical,
      });
    }
  }

  const normalizedProvider = normalizeToolProviderPolicyKey(provider);
  const rawModelId = normalizeOptionalLowercaseString(params.modelId);
  const fullModelId = rawModelId ? `${normalizedProvider}/${rawModelId}` : undefined;
  const candidates = [...(fullModelId ? [fullModelId] : []), normalizedProvider];

  for (const key of candidates) {
    const match = lookup.get(key);
    if (match) {
      return { key: match.key, policy: match.policy };
    }
  }
  return undefined;
}

export function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, unknown>;
  modelProvider?: string;
  modelId?: string;
}): ToolPolicyConfig | undefined {
  return resolveProviderToolPolicyEntry(params)?.policy;
}
