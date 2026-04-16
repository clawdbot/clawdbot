import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "../../agents/github-copilot-token.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import type { EmbeddingProvider } from "./embeddings.types.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";

export type GitHubCopilotEmbeddingClient = {
  githubToken: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

const COPILOT_EMBEDDING_PROVIDER_ID = "github-copilot";

const COPILOT_HEADERS_STATIC: Record<string, string> = {
  "Content-Type": "application/json",
  "Editor-Version": "vscode/1.96.2",
  "User-Agent": "GitHubCopilotChat/0.26.7",
};

function resolveConfiguredBaseUrl(
  configuredBaseUrl: string | undefined,
  tokenBaseUrl: string | undefined,
): string {
  const trimmed = configuredBaseUrl?.trim();
  if (trimmed) {
    return trimmed;
  }
  return tokenBaseUrl || DEFAULT_COPILOT_API_BASE_URL;
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
  const baseUrl = resolveConfiguredBaseUrl(client.baseUrl, token.baseUrl);
  return {
    baseUrl,
    headers: {
      ...COPILOT_HEADERS_STATIC,
      ...client.headers,
      Authorization: `Bearer ${token.token}`,
    },
  };
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

export async function createGitHubCopilotEmbeddingProvider(
  client: GitHubCopilotEmbeddingClient,
): Promise<{ provider: EmbeddingProvider; client: GitHubCopilotEmbeddingClient }> {
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
