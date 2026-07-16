import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  resolveEmbeddingProviderFallbackModel,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";

export type MemoryResolvedProviderState = {
  provider: EmbeddingProvider | null;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  providerRuntime?: EmbeddingProviderRuntime;
};

export function resolveMemoryPrimaryProviderRequest(params: {
  settings: ResolvedMemorySearchConfig;
}): {
  provider: string;
  model: string;
  remote: ResolvedMemorySearchConfig["remote"];
  outputDimensionality: ResolvedMemorySearchConfig["outputDimensionality"];
  fallback: ResolvedMemorySearchConfig["fallback"];
  local: ResolvedMemorySearchConfig["local"];
} {
  return {
    provider: params.settings.provider,
    model: params.settings.model,
    remote: params.settings.remote,
    outputDimensionality: params.settings.outputDimensionality,
    fallback: params.settings.fallback,
    local: params.settings.local,
  };
}

export function resolveMemoryProviderState(
  result: Pick<
    EmbeddingProviderResult,
    "provider" | "fallbackFrom" | "fallbackReason" | "providerUnavailableReason" | "runtime"
  >,
): MemoryResolvedProviderState {
  return {
    provider: result.provider,
    fallbackFrom: result.fallbackFrom,
    fallbackReason: result.fallbackReason,
    providerUnavailableReason: result.providerUnavailableReason,
    providerRuntime: result.runtime,
  };
}

export function applyMemoryFallbackProviderState(params: {
  current: MemoryResolvedProviderState;
  fallbackFrom: string;
  reason: string;
  result: Pick<EmbeddingProviderResult, "provider" | "runtime">;
}): MemoryResolvedProviderState {
  return {
    ...params.current,
    fallbackFrom: params.fallbackFrom,
    fallbackReason: params.reason,
    provider: params.result.provider,
    providerRuntime: params.result.runtime,
  };
}

export function resolveMemoryFallbackProviderRequest(params: {
  cfg: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
  currentProviderId: string | null;
}): {
  provider: string;
  model: string;
  remote: ResolvedMemorySearchConfig["remote"];
  outputDimensionality: ResolvedMemorySearchConfig["outputDimensionality"];
  fallback: "none";
  local: ResolvedMemorySearchConfig["local"];
} | null {
  const fallback = params.settings.fallback;
  if (
    !fallback ||
    fallback === "none" ||
    !params.currentProviderId ||
    fallback === params.currentProviderId
  ) {
    return null;
  }
  return {
    provider: fallback,
    model: resolveEmbeddingProviderFallbackModel(fallback, params.settings.model, params.cfg),
    remote: params.settings.remote,
    outputDimensionality: params.settings.outputDimensionality,
    fallback: "none",
    local: params.settings.local,
  };
}
