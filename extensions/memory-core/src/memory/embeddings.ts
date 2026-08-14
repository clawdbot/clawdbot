import type { EmbeddingProviderStartupIssue } from "openclaw/plugin-sdk/embedding-providers";
// Memory Core plugin module implements embeddings behavior.
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { formatErrorMessage } from "../dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

export type EmbeddingProvider = MemoryEmbeddingProvider;
export type EmbeddingProviderId = string;
export type EmbeddingProviderRequest = string;
type EmbeddingProviderFallback = string;
export type EmbeddingProviderRuntime = MemoryEmbeddingProviderRuntime;

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: EmbeddingProviderRuntime;
};

type CreateEmbeddingProviderOptions = MemoryEmbeddingProviderCreateOptions & {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

type EmbeddingProviderStartupPreflightResult =
  | { status: "ready" }
  | {
      status: "blocked";
      issues: Array<EmbeddingProviderStartupIssue & { provider: string }>;
    }
  | { status: "indeterminate"; reason: string };

type EmbeddingProviderStartupInspector = Pick<
  MemoryEmbeddingProviderAdapter,
  "id" | "defaultModel" | "formatSetupError" | "inspectStartupPrerequisites"
>;

type ResolveEmbeddingProviderStartupInspector = (
  providerId: string,
  config: MemoryEmbeddingProviderCreateOptions["config"],
) => EmbeddingProviderStartupInspector | undefined;

const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";
const LOCAL_LLAMA_CPP_PROVIDER_ID = "local";

function createMissingLlamaCppProviderError(): Error {
  return new Error(
    [
      "Unknown memory embedding provider: local.",
      "Local GGUF embeddings are provided by the official llama.cpp provider plugin.",
      "Install it with: openclaw plugins install @openclaw/llama-cpp-provider",
      "Then restart OpenClaw and retry: openclaw memory status --deep",
    ].join("\n"),
  );
}

function formatProviderError(
  adapter: Pick<MemoryEmbeddingProviderAdapter, "formatSetupError">,
  err: unknown,
): string {
  return adapter.formatSetupError?.(err) ?? formatErrorMessage(err);
}

function attachProviderToStartupIssue(
  issue: EmbeddingProviderStartupIssue,
  provider: string,
): EmbeddingProviderStartupIssue & { provider: string } {
  return issue.remediation
    ? { provider, code: issue.code, message: issue.message, remediation: issue.remediation }
    : { provider, code: issue.code, message: issue.message };
}

function getAdapter(
  id: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter {
  const adapter = getMemoryEmbeddingProvider(id, config);
  if (adapter) {
    return adapter;
  }
  if (id === LOCAL_LLAMA_CPP_PROVIDER_ID) {
    throw createMissingLlamaCppProviderError();
  }
  throw new Error(`Unknown memory embedding provider: ${id}`);
}

function resolveProviderModel(
  adapter: Pick<MemoryEmbeddingProviderAdapter, "defaultModel">,
  requestedModel: string,
): string {
  const trimmed = requestedModel.trim();
  if (trimmed) {
    return trimmed;
  }
  return adapter.defaultModel ?? "";
}

function resolveStartupInspector(
  providerId: string,
  config: MemoryEmbeddingProviderCreateOptions["config"],
  resolveInspector?: ResolveEmbeddingProviderStartupInspector,
): EmbeddingProviderStartupInspector {
  if (!resolveInspector) {
    return getAdapter(providerId, config);
  }
  const inspector = resolveInspector(providerId, config);
  if (!inspector) {
    throw new Error(`Unknown memory embedding provider: ${providerId}`);
  }
  return inspector;
}

export function resolveEmbeddingProviderFallbackModel(
  providerId: string,
  fallbackSourceModel: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string {
  const adapter = getMemoryEmbeddingProvider(providerId, config);
  return adapter?.defaultModel ?? fallbackSourceModel;
}

export function resolveEmbeddingProviderFallbackRemote<
  TRemote extends NonNullable<MemoryEmbeddingProviderCreateOptions["remote"]>,
>(remote: TRemote | undefined): Omit<TRemote, "apiKey" | "baseUrl" | "headers"> | undefined {
  if (!remote) {
    return undefined;
  }
  // Endpoint and auth belong to the primary provider; batch settings are safe to reuse.
  const { baseUrl: _baseUrl, apiKey: _apiKey, headers: _headers, ...sharedRemote } = remote;
  return Object.keys(sharedRemote).length > 0 ? sharedRemote : undefined;
}

export function resolveEmbeddingProviderAdapterId(
  providerId: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string | undefined {
  try {
    return getAdapter(providerId, config).id;
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderAdapterTransport(
  providerId: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter["transport"] {
  try {
    return getAdapter(providerId, config).transport;
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderIndexIdentity(options: CreateEmbeddingProviderOptions) {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  try {
    const adapter = getAdapter(provider, options.config);
    const model = resolveProviderModel(adapter, options.model);
    const identity = adapter.resolveIndexIdentity?.({
      ...options,
      provider,
      model,
    });
    return identity
      ? {
          provider: { id: adapter.id, model: identity.model },
          cacheKeyData: identity.cacheKeyData,
          aliases: identity.aliases,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function createWithAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const createOptions = {
    ...options,
    model: resolveProviderModel(adapter, options.model),
  };
  const result = await adapter.create(createOptions);
  return {
    provider: result.provider,
    requestedProvider: options.provider,
    runtime: result.runtime,
  };
}

async function inspectWithAdapter(
  adapter: EmbeddingProviderStartupInspector,
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderStartupPreflightResult> {
  if (!adapter.inspectStartupPrerequisites) {
    return {
      status: "indeterminate",
      reason: `Embedding provider "${adapter.id}" does not expose startup prerequisite inspection.`,
    };
  }
  try {
    const result = await adapter.inspectStartupPrerequisites({
      ...options,
      model: resolveProviderModel(adapter, options.model),
    });
    if (result.status !== "blocked") {
      return result;
    }
    return {
      status: "blocked",
      issues: result.issues.map((issue) => attachProviderToStartupIssue(issue, adapter.id)),
    };
  } catch (error) {
    return {
      status: "indeterminate",
      reason: `Embedding provider "${adapter.id}" startup inspection failed: ${formatProviderError(adapter, error)}`,
    };
  }
}

export async function inspectEmbeddingProviderStartupPrerequisites(
  options: CreateEmbeddingProviderOptions,
  resolveInspector?: ResolveEmbeddingProviderStartupInspector,
): Promise<EmbeddingProviderStartupPreflightResult> {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  let primaryAdapter: EmbeddingProviderStartupInspector;
  try {
    primaryAdapter = resolveStartupInspector(provider, options.config, resolveInspector);
  } catch (error) {
    return { status: "indeterminate", reason: formatErrorMessage(error) };
  }

  const primaryResult = await inspectWithAdapter(primaryAdapter, {
    ...options,
    provider,
  });
  if (primaryResult.status === "ready") {
    return primaryResult;
  }
  if (!options.fallback || options.fallback === "none" || options.fallback === provider) {
    return primaryResult;
  }

  let fallbackAdapter: EmbeddingProviderStartupInspector;
  try {
    fallbackAdapter = resolveStartupInspector(options.fallback, options.config, resolveInspector);
  } catch (error) {
    return {
      status: "indeterminate",
      reason: `${primaryResult.status === "indeterminate" ? primaryResult.reason : "Primary provider is blocked"} Fallback inspection failed: ${formatErrorMessage(error)}`,
    };
  }
  const fallbackResult = await inspectWithAdapter(fallbackAdapter, {
    ...options,
    provider: options.fallback,
    model: resolveEmbeddingProviderFallbackModel(options.fallback, options.model, options.config),
    remote: resolveEmbeddingProviderFallbackRemote(options.remote),
    fallback: "none",
  });
  if (fallbackResult.status === "ready") {
    return fallbackResult;
  }
  if (primaryResult.status === "blocked" && fallbackResult.status === "blocked") {
    return {
      status: "blocked",
      issues: [...primaryResult.issues, ...fallbackResult.issues],
    };
  }
  const reasons = [primaryResult, fallbackResult]
    .filter(
      (
        result,
      ): result is Extract<EmbeddingProviderStartupPreflightResult, { status: "indeterminate" }> =>
        result.status === "indeterminate",
    )
    .map((result) => result.reason);
  return {
    status: "indeterminate",
    reason: reasons.join(" Fallback: "),
  };
}

export async function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  const primaryAdapter = getAdapter(provider, options.config);
  try {
    return await createWithAdapter(primaryAdapter, {
      ...options,
      provider,
    });
  } catch (primaryErr) {
    const reason = formatProviderError(primaryAdapter, primaryErr);
    if (options.fallback && options.fallback !== "none" && options.fallback !== provider) {
      const fallbackAdapter = getAdapter(options.fallback, options.config);
      try {
        const fallbackResult = await createWithAdapter(fallbackAdapter, {
          ...options,
          provider: options.fallback,
          remote: resolveEmbeddingProviderFallbackRemote(options.remote),
        });
        return {
          ...fallbackResult,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        const fallbackReason = formatProviderError(fallbackAdapter, fallbackErr);
        const wrapped = new Error(
          `${reason}\n\nFallback to ${options.fallback} failed: ${fallbackReason}`,
        ) as Error & { cause?: unknown };
        wrapped.cause = primaryErr;
        throw wrapped;
      }
    }
    const wrapped = new Error(reason) as Error & { cause?: unknown };
    wrapped.cause = primaryErr;
    throw wrapped;
  }
}
