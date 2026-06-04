// Builds OpenAI-compatible embedding provider entries for plugins.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname, type SsrFPolicy } from "../infra/net/ssrf.js";
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
} from "./embedding-provider-types.js";

/** Provider id for OpenAI-compatible remote embedding servers. */
export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

/** Normalized OpenAI-compatible embedding client configuration. */
export type OpenAICompatibleEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  dimensions?: number;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
};

type OpenAICompatibleEmbeddingResponse = {
  data?: unknown;
};

type ConfiguredEmbeddingProvider = {
  api?: string;
  baseUrl?: string;
  apiKey?: unknown;
  headers?: Record<string, unknown>;
};

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) {
    throw new Error(
      "openai-compatible embeddings: missing remote.baseUrl. Set it to your OpenAI-compatible embeddings server, for example http://127.0.0.1:11434/v1.",
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

function normalizeModel(value: string | undefined, providerId: string | undefined): string {
  const model = value?.trim();
  if (!model) {
    throw new Error(
      "openai-compatible embeddings: missing model. Set it to the embedding model id your server expects.",
    );
  }
  const prefixes = new Set(
    [
      providerId?.trim(),
      normalizeProviderId(providerId ?? ""),
      OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
    ]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => `${prefix}/`),
  );
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

function normalizeDimensions(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("openai-compatible embeddings: dimensions must be a positive integer.");
  }
  return value;
}

function normalizeOptionalInputType(value: string | undefined): string | undefined {
  const inputType = value?.trim();
  return inputType ? inputType : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function chooseSecretInputOverride<T>(
  override: T | undefined,
  fallback: T | undefined,
): T | undefined {
  if (typeof override === "string") {
    return override.trim() ? override : fallback;
  }
  return override ?? fallback;
}

function resolveRequestInputType(
  client: OpenAICompatibleEmbeddingClient,
  kind: EmbeddingProviderCallOptions["inputType"] | undefined,
): string | undefined {
  if (kind === "query") {
    return client.queryInputType ?? client.inputType;
  }
  if (kind === "document") {
    return client.documentInputType ?? client.inputType;
  }
  return client.inputType;
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

async function buildHeaders(params: {
  config: EmbeddingProviderCreateOptions["config"];
  apiKey: string | undefined;
  extra: Record<string, unknown> | undefined;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  for (const [name, rawValue] of Object.entries(params.extra ?? {})) {
    const normalizedName = normalizeHeaderName(name);
    if (!normalizedName || normalizedName === "authorization") {
      continue;
    }
    const value = await resolveSecretString({
      config: params.config,
      value: rawValue,
      path: `models.providers.*.headers.${normalizedName}`,
    });
    if (!value) {
      continue;
    }
    headers[normalizedName] = value;
  }
  if (params.apiKey) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }
  return headers;
}

function isSensitiveHeaderName(name: string): boolean {
  return (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name.includes("api-key") ||
    name.includes("token") ||
    name.includes("secret")
  );
}

function sanitizeCacheHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
  return Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined;
}

async function resolveSecretString(params: {
  config: EmbeddingProviderCreateOptions["config"];
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: process.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    throw new Error(resolved.unresolvedRefReason);
  }
  return normalizeSecretInputString(resolved.value);
}

async function resolveRemoteApiKey(
  config: EmbeddingProviderCreateOptions["config"],
  value: unknown,
): Promise<string | undefined> {
  return await resolveSecretString({
    config,
    value,
    path: "agents.*.memorySearch.remote.apiKey",
  });
}

function isOpenAICompatibleProviderConfig(
  id: string,
  provider: ConfiguredEmbeddingProvider,
): boolean {
  return (
    normalizeProviderId(id) === OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID ||
    OPENAI_COMPATIBLE_MODEL_APIS.has(normalizeProviderId(provider.api ?? "")) ||
    (!provider.api && typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0)
  );
}

function resolveConfiguredProvider(
  options: EmbeddingProviderCreateOptions,
): ConfiguredEmbeddingProvider | undefined {
  const providers = options.config.models?.providers as
    | Record<string, ConfiguredEmbeddingProvider>
    | undefined;
  if (!providers) {
    return undefined;
  }
  const providerId = options.provider?.trim() || OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  const normalizedProviderId = normalizeProviderId(providerId);
  const entry =
    providers[providerId] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalizedProviderId,
    )?.[1];
  return entry && isOpenAICompatibleProviderConfig(providerId, entry) ? entry : undefined;
}

function embeddingInputToText(input: EmbeddingInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input.parts || input.parts.length === 0) {
    return input.text;
  }
  const textParts: string[] = [];
  for (const part of input.parts) {
    if (part.type !== "text") {
      throw new Error("openai-compatible embeddings only support text embedding inputs.");
    }
    textParts.push(part.text);
  }
  return textParts.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function malformedEmbeddingResponse(): Error {
  return new Error("openai-compatible embeddings failed: malformed JSON response");
}

function readEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw malformedEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedEmbeddingResponse();
    }
  }
  return value;
}

function readEmbeddingVectors(
  payload: OpenAICompatibleEmbeddingResponse,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw malformedEmbeddingResponse();
  }
  return payload.data.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      throw malformedEmbeddingResponse();
    }
    return readEmbeddingVector(record.embedding);
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new Error("openai-compatible embeddings failed: malformed JSON response", { cause });
  }
}

async function postEmbeddingRequest(params: {
  client: OpenAICompatibleEmbeddingClient;
  input: string[];
  signal?: AbortSignal;
  inputType?: EmbeddingProviderCallOptions["inputType"];
}): Promise<number[][]> {
  const { client, input } = params;
  const inputType = resolveRequestInputType(client, params.inputType);
  const body = {
    model: client.model,
    input,
    ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
    ...(inputType ? { input_type: inputType } : {}),
  };
  const { response, release } = await fetchWithSsrFGuard({
    url: `${client.baseUrl}/embeddings`,
    init: {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify(body),
    },
    signal: params.signal,
    policy: client.ssrfPolicy,
    auditContext: "embedding-provider:openai-compatible",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `openai-compatible embeddings failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return readEmbeddingVectors(
      (await readJsonResponse(response)) as OpenAICompatibleEmbeddingResponse,
      input.length,
    );
  } finally {
    await release();
  }
}

/** Creates a normalized OpenAI-compatible embedding client from runtime config. */
export async function createOpenAICompatibleEmbeddingClient(
  options: EmbeddingProviderCreateOptions,
): Promise<OpenAICompatibleEmbeddingClient> {
  const configuredProvider = resolveConfiguredProvider(options);
  const baseUrl = normalizeBaseUrl(
    normalizeOptionalString(options.remote?.baseUrl) ?? configuredProvider?.baseUrl,
  );
  const model = normalizeModel(options.model, options.provider);
  const apiKey = await resolveRemoteApiKey(
    options.config,
    chooseSecretInputOverride(options.remote?.apiKey, configuredProvider?.apiKey),
  );
  const inputType = normalizeOptionalInputType(options.inputType);
  const queryInputType = normalizeOptionalInputType(options.queryInputType);
  const documentInputType = normalizeOptionalInputType(options.documentInputType);
  return {
    baseUrl,
    headers: await buildHeaders({
      config: options.config,
      apiKey,
      extra: {
        ...configuredProvider?.headers,
        ...options.remote?.headers,
      },
    }),
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    model,
    ...(options.dimensions !== undefined
      ? { dimensions: normalizeDimensions(options.dimensions) }
      : {}),
    ...(inputType ? { inputType } : {}),
    ...(queryInputType ? { queryInputType } : {}),
    ...(documentInputType ? { documentInputType } : {}),
  };
}

/** Creates an OpenAI-compatible embedding provider and its backing client. */
export async function createOpenAICompatibleEmbeddingProvider(
  options: EmbeddingProviderCreateOptions,
): Promise<{
  provider: EmbeddingProvider;
  client: OpenAICompatibleEmbeddingClient;
}> {
  const client = await createOpenAICompatibleEmbeddingClient(options);
  const embedBatch: EmbeddingProvider["embedBatch"] = async (inputs, callOptions) => {
    if (inputs.length === 0) {
      return [];
    }
    return await postEmbeddingRequest({
      client,
      input: inputs.map(embeddingInputToText),
      signal: callOptions?.signal,
      inputType: callOptions?.inputType,
    });
  };
  return {
    provider: {
      id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
      model: client.model,
      ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
      embed: async (input, callOptions) => {
        const [embedding] = await embedBatch([input], callOptions);
        if (!embedding) {
          throw malformedEmbeddingResponse();
        }
        return embedding;
      },
      embedBatch,
    },
    client,
  };
}

/** Embedding provider adapter for OpenAI-compatible remote embedding APIs. */
export const openAICompatibleEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  create: async (options) => {
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(options);
    const cacheHeaders = sanitizeCacheHeaders(client.headers);
    return {
      provider,
      runtime: {
        id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
          baseUrl: client.baseUrl,
          model: client.model,
          ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
          ...(client.inputType ? { inputType: client.inputType } : {}),
          ...(client.queryInputType ? { queryInputType: client.queryInputType } : {}),
          ...(client.documentInputType ? { documentInputType: client.documentInputType } : {}),
          ...(cacheHeaders ? { headers: cacheHeaders } : {}),
        },
      },
    };
  },
};
