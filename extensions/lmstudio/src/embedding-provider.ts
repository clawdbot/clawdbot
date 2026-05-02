import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  buildRemoteBaseUrlPolicy,
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import { formatErrorMessage, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";
import { resolveLmstudioInferenceBase } from "./models.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
} from "./runtime.js";

const log = createSubsystemLogger("memory/embeddings");

type LmstudioEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = LMSTUDIO_DEFAULT_EMBEDDING_MODEL;

/** Normalizes LM Studio embedding model refs and accepts `lmstudio/` prefix. */
function normalizeLmstudioModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
    prefixes: ["lmstudio/"],
  });
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }
  return Object.entries(headers).some(
    ([headerName, value]) =>
      headerName.trim().toLowerCase() === "authorization" && value.trim().length > 0,
  );
}

/** Resolves API key (real or synthetic placeholder) from runtime/provider auth config. */
async function resolveLmstudioApiKey(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<string | undefined> {
  try {
    return await resolveLmstudioRuntimeApiKey({
      config: options.config,
      agentDir: options.agentDir,
    });
  } catch (error) {
    // Embeddings can target local LM Studio instances that do not require auth.
    if (/LM Studio API key is required/i.test(formatErrorMessage(error))) {
      return undefined;
    }
    throw error;
  }
}

/** Creates the LM Studio embedding provider client and preloads the target model before return. */
export async function createLmstudioEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: LmstudioEmbeddingClient }> {
  const providerConfig = options.config.models?.providers?.lmstudio;
  const providerBaseUrl = providerConfig?.baseUrl?.trim();
  const isFallbackActivation = options.fallback === "lmstudio" && options.provider !== "lmstudio";
  const remoteBaseUrl = options.remote?.baseUrl?.trim();
  const remoteApiKey = !isFallbackActivation
    ? resolveMemorySecretInputString({
        value: options.remote?.apiKey,
        path: "agents.*.memorySearch.remote.apiKey",
      })
    : undefined;
  // memorySearch.remote is shared across primary + fallback providers.
  // Ignore it during fallback activation to avoid inheriting another provider's
  // endpoint/headers/credentials when LM Studio activates as a fallback.
  const baseUrlSource = !isFallbackActivation ? remoteBaseUrl : undefined;
  const configuredBaseUrl =
    baseUrlSource && baseUrlSource.length > 0
      ? baseUrlSource
      : providerBaseUrl && providerBaseUrl.length > 0
        ? providerBaseUrl
        : undefined;
  const baseUrl = resolveLmstudioInferenceBase(configuredBaseUrl);
  const model = normalizeLmstudioModel(options.model);
  const providerHeaders = await resolveLmstudioProviderHeaders({
    config: options.config,
    env: process.env,
    headers: Object.assign(
      {},
      providerConfig?.headers,
      !isFallbackActivation ? options.remote?.headers : {},
    ),
  });
  const apiKey = hasAuthorizationHeader(providerHeaders)
    ? undefined
    : !isFallbackActivation
      ? remoteApiKey?.trim() || (await resolveLmstudioApiKey(options))
      : await resolveLmstudioApiKey(options);
  const headerOverrides = Object.assign({}, providerHeaders);
  const headers =
    buildLmstudioAuthHeaders({
      apiKey,
      json: true,
      headers: headerOverrides,
    }) ?? {};
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const client: LmstudioEmbeddingClient = {
    baseUrl,
    model,
    headers,
    ssrfPolicy,
  };

  try {
    await ensureLmstudioModelLoaded({
      baseUrl,
      apiKey,
      headers: headerOverrides,
      ssrfPolicy,
      modelKey: model,
      timeoutMs: 120_000,
    });
  } catch (error) {
    log.warn("lmstudio embeddings warmup failed; continuing without preload", {
      baseUrl,
      model,
      error: formatErrorMessage(error),
    });
  }

  return {
    provider: createRemoteEmbeddingProvider({
      id: LMSTUDIO_PROVIDER_ID,
      client,
      errorPrefix: "lmstudio embeddings failed",
    }),
    client,
  };
}
