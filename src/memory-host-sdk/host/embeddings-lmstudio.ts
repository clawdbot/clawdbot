import { formatErrorMessage } from "../../infra/errors.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildLmstudioAuthHeaders,
  ensureLmstudioModelLoaded,
  LMSTUDIO_DEFAULT_EMBEDDING_MODEL,
  LMSTUDIO_PROVIDER_ID,
  resolveLmstudioInferenceBase,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
} from "../../plugin-sdk/lmstudio-runtime.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import { createRemoteEmbeddingProvider } from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

const log = createSubsystemLogger("memory/embeddings");

export type LmstudioEmbeddingClient = {
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
  options: EmbeddingProviderOptions,
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
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: LmstudioEmbeddingClient }> {
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
