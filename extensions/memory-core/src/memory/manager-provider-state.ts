// Memory Core provider module implements model/runtime integration.
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

type MemoryResolvedProviderState = {
  provider: EmbeddingProvider | null;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  providerRuntime?: EmbeddingProviderRuntime;
  lifecycle: MemoryProviderLifecycleState;
};

export type MemoryProviderLifecycleState =
  | {
      mode: "pending";
      requestedProvider: string;
    }
  | {
      mode: "active";
      providerId: string;
    }
  | {
      mode: "degraded";
      providerId: string;
      reason: string;
      code?: string;
    }
  | {
      mode: "fallback-active";
      providerId: string;
      fallbackFrom: string;
      reason: string;
    }
  | {
      mode: "fts-only";
      reason: string;
      attemptedProviderId?: string;
    };

export function createPendingMemoryProviderLifecycle(
  requestedProvider: string,
): MemoryProviderLifecycleState {
  return { mode: "pending", requestedProvider };
}

export function createDegradedMemoryProviderLifecycle(params: {
  providerId: string;
  reason: string;
  code?: string;
}): MemoryProviderLifecycleState {
  return {
    mode: "degraded",
    providerId: params.providerId,
    reason: params.reason,
    ...(params.code ? { code: params.code } : {}),
  };
}

function resolveProviderLifecycle(
  result: Pick<
    EmbeddingProviderResult,
    | "provider"
    | "fallbackFrom"
    | "fallbackReason"
    | "providerUnavailableReason"
    | "requestedProvider"
  >,
): MemoryProviderLifecycleState {
  if (result.provider && result.fallbackFrom) {
    return {
      mode: "fallback-active",
      providerId: result.provider.id,
      fallbackFrom: result.fallbackFrom,
      reason: result.fallbackReason ?? "fallback activated",
    };
  }
  if (result.provider) {
    return { mode: "active", providerId: result.provider.id };
  }
  return {
    mode: "fts-only",
    reason: result.providerUnavailableReason ?? "No embedding provider available",
    attemptedProviderId: result.requestedProvider,
  };
}

export function resolveFallbackCurrentProviderId(params: {
  provider: EmbeddingProvider | null;
  lifecycle: MemoryProviderLifecycleState;
}): string | null {
  if (params.provider) {
    return params.provider.id;
  }
  if (params.lifecycle.mode === "degraded") {
    return params.lifecycle.providerId;
  }
  return null;
}

export function resolveMemoryPrimaryProviderRequest(params: {
  settings: ResolvedMemorySearchConfig;
}): {
  provider: string;
  model: string;
  remote: ResolvedMemorySearchConfig["remote"];
  inputType: ResolvedMemorySearchConfig["inputType"];
  queryInputType: ResolvedMemorySearchConfig["queryInputType"];
  documentInputType: ResolvedMemorySearchConfig["documentInputType"];
  outputDimensionality: ResolvedMemorySearchConfig["outputDimensionality"];
  fallback: ResolvedMemorySearchConfig["fallback"];
  local: ResolvedMemorySearchConfig["local"];
} {
  return {
    provider: params.settings.provider,
    model: params.settings.model,
    remote: params.settings.remote,
    inputType: params.settings.inputType,
    queryInputType: params.settings.queryInputType,
    documentInputType: params.settings.documentInputType,
    outputDimensionality: params.settings.outputDimensionality,
    fallback: params.settings.fallback,
    local: params.settings.local,
  };
}

export function resolveMemoryProviderState(
  result: Pick<
    EmbeddingProviderResult,
    | "provider"
    | "fallbackFrom"
    | "fallbackReason"
    | "providerUnavailableReason"
    | "runtime"
    | "requestedProvider"
  >,
): MemoryResolvedProviderState {
  return {
    provider: result.provider,
    fallbackFrom: result.fallbackFrom,
    fallbackReason: result.fallbackReason,
    providerUnavailableReason: result.providerUnavailableReason,
    providerRuntime: result.runtime,
    lifecycle: resolveProviderLifecycle(result),
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
    providerUnavailableReason: undefined,
    provider: params.result.provider,
    providerRuntime: params.result.runtime,
    lifecycle: params.result.provider
      ? {
          mode: "fallback-active",
          providerId: params.result.provider.id,
          fallbackFrom: params.fallbackFrom,
          reason: params.reason,
        }
      : {
          mode: "fts-only",
          reason: params.reason,
          attemptedProviderId: params.fallbackFrom,
        },
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
  inputType: ResolvedMemorySearchConfig["inputType"];
  queryInputType: ResolvedMemorySearchConfig["queryInputType"];
  documentInputType: ResolvedMemorySearchConfig["documentInputType"];
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
    inputType: params.settings.inputType,
    queryInputType: params.settings.queryInputType,
    documentInputType: params.settings.documentInputType,
    outputDimensionality: params.settings.outputDimensionality,
    fallback: "none",
    local: params.settings.local,
  };
}
