import {
  buildRemoteBaseUrlPolicy,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } from "./token.js";

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
  "Editor-Version": "vscode/1.96.2",
  "User-Agent": "GitHubCopilotChat/0.26.7",
};

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
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

function isCopilotSetupError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  // All Copilot-specific setup failures should allow auto-selection to
  // fall through to the next provider (e.g. OpenAI). This covers: missing
  // GitHub token, token exchange failures, no embedding models on the plan,
  // model discovery errors, and user-pinned model not available on Copilot.
  return (
    err.message.includes("No GitHub token available") ||
    err.message.includes("Copilot token exchange failed") ||
    err.message.includes("Copilot token response") ||
    err.message.includes("No embedding models available") ||
    err.message.includes("GitHub Copilot model discovery") ||
    err.message.includes("GitHub Copilot embedding model") ||
    err.message.includes("Unexpected response from GitHub Copilot token endpoint")
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
    auditContext: "memory-remote",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `GitHub Copilot model discovery HTTP ${response.status}: ${await response.text()}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("GitHub Copilot model discovery returned invalid JSON");
    }
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

function pickBestModel(available: string[], userModel?: string): string {
  if (userModel) {
    const normalized = userModel.trim();
    // Strip the provider prefix if users set "github-copilot/model-name".
    const stripped = normalized.startsWith(`${COPILOT_EMBEDDING_PROVIDER_ID}/`)
      ? normalized.slice(`${COPILOT_EMBEDDING_PROVIDER_ID}/`.length)
      : normalized;
    if (available.length === 0) {
      throw new Error("No embedding models available from GitHub Copilot");
    }
    if (!available.includes(stripped)) {
      throw new Error(
        `GitHub Copilot embedding model "${stripped}" is not available. Available: ${available.join(", ")}`,
      );
    }
    return stripped;
  }
  for (const preferred of PREFERRED_MODELS) {
    if (available.includes(preferred)) {
      return preferred;
    }
  }
  if (available.length > 0) {
    return available[0];
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
  const token = await resolveCopilotApiToken({
    githubToken: client.githubToken,
    env: client.env,
    fetchImpl: client.fetchImpl,
  });
  const baseUrl = client.baseUrl?.trim() || token.baseUrl || DEFAULT_COPILOT_API_BASE_URL;
  return {
    baseUrl,
    headers: {
      ...COPILOT_HEADERS_STATIC,
      ...client.headers,
      Authorization: `Bearer ${token.token}`,
    },
  };
}

async function createGitHubCopilotEmbeddingProvider(
  client: GitHubCopilotEmbeddingClient,
): Promise<{ provider: MemoryEmbeddingProvider; client: GitHubCopilotEmbeddingClient }> {
  const initialSession = await resolveGitHubCopilotEmbeddingSession(client);

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }

    const session = await resolveGitHubCopilotEmbeddingSession(client);
    const url = `${session.baseUrl.replace(/\/$/, "")}/embeddings`;
    return await withRemoteHttpResponse({
      url,
      fetchImpl: client.fetchImpl,
      ssrfPolicy: buildRemoteBaseUrlPolicy(session.baseUrl),
      init: {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify({ model: client.model, input }),
      },
      onResponse: async (response) => {
        if (!response.ok) {
          throw new Error(
            `GitHub Copilot embeddings HTTP ${response.status}: ${await response.text()}`,
          );
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("GitHub Copilot embeddings returned invalid JSON");
        }
        return parseGitHubCopilotEmbeddingPayload(payload, input.length);
      },
    });
  };

  return {
    provider: {
      id: COPILOT_EMBEDDING_PROVIDER_ID,
      model: client.model,
      embedQuery: async (text) => {
        const [vector] = await embed([text]);
        return vector ?? [];
      },
      embedBatch: embed,
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
  autoSelectPriority: 15,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: (err: unknown) => isCopilotSetupError(err),
  create: async (options) => {
    const remoteGithubToken = await resolveConfiguredSecretInputString({
      config: options.config,
      env: process.env,
      value: options.remote?.apiKey,
      path: "agents.*.memorySearch.remote.apiKey",
    });
    const { githubToken: profileGithubToken } = await resolveFirstGithubToken({
      agentDir: options.agentDir,
      config: options.config,
      env: process.env,
    });
    const githubToken = remoteGithubToken.value || profileGithubToken;
    if (!githubToken) {
      throw new Error("No GitHub token available for Copilot embedding provider");
    }

    const { token: copilotToken, baseUrl: resolvedBaseUrl } = await resolveCopilotApiToken({
      githubToken,
      env: process.env,
    });
    const baseUrl =
      options.remote?.baseUrl?.trim() || resolvedBaseUrl || DEFAULT_COPILOT_API_BASE_URL;
    const ssrfPolicy = buildSsrfPolicy(baseUrl);

    // Always discover models even when the user pins one: this validates
    // the Copilot token and confirms the plan supports embeddings before
    // we attempt any embedding requests.
    const availableModels = await discoverEmbeddingModels({
      baseUrl,
      copilotToken,
      headers: options.remote?.headers,
      ssrfPolicy,
    });

    const userModel = options.model?.trim() || undefined;
    const model = pickBestModel(availableModels, userModel);

    const { provider } = await createGitHubCopilotEmbeddingProvider({
      baseUrl,
      env: process.env,
      fetchImpl: fetch,
      githubToken,
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
