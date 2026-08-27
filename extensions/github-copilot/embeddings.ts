// Github Copilot plugin module implements embeddings behavior.
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  buildRemoteBaseUrlPolicy,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { resolveGithubCopilotDomain } from "./domain.js";
import { COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS } from "./models.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { COPILOT_RUNTIME_INTEGRATION_ID } from "./runtime-identity.js";

const COPILOT_EMBEDDING_PROVIDER_ID = "github-copilot";

/**
 * Preferred embedding models in order. The first available model wins.
 */
const PREFERRED_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
] as const;

const COPILOT_HEADERS_STATIC: Record<string, string> = {
  "Content-Type": "application/json",
  ...buildCopilotIdeHeaders(),
  "Copilot-Integration-Id": COPILOT_RUNTIME_INTEGRATION_ID,
};
const COPILOT_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const COPILOT_EMBEDDINGS_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

function buildSsrfPolicy(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

type CopilotModelEntry = {
  id?: unknown;
  supported_endpoints?: unknown;
};

type GitHubCopilotEmbeddingClient = {
  githubToken: string;
  model: string;
  runtimeAuth?: { apiKey: string; baseUrl: string };
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  githubDomain?: string;
};

function isCopilotSetupError(err: unknown): boolean {
  if (err instanceof CopilotRuntimeAuthError) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  // All Copilot-specific setup failures should allow auto-selection to
  // fall through to the next provider (e.g. OpenAI). This covers: missing
  // GitHub token, authentication failures, no embedding models on the plan,
  // model discovery errors, and user-pinned model not available on Copilot.
  return (
    err.message.includes("No GitHub token available") ||
    err.message.includes("Copilot user response") ||
    err.message.includes("No embedding models available") ||
    err.message.includes("GitHub Copilot model discovery") ||
    err.message.includes("github-copilot.model-discovery") ||
    err.message.includes("GitHub Copilot embedding model") ||
    err.message.includes("Unexpected response from GitHub Copilot user endpoint")
  );
}

async function discoverEmbeddingModels(params: {
  baseUrl: string;
  copilotToken: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
}): Promise<string[]> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/models`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        ...COPILOT_HEADERS_STATIC,
        ...params.headers,
        Authorization: `Bearer ${params.copilotToken}`,
      },
    },
    policy: params.ssrfPolicy,
    timeoutMs: COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS,
    auditContext: "memory-remote",
  });
  try {
    if (!response.ok) {
      // Copilot requests carry a bearer token, so reflected upstream text must
      // be sanitized independently of the operator's log-redaction setting.
      const detail = redactToolPayloadText(
        await readResponseTextLimited(response, COPILOT_ERROR_BODY_LIMIT_BYTES),
      );
      throw new Error(`GitHub Copilot model discovery HTTP ${response.status}: ${detail}`);
    }
    const payload = await readProviderJsonResponse(response, "github-copilot.model-discovery");
    const allModels = Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: CopilotModelEntry[] }).data ?? [])
      : [];
    // Filter for embedding models. The Copilot API may list embedding models
    // with an explicit /v1/embeddings endpoint, or with an empty
    // supported_endpoints array. Match both: endpoint-declared embedding
    // models and models whose ID indicates embedding capability.
    return allModels.flatMap((entry) => {
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id) {
        return [];
      }
      const endpoints = Array.isArray(entry.supported_endpoints)
        ? entry.supported_endpoints.filter((value): value is string => typeof value === "string")
        : [];
      return endpoints.some((ep) => ep.includes("embeddings")) || /\bembedding/i.test(id)
        ? [id]
        : [];
    });
  } finally {
    await release();
  }
}

function normalizeCopilotEmbeddingModel(model: string): string {
  const normalized = model.trim();
  const prefix = `${COPILOT_EMBEDDING_PROVIDER_ID}/`;
  const stripped = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  // Keep invalid selections explicit and normalization idempotent across
  // cold memory options and direct provider creation.
  return stripped && stripped === stripped.trim() && !stripped.startsWith(prefix)
    ? stripped
    : normalized;
}

function pickBestModel(available: string[], userModel?: string): string {
  if (userModel) {
    const normalized = normalizeCopilotEmbeddingModel(userModel);
    if (available.length === 0) {
      throw new Error("No embedding models available from GitHub Copilot");
    }
    if (!available.includes(normalized)) {
      throw new Error(
        `GitHub Copilot embedding model "${normalized}" is not available. Available: ${available.join(", ")}`,
      );
    }
    return normalized;
  }
  for (const preferred of PREFERRED_MODELS) {
    if (available.includes(preferred)) {
      return preferred;
    }
  }
  const [firstAvailable] = available;
  if (firstAvailable) {
    return firstAvailable;
  }
  throw new Error("No embedding models available from GitHub Copilot");
}

function parseGitHubCopilotEmbeddingPayload(payload: unknown, expectedCount: number): number[][] {
  if (!payload || typeof payload !== "object") {
    throw new Error("GitHub Copilot embeddings response missing data[]");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("GitHub Copilot embeddings response missing data[]");
  }

  const vectors = Array.from<number[] | undefined>({ length: expectedCount });
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      throw new Error("GitHub Copilot embeddings response contains an invalid entry");
    }
    const indexValue = (entry as { index?: unknown }).index;
    const embedding = (entry as { embedding?: unknown }).embedding;
    const index = typeof indexValue === "number" ? indexValue : Number.NaN;
    if (!Number.isInteger(index)) {
      throw new Error("GitHub Copilot embeddings response contains an invalid index");
    }
    if (index < 0 || index >= expectedCount) {
      throw new Error("GitHub Copilot embeddings response contains an out-of-range index");
    }
    if (vectors[index] !== undefined) {
      throw new Error("GitHub Copilot embeddings response contains duplicate indexes");
    }
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
      throw new Error("GitHub Copilot embeddings response contains an invalid embedding");
    }
    vectors[index] = sanitizeAndNormalizeEmbedding(embedding);
  }

  for (let index = 0; index < expectedCount; index += 1) {
    if (vectors[index] === undefined) {
      throw new Error("GitHub Copilot embeddings response missing vectors for some inputs");
    }
  }
  return vectors as number[][];
}

async function resolveGitHubCopilotEmbeddingSession(client: GitHubCopilotEmbeddingClient): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const auth =
    client.runtimeAuth ??
    (await resolveCopilotRuntimeAuth({
      githubToken: client.githubToken,
      env: client.env,
      fetchImpl: client.fetchImpl,
      githubDomain: client.githubDomain,
    }));
  const baseUrl = client.baseUrl?.trim() || auth.baseUrl || DEFAULT_COPILOT_API_BASE_URL;
  return {
    baseUrl,
    headers: {
      ...COPILOT_HEADERS_STATIC,
      ...client.headers,
      Authorization: `Bearer ${auth.apiKey}`,
    },
  };
}

async function createGitHubCopilotEmbeddingProvider(
  client: GitHubCopilotEmbeddingClient,
): Promise<{ provider: MemoryEmbeddingProvider; client: GitHubCopilotEmbeddingClient }> {
  const initialSession = await resolveGitHubCopilotEmbeddingSession(client);

  const embedMany = async (input: string[], signal?: AbortSignal): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }

    const url = `${initialSession.baseUrl.replace(/\/$/, "")}/embeddings`;
    return await withRemoteHttpResponse({
      url,
      fetchImpl: client.fetchImpl,
      ssrfPolicy: buildRemoteBaseUrlPolicy(initialSession.baseUrl),
      signal,
      init: {
        method: "POST",
        headers: initialSession.headers,
        body: JSON.stringify({ model: client.model, input }),
      },
      onResponse: async (response) => {
        if (!response.ok) {
          const detail = redactToolPayloadText(
            await readResponseTextLimited(response, COPILOT_ERROR_BODY_LIMIT_BYTES),
          );
          throw new Error(`GitHub Copilot embeddings HTTP ${response.status}: ${detail}`);
        }

        const payload = await readProviderJsonResponse(response, "github-copilot.embeddings", {
          maxBytes: COPILOT_EMBEDDINGS_RESPONSE_MAX_BYTES,
        });
        return parseGitHubCopilotEmbeddingPayload(payload, input.length);
      },
    });
  };

  return {
    provider: {
      id: COPILOT_EMBEDDING_PROVIDER_ID,
      model: client.model,
      embed: async (input, options) => {
        const [vector] = await embedMany(
          [typeof input === "string" ? input : input.text],
          options?.signal,
        );
        return vector ?? [];
      },
      embedBatch: async (inputs, options) => {
        const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
        if (options?.inputType === "query") {
          return await Promise.all(
            texts.map(async (text) => (await embedMany([text], options.signal))[0] ?? []),
          );
        }
        return await embedMany(texts, options?.signal);
      },
    },
    client: {
      ...client,
      baseUrl: initialSession.baseUrl,
    },
  };
}

export const githubCopilotMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: COPILOT_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  authProviderId: COPILOT_EMBEDDING_PROVIDER_ID,
  normalizeModel: ({ model }) => normalizeCopilotEmbeddingModel(model),
  autoSelectPriority: 15,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: (err: unknown) => isCopilotSetupError(err),
  create: async (options) => {
    const explicitValue = normalizeResolvedSecretInputString({
      value: options.remote?.apiKey,
      path: "memory.search.remote.apiKey",
    });
    const customBaseUrl = options.remote?.baseUrl?.trim();
    const customRuntimeAuth = customBaseUrl
      ? (() => {
          if (!explicitValue) {
            throw new Error(
              "GitHub Copilot memory custom baseUrl requires an explicit memory.search.remote.apiKey",
            );
          }
          return { apiKey: explicitValue, baseUrl: customBaseUrl };
        })()
      : undefined;
    const profileAuth = explicitValue
      ? undefined
      : await resolveFirstGithubToken({
          agentDir: options.agentDir,
          config: options.config,
          env: process.env,
        });
    const value = explicitValue ?? profileAuth?.githubToken;
    if (!value) {
      throw new Error("No GitHub token available for Copilot embedding provider");
    }

    const githubDomain = resolveGithubCopilotDomain({
      env: process.env,
      explicit: profileAuth?.githubDomain,
      config: options.config,
    });
    // A custom endpoint owns its own explicit credential. Never resolve a
    // durable GitHub token and then forward it to an operator-supplied host.
    const runtimeAuth =
      customRuntimeAuth ??
      (await resolveCopilotRuntimeAuth({
        githubToken: value,
        env: process.env,
        githubDomain,
      }));
    const baseUrl = runtimeAuth.baseUrl || DEFAULT_COPILOT_API_BASE_URL;
    const ssrfPolicy = buildSsrfPolicy(baseUrl);

    // Always discover models even when the user pins one: this validates
    // the Copilot token and confirms the plan supports embeddings before
    // we attempt any embedding requests.
    const availableModels = await discoverEmbeddingModels({
      baseUrl,
      copilotToken: runtimeAuth.apiKey,
      headers: options.remote?.headers,
      ssrfPolicy,
    });

    const userModel = options.model?.trim() || undefined;
    const model = pickBestModel(availableModels, userModel);

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      baseUrl,
      env: process.env,
      fetchImpl: fetch,
      githubToken: value,
      runtimeAuth,
      githubDomain,
      headers: options.remote?.headers,
      model,
    });

    return {
      provider,
      runtime: {
        id: COPILOT_EMBEDDING_PROVIDER_ID,
        cacheKeyData: {
          provider: COPILOT_EMBEDDING_PROVIDER_ID,
          baseUrl,
          model,
        },
      },
    };
  },
};
