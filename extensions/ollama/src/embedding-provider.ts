import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalSecretInput } from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
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
const OLLAMA_EMBEDDING_BATCH_CONCURRENCY = 1;

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

function normalizeEmbeddingModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_EMBEDDING_MODEL;
  }
  return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
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

function resolveOllamaApiKey(options: OllamaEmbeddingOptions): string | undefined {
  const remoteApiKey = resolveMemorySecretInputString({
    value: options.remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  if (remoteApiKey) {
    return remoteApiKey;
  }
  const providerApiKey = normalizeOptionalSecretInput(
    options.config.models?.providers?.ollama?.apiKey,
  );
  if (providerApiKey) {
    return providerApiKey;
  }
  return resolveEnvApiKey("ollama")?.apiKey;
}

function resolveOllamaEmbeddingClient(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingClientConfig {
  const providerConfig = options.config.models?.providers?.ollama;
  const rawBaseUrl = options.remote?.baseUrl?.trim() || providerConfig?.baseUrl?.trim();
  const baseUrl = resolveOllamaApiBase(rawBaseUrl);
  const model = normalizeEmbeddingModel(options.model);
  const headerOverrides = Object.assign({}, providerConfig?.headers, options.remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  const apiKey = resolveOllamaApiKey(options);
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
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embeddings`;

  const embedOne = async (text: string): Promise<number[]> => {
    const json = await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, prompt: text }),
      },
      onResponse: async (response) => {
        if (!response.ok) {
          throw new Error(`Ollama embeddings HTTP ${response.status}: ${await response.text()}`);
        }
        return (await response.json()) as { embedding?: number[] };
      },
    });
    if (!Array.isArray(json.embedding)) {
      throw new Error("Ollama embeddings response missing embedding[]");
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  const provider: OllamaEmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: embedOne,
    embedBatch: async (texts) => {
      const embeddings: number[][] = [];
      for (let index = 0; index < texts.length; index += OLLAMA_EMBEDDING_BATCH_CONCURRENCY) {
        const batch = texts.slice(index, index + OLLAMA_EMBEDDING_BATCH_CONCURRENCY);
        embeddings.push(...(await Promise.all(batch.map(embedOne))));
      }
      return embeddings;
    },
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
