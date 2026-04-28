import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  fetchWithSsrFGuard,
  formatErrorMessage,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { OLLAMA_CLOUD_BASE_URL } from "./defaults.js";
import { normalizeOllamaWireModelId } from "./model-id.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import { resolveOllamaApiBase } from "./provider-models.js";

export type OllamaEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

type OllamaEmbeddingOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  model: string;
  fallback?: string;
  local?: unknown;
  outputDimensionality?: number;
  taskType?: unknown;
};

export type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

type OllamaEmbeddingClientConfig = Omit<OllamaEmbeddingClient, "embedBatch">;

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

const QUERY_INSTRUCTION_TEMPLATES = [
  {
    prefix: "qwen3-embedding",
    template:
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:{query}",
  },
  {
    prefix: "nomic-embed-text",
    template: "search_query: {query}",
  },
  {
    prefix: "mxbai-embed-large",
    template: "Represent this sentence for searching relevant passages: {query}",
  },
] as const;

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: "memory-remote",
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}

function normalizeEmbeddingModel(model: string, providerId?: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_EMBEDDING_MODEL;
  }
  return normalizeOllamaWireModelId(trimmed, providerId);
}

function applyQueryInstructionTemplate(model: string, queryText: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const match = QUERY_INSTRUCTION_TEMPLATES.find(({ prefix }) =>
    normalizedModel.startsWith(prefix),
  );
  return match ? match.template.replace("{query}", () => queryText) : queryText;
}

function resolveConfiguredProvider(options: OllamaEmbeddingOptions) {
  const providers = options.config.models?.providers;
  if (!providers) {
    return undefined;
  }
  const providerId = options.provider?.trim() || "ollama";
  const direct = providers[providerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate;
    }
  }
  return providers.ollama;
}

function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  if (!hasConfiguredSecretInput(params.value)) {
    return undefined;
  }
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}

type OllamaEmbeddingBaseUrlOrigin = "remote-config" | "provider-config" | "default";
type OllamaEmbeddingSourceResolution = "unset" | "opt-out" | { apiKey: string };

type OllamaEmbeddingResolvedKeys = {
  remote: OllamaEmbeddingSourceResolution;
  provider: OllamaEmbeddingSourceResolution;
  env: string | undefined;
};

function resolveSourcedOllamaEmbeddingKey(params: {
  configString: string | undefined;
  declared: boolean;
}): OllamaEmbeddingSourceResolution {
  if (params.configString !== undefined) {
    if (!isNonSecretApiKeyMarker(params.configString)) {
      return { apiKey: params.configString };
    }
    if (!isKnownEnvApiKeyMarker(params.configString)) {
      return "opt-out";
    }
    const envKey = resolveEnvApiKey("ollama")?.apiKey;
    return envKey && !isNonSecretApiKeyMarker(envKey) ? { apiKey: envKey } : "opt-out";
  }
  if (params.declared) {
    const envKey = resolveEnvApiKey("ollama")?.apiKey;
    return envKey && !isNonSecretApiKeyMarker(envKey) ? { apiKey: envKey } : "opt-out";
  }
  return "unset";
}

function resolveOllamaEmbeddingResolvedKeys(
  options: OllamaEmbeddingOptions,
  providerConfig: ReturnType<typeof resolveConfiguredProvider>,
): OllamaEmbeddingResolvedKeys {
  const remoteValue = options.remote?.apiKey;
  const remote = resolveSourcedOllamaEmbeddingKey({
    configString: resolveMemorySecretInputString({
      value: remoteValue,
      path: "agents.*.memorySearch.remote.apiKey",
    }),
    declared: hasConfiguredSecretInput(remoteValue),
  });
  const providerValue = providerConfig?.apiKey;
  const provider = resolveSourcedOllamaEmbeddingKey({
    configString: normalizeOptionalSecretInput(providerValue),
    declared: hasConfiguredSecretInput(providerValue),
  });
  const envKey = resolveEnvApiKey("ollama")?.apiKey;
  const env = envKey && !isNonSecretApiKeyMarker(envKey) ? envKey : undefined;
  return { remote, provider, env };
}

function resolveOllamaEmbeddingBaseUrl(params: {
  remoteBaseUrl?: string;
  providerConfig: ReturnType<typeof resolveConfiguredProvider>;
}): { baseUrl: string; origin: OllamaEmbeddingBaseUrlOrigin } {
  const remoteBaseUrl = params.remoteBaseUrl?.trim();
  if (remoteBaseUrl) {
    return { baseUrl: resolveOllamaApiBase(remoteBaseUrl), origin: "remote-config" };
  }
  const providerBaseUrl = readProviderBaseUrl(params.providerConfig);
  if (providerBaseUrl) {
    return { baseUrl: resolveOllamaApiBase(providerBaseUrl), origin: "provider-config" };
  }
  return { baseUrl: resolveOllamaApiBase(undefined), origin: "default" };
}

function normalizeOllamaHostKey(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    let hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
      hostname = "127.0.0.1";
    }
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${hostname}:${port}${path}`;
  } catch {
    return undefined;
  }
}

function areOllamaHostsEquivalent(a: string, b: string): boolean {
  const aKey = normalizeOllamaHostKey(a);
  const bKey = normalizeOllamaHostKey(b);
  return aKey !== undefined && bKey !== undefined && aKey === bKey;
}

function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  return areOllamaHostsEquivalent(baseUrl, OLLAMA_CLOUD_BASE_URL);
}

function selectOllamaEmbeddingApiKey(params: {
  resolved: OllamaEmbeddingResolvedKeys;
  baseUrl: string;
  baseUrlOrigin: OllamaEmbeddingBaseUrlOrigin;
  providerOwnedHost: string;
}): string | undefined {
  if (params.resolved.remote !== "unset") {
    return typeof params.resolved.remote === "object" ? params.resolved.remote.apiKey : undefined;
  }
  const reachesProviderHost =
    params.baseUrlOrigin === "provider-config" ||
    params.baseUrlOrigin === "default" ||
    areOllamaHostsEquivalent(params.baseUrl, params.providerOwnedHost);
  if (params.resolved.provider !== "unset" && reachesProviderHost) {
    return typeof params.resolved.provider === "object"
      ? params.resolved.provider.apiKey
      : undefined;
  }
  if (params.resolved.env && isOllamaCloudBaseUrl(params.baseUrl)) {
    return params.resolved.env;
  }
  return undefined;
}

function resolveOllamaEmbeddingClient(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingClientConfig {
  const providerConfig = resolveConfiguredProvider(options);
  const { baseUrl, origin: baseUrlOrigin } = resolveOllamaEmbeddingBaseUrl({
    remoteBaseUrl: options.remote?.baseUrl,
    providerConfig,
  });
  const model = normalizeEmbeddingModel(options.model, options.provider);
  const headerOverrides = Object.assign({}, providerConfig?.headers, options.remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  const apiKey = selectOllamaEmbeddingApiKey({
    resolved: resolveOllamaEmbeddingResolvedKeys(options, providerConfig),
    baseUrl,
    baseUrlOrigin,
    providerOwnedHost: resolveOllamaApiBase(readProviderBaseUrl(providerConfig)),
  });
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    baseUrl,
    headers,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    model,
  };
}

export async function createOllamaEmbeddingProvider(
  options: OllamaEmbeddingOptions,
): Promise<{ provider: OllamaEmbeddingProvider; client: OllamaEmbeddingClient }> {
  const client = resolveOllamaEmbeddingClient(options);
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embed`;

  const embedMany = async (input: string | string[]): Promise<number[][]> => {
    const json = await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, input }),
      },
      onResponse: async (response) => {
        if (!response.ok) {
          throw new Error(`Ollama embed HTTP ${response.status}: ${await response.text()}`);
        }
        return (await response.json()) as { embeddings?: unknown };
      },
    });
    if (!Array.isArray(json.embeddings)) {
      throw new Error("Ollama embed response missing embeddings[]");
    }
    const expectedCount = Array.isArray(input) ? input.length : 1;
    if (json.embeddings.length !== expectedCount) {
      throw new Error(
        `Ollama embed response returned ${json.embeddings.length} embeddings for ${expectedCount} inputs`,
      );
    }
    return json.embeddings.map((embedding) => {
      if (!Array.isArray(embedding)) {
        throw new Error("Ollama embed response contains a non-array embedding");
      }
      return sanitizeAndNormalizeEmbedding(embedding);
    });
  };

  const embedOne = async (text: string): Promise<number[]> => {
    const [embedding] = await embedMany(text);
    if (!embedding) {
      throw new Error("Ollama embed response returned no embedding");
    }
    return embedding;
  };

  const embedQuery = async (text: string): Promise<number[]> =>
    await embedOne(applyQueryInstructionTemplate(client.model, text));

  const provider: OllamaEmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery,
    embedBatch: async (texts) => (texts.length === 0 ? [] : await embedMany(texts)),
  };

  return {
    provider,
    client: {
      ...client,
      embedBatch: async (texts) => {
        try {
          return await provider.embedBatch(texts);
        } catch (err) {
          throw new Error(formatErrorMessage(err), { cause: err });
        }
      },
    },
  };
}
