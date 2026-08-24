// Google provider module implements model/runtime integration.
import {
  buildRemoteBaseUrlPolicy,
  debugEmbeddingsLog,
  embeddingProviderOwnsDestination,
  resolveEmbeddingEndpointUrl,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type EmbeddingInput,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
  requireApiKey,
  resolveApiKeyForProvider,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderHttpError,
  providerOperationRetryConfig,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { resolveGoogleApiClientHeaders } from "./google-api-client-header.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
};

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "gemini-embedding-001": 2048,
  "gemini-embedding-2": 8192,
  "gemini-embedding-2-preview": 8192,
};

type GeminiTaskType = NonNullable<MemoryEmbeddingProviderCreateOptions["taskType"]>;

// --- Gemini Embedding 2 support ---

const GEMINI_EMBEDDING_2_MODELS = new Set(["gemini-embedding-2", "gemini-embedding-2-preview"]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [768, 1536, 3072] as const;
const GEMINI_EMBEDDING_2_TASK_PREFIXES: Record<GeminiTaskType, string> = {
  RETRIEVAL_QUERY: "task: search result | query:",
  RETRIEVAL_DOCUMENT: "title: none | text:",
  SEMANTIC_SIMILARITY: "task: sentence similarity | query:",
  CLASSIFICATION: "task: classification | query:",
  CLUSTERING: "task: clustering | query:",
  QUESTION_ANSWERING: "task: question answering | query:",
  FACT_VERIFICATION: "task: fact checking | query:",
};

type GeminiTextPart = { text: string };
type GeminiInlinePart = {
  inlineData: { mimeType: string; data: string };
};
type GeminiPart = GeminiTextPart | GeminiInlinePart;
type GeminiEmbeddingInputPart = NonNullable<EmbeddingInput["parts"]>[number];
type GeminiEmbeddingRequest = {
  content: { parts: GeminiPart[] };
  taskType?: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};
export type GeminiTextEmbeddingRequest = GeminiEmbeddingRequest;

function malformedGeminiEmbeddingResponse(): Error {
  return new Error("gemini embeddings failed: malformed JSON response");
}

function unexpectedGeminiEmbeddingDimensions(expected: number, actual: number): Error {
  return new Error(`gemini embeddings failed: expected ${expected} dimensions, received ${actual}`);
}

function readGeminiEmbeddingValues(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw malformedGeminiEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedGeminiEmbeddingResponse();
    }
  }
  return value;
}

function readGeminiSingleEmbedding(payload: Record<string, unknown>): number[] {
  const embedding = asOptionalRecord(payload.embedding);
  if (!embedding) {
    throw malformedGeminiEmbeddingResponse();
  }
  return readGeminiEmbeddingValues(embedding.values);
}

function readGeminiBatchEmbeddings(
  payload: Record<string, unknown>,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== expectedCount) {
    throw malformedGeminiEmbeddingResponse();
  }
  return payload.embeddings.map((entry) => {
    const embedding = asOptionalRecord(entry);
    if (!embedding) {
      throw malformedGeminiEmbeddingResponse();
    }
    return readGeminiEmbeddingValues(embedding.values);
  });
}

export function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  model: string;
  role: "query" | "document";
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiEmbeddingRequest {
  const parts = params.input.parts?.map((part: GeminiEmbeddingInputPart) =>
    part.type === "text"
      ? ({ text: part.text } satisfies GeminiTextPart)
      : ({
          inlineData: { mimeType: part.mimeType, data: part.data },
        } satisfies GeminiInlinePart),
  ) ?? [{ text: params.input.text }];
  const isStableEmbedding2 = normalizeGeminiModel(params.model) === "gemini-embedding-2";
  const request: GeminiEmbeddingRequest = { content: { parts } };
  if (isStableEmbedding2 && parts.every((part) => "text" in part)) {
    const first = parts[0];
    if (first && "text" in first) {
      const taskType =
        params.role === "document" &&
        (params.taskType === "RETRIEVAL_QUERY" ||
          params.taskType === "QUESTION_ANSWERING" ||
          params.taskType === "FACT_VERIFICATION")
          ? "RETRIEVAL_DOCUMENT"
          : params.taskType;
      first.text = `${GEMINI_EMBEDDING_2_TASK_PREFIXES[taskType]} ${first.text}`;
    }
  } else if (!isStableEmbedding2) {
    request.taskType = params.taskType;
  }
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(normalizeGeminiModel(model));
}

/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
function resolveGeminiOutputDimensionality(model: string, requested?: number): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
  }
  const valid: readonly number[] = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}
function resolveRemoteApiKey(remoteApiKey: unknown): string | undefined {
  return resolveMemorySecretInputString({
    value: remoteApiKey,
    path: "memory.search.remote.apiKey",
  });
}

function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) {
    return withoutPrefix.slice("gemini/".length);
  }
  if (withoutPrefix.startsWith("google/")) {
    return withoutPrefix.slice("google/".length);
  }
  return withoutPrefix;
}

export function sanitizeGeminiEmbedding(values: number[], expectedDimensions?: number): number[] {
  if (expectedDimensions != null && values.length !== expectedDimensions) {
    throw unexpectedGeminiEmbeddingDimensions(expectedDimensions, values.length);
  }
  return sanitizeAndNormalizeEmbedding(values);
}

async function fetchGeminiEmbeddingPayload(params: {
  client: GeminiEmbeddingClient;
  endpoint: string;
  body: unknown;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await executeWithApiKeyRotation({
    provider: "google",
    apiKeys: params.client.apiKeys,
    transientRetry: providerOperationRetryConfig("read"),
    execute: async (apiKey) => {
      const authHeaders = parseGeminiAuth(apiKey);
      const headers = {
        ...authHeaders.headers,
        ...params.client.headers,
      };
      return await withRemoteHttpResponse({
        url: params.endpoint,
        ssrfPolicy: params.client.ssrfPolicy,
        signal: params.signal,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(params.body),
        },
        onResponse: async (res) => {
          if (!res.ok) {
            throw await createProviderHttpError(res, "gemini embeddings failed");
          }
          return await readProviderJsonObjectResponse(res, "gemini embeddings failed");
        },
      });
    },
  });
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex > -1) {
    const queryIndex = trimmed.indexOf("?", openAiIndex);
    return normalizeGoogleApiBaseUrl(
      `${trimmed.slice(0, openAiIndex)}${queryIndex < 0 ? "" : trimmed.slice(queryIndex)}`,
    );
  }
  return normalizeGoogleApiBaseUrl(trimmed);
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function normalizeGoogleApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_GOOGLE_API_BASE_URL;
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    if (
      url.origin.toLowerCase() === "https://generativelanguage.googleapis.com" &&
      url.pathname.replace(/\/+$/, "") === ""
    ) {
      url.pathname = "/v1beta";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export async function createGeminiEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = await resolveGeminiEmbeddingClient(options);
  const embedUrl = resolveEmbeddingEndpointUrl(client.baseUrl, `${client.modelPath}:embedContent`);
  const batchUrl = resolveEmbeddingEndpointUrl(
    client.baseUrl,
    `${client.modelPath}:batchEmbedContents`,
  );
  const isV2 = isGeminiEmbedding2Model(client.model);
  const outputDimensionality = client.outputDimensionality;

  const embedQuery = async (
    text: string,
    callOptions?: { signal?: AbortSignal },
  ): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: embedUrl,
      body: buildGeminiEmbeddingRequest({
        input: { text },
        model: client.model,
        role: "query",
        taskType: options.taskType ?? "RETRIEVAL_QUERY",
        outputDimensionality: isV2 ? outputDimensionality : undefined,
      }),
      signal: callOptions?.signal,
    });
    return sanitizeGeminiEmbedding(
      readGeminiSingleEmbedding(payload),
      isV2 ? outputDimensionality : undefined,
    );
  };

  const embedBatchInputs = async (
    inputs: EmbeddingInput[],
    callOptions?: { signal?: AbortSignal },
  ): Promise<number[][]> => {
    if (inputs.length === 0) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: batchUrl,
      body: {
        requests: inputs.map((input) =>
          buildGeminiEmbeddingRequest({
            input,
            model: client.model,
            role: "document",
            modelPath: client.modelPath,
            taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
            outputDimensionality: isV2 ? outputDimensionality : undefined,
          }),
        ),
      },
      signal: callOptions?.signal,
    });
    const embeddings = readGeminiBatchEmbeddings(payload, inputs.length);
    return embeddings.map((values) =>
      sanitizeGeminiEmbedding(values, isV2 ? outputDimensionality : undefined),
    );
  };

  const embedBatch = async (
    texts: string[],
    optionsLocal?: { signal?: AbortSignal },
  ): Promise<number[][]> => {
    return await embedBatchInputs(
      texts.map((text) => ({
        text,
      })),
      optionsLocal,
    );
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      embedQuery,
      embedBatch,
      embedBatchInputs,
    },
    client,
  };
}

async function resolveGeminiEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<GeminiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = resolveRemoteApiKey(remote?.apiKey);
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const providerConfig = options.config.models?.providers?.google;
  const providerBaseUrl = normalizeGeminiBaseUrl(
    normalizeOptionalString(providerConfig?.baseUrl) || DEFAULT_GOOGLE_API_BASE_URL,
  );
  const rawBaseUrl = remoteBaseUrl || providerBaseUrl;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const providerOwnsDestination = embeddingProviderOwnsDestination({
    baseUrl,
    providerBaseUrl,
  });
  const apiKey = remoteApiKey
    ? remoteApiKey
    : providerOwnsDestination
      ? requireApiKey(
          await resolveApiKeyForProvider({
            provider: "google",
            cfg: options.config,
            agentDir: options.agentDir,
          }),
          "google",
        )
      : undefined;
  if (!apiKey) {
    throw new Error(
      `Google embedding credentials are not configured for ${baseUrl}. Set memory.search.remote.apiKey for this destination.`,
    );
  }

  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const headerOverrides = Object.assign(
    {},
    providerOwnsDestination ? providerConfig?.headers : undefined,
    remote?.headers,
  );
  const headers: Record<string, string> = {
    ...headerOverrides,
    ...resolveGoogleApiClientHeaders({
      baseUrl,
      api: "google-generative-ai",
      capability: "other",
      transport: "http",
    }),
  };
  const apiKeys = remoteApiKey
    ? [apiKey]
    : collectProviderApiKeysForExecution({
        provider: "google",
        primaryApiKey: apiKey,
      });
  const model = normalizeGeminiModel(options.model);
  const modelPath = buildGeminiModelPath(model);
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  debugEmbeddingsLog("memory embeddings: gemini client", {
    rawBaseUrl,
    baseUrl,
    model,
    modelPath,
    outputDimensionality,
    embedEndpoint: resolveEmbeddingEndpointUrl(baseUrl, `${modelPath}:embedContent`),
    batchEndpoint: resolveEmbeddingEndpointUrl(baseUrl, `${modelPath}:batchEmbedContents`),
  });
  return { baseUrl, headers, ssrfPolicy, model, modelPath, apiKeys, outputDimensionality };
}
