// Builds OpenAI-compatible embedding provider entries for plugins.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readEmbeddingVectors } from "../../packages/memory-host-sdk/src/host/embedding-vectors.js";
import { withRemoteHttpResponse } from "../../packages/memory-host-sdk/src/host/remote-http.js";
import { readProviderJsonArrayFieldResponse } from "../agents/provider-http-errors.js";
import type {
  AcquireConfiguredProviderLocalService,
  ConfiguredProviderLocalServiceTarget,
} from "../agents/provider-local-service.js";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import { readResponseTextPrefix } from "../infra/http-body.js";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname, type SsrFPolicy } from "../infra/net/ssrf.js";
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
} from "./embedding-provider-types.js";

/** Provider id for OpenAI-compatible remote embedding servers. */
const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);
const EMBEDDING_ERROR_BODY_MAX_BYTES = 8 * 1024;
const EMBEDDING_ERROR_BODY_MAX_CHARS = 1_000;
const EMBEDDING_ERROR_TRUNCATED_SUFFIX = "... [truncated]";

/** Normalized OpenAI-compatible embedding client configuration. */
type OpenAICompatibleEmbeddingClient = {
  providerId: string;
  baseUrl: string;
  endpointUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  dimensions?: number;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  localServiceTarget?: ConfiguredProviderLocalServiceTarget;
  acquireLocalService?: AcquireConfiguredProviderLocalService;
};

type ConfiguredEmbeddingProvider = {
  api?: string;
  baseUrl?: string;
  apiKey?: unknown;
  headers?: Record<string, unknown>;
  localService?: ModelProviderLocalServiceConfig;
};

type ResolvedConfiguredEmbeddingProvider = {
  providerId: string;
  config: ConfiguredEmbeddingProvider;
};

type LocalServiceAwareEmbeddingOptions = EmbeddingProviderCreateOptions & {
  acquireLocalService?: AcquireConfiguredProviderLocalService;
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

function buildHeaders(params: {
  apiKey: string | undefined;
  provider: Record<string, unknown> | undefined;
  remote: Record<string, unknown> | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  for (const [path, extra] of [
    ["models.providers.*.headers", params.provider],
    ["memory.search.remote.headers", params.remote],
  ] as const) {
    for (const [name, rawValue] of Object.entries(extra ?? {})) {
      const normalizedName = normalizeHeaderName(name);
      if (!normalizedName) {
        continue;
      }
      const value = resolveSecretString({ value: rawValue, path: `${path}.${normalizedName}` });
      if (value) {
        headers[normalizedName] = value;
      }
    }
  }
  if (params.apiKey && !headers.authorization) {
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

function resolveSecretString(params: { value: unknown; path: string }): string | undefined {
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}

function resolveRemoteApiKey(value: unknown): string | undefined {
  return resolveSecretString({
    value,
    path: "memory.search.remote.apiKey",
  });
}

async function resolveConfiguredProviderApiKey(params: {
  providerId: string;
  options: EmbeddingProviderCreateOptions;
  configuredProvider: ConfiguredEmbeddingProvider | undefined;
}): Promise<string | undefined> {
  const apiKey = resolveSecretString({
    value: params.configuredProvider?.apiKey,
    path: `models.providers.${params.providerId}.apiKey`,
  });
  if (!apiKey) {
    return undefined;
  }
  const { resolveAgentDir, tryResolveAmbientOwnerAgentId } =
    await import("../agents/agent-scope-config.js");
  const agentId = tryResolveAmbientOwnerAgentId(params.options.config);
  const agentDir =
    params.options.agentDir?.trim() ||
    (agentId ? resolveAgentDir(params.options.config, agentId) : undefined);
  // Without an owned auth store, a configured string retains its literal meaning.
  if (!agentDir) {
    return apiKey;
  }
  const { resolveScopedAuthProfileStore, resolveProviderEntryApiKeyAuth } =
    await import("../agents/model-auth-provider.js");
  const authParams = {
    provider: params.providerId,
    modelApi: params.configuredProvider?.api,
    cfg: params.options.config,
    agentDir,
  };
  const store = resolveScopedAuthProfileStore(authParams);
  // Only explicit profile bindings enter model auth. General discovery would
  // replace literal/runtime-resolved keys with unrelated profile or env credentials.
  const auth = await resolveProviderEntryApiKeyAuth({ ...authParams, store });
  return auth ? auth.apiKey : apiKey;
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
): ResolvedConfiguredEmbeddingProvider | undefined {
  const providers = options.config.models?.providers as
    | Record<string, ConfiguredEmbeddingProvider>
    | undefined;
  if (!providers) {
    return undefined;
  }
  const providerId = options.provider?.trim() || OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  const normalizedProviderId = normalizeProviderId(providerId);
  const direct = providers[providerId];
  if (direct && isOpenAICompatibleProviderConfig(providerId, direct)) {
    return { providerId, config: direct };
  }
  const normalizedEntry = Object.entries(providers).find(
    ([candidateId]) => normalizeProviderId(candidateId) === normalizedProviderId,
  );
  if (!normalizedEntry) {
    return undefined;
  }
  const [configuredProviderId, config] = normalizedEntry;
  return isOpenAICompatibleProviderConfig(configuredProviderId, config)
    ? { providerId: configuredProviderId, config }
    : undefined;
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

function malformedEmbeddingResponse(): Error {
  return new Error("openai-compatible embeddings failed: malformed JSON response");
}

async function readEmbeddingErrorBodySnippet(response: Response): Promise<string | undefined> {
  if (!response.body || response.bodyUsed) {
    return undefined;
  }
  const prefix = await readResponseTextPrefix(response, EMBEDDING_ERROR_BODY_MAX_BYTES).catch(
    () => undefined,
  );
  if (!prefix?.text) {
    return undefined;
  }
  const { text, truncated } = prefix;
  if (text.length > EMBEDDING_ERROR_BODY_MAX_CHARS) {
    return `${truncateUtf16Safe(text, EMBEDDING_ERROR_BODY_MAX_CHARS)}${EMBEDDING_ERROR_TRUNCATED_SUFFIX}`;
  }
  return truncated ? `${text}${EMBEDDING_ERROR_TRUNCATED_SUFFIX}` : text;
}

async function createEmbeddingHttpError(response: Response): Promise<Error> {
  const snippet = await readEmbeddingErrorBodySnippet(response);
  return new Error(
    `openai-compatible embeddings failed: HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
  );
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
  const localServiceLease =
    client.localServiceTarget && client.acquireLocalService
      ? await client.acquireLocalService(client.localServiceTarget, params.signal)
      : undefined;
  try {
    return await withRemoteHttpResponse({
      url: client.endpointUrl,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify(body),
      },
      signal: params.signal,
      ssrfPolicy: client.ssrfPolicy,
      auditContext: "embedding-provider:openai-compatible",
      onResponse: async (response) => {
        if (!response.ok) {
          throw await createEmbeddingHttpError(response);
        }
        return readEmbeddingVectors(
          await readProviderJsonArrayFieldResponse(
            response,
            "openai-compatible embeddings failed",
            "data",
          ),
          input.length,
          "openai-compatible embeddings failed",
        );
      },
    });
  } finally {
    localServiceLease?.release();
  }
}

/** Creates a normalized OpenAI-compatible embedding client from runtime config. */
async function createOpenAICompatibleEmbeddingClient(
  options: EmbeddingProviderCreateOptions,
): Promise<OpenAICompatibleEmbeddingClient> {
  const resolvedProvider = resolveConfiguredProvider(options);
  const configuredProvider = resolvedProvider?.config;
  const providerId =
    resolvedProvider?.providerId ??
    options.provider?.trim() ??
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  const remoteBaseUrl = normalizeOptionalString(options.remote?.baseUrl);
  const providerBaseUrl = normalizeOptionalString(configuredProvider?.baseUrl);
  const baseUrl = normalizeBaseUrl(remoteBaseUrl ?? providerBaseUrl);
  // The embedding SDK also loads the provider registry; keep this shared policy edge lazy.
  const { embeddingProviderOwnsDestination, resolveEmbeddingEndpointUrl } =
    await import("../plugin-sdk/memory-core-host-engine-embeddings.js");
  const providerOwnsDestination =
    providerBaseUrl !== undefined && embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl });
  const model = normalizeModel(options.model, options.provider);
  const inputType = normalizeOptionalInputType(options.inputType);
  const queryInputType = normalizeOptionalInputType(options.queryInputType);
  const documentInputType = normalizeOptionalInputType(options.documentInputType);
  const headers = buildHeaders({
    apiKey: resolveRemoteApiKey(options.remote?.apiKey),
    provider: providerOwnsDestination ? configuredProvider?.headers : undefined,
    remote: options.remote?.headers,
  });
  if (providerOwnsDestination && !headers.authorization) {
    const providerApiKey = await resolveConfiguredProviderApiKey({
      providerId,
      options,
      configuredProvider,
    });
    if (providerApiKey) {
      headers.authorization = `Bearer ${providerApiKey}`;
    }
  }
  const localServiceOptions = options as LocalServiceAwareEmbeddingOptions;
  return {
    providerId,
    baseUrl,
    endpointUrl: resolveEmbeddingEndpointUrl(baseUrl, "embeddings"),
    headers,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    model,
    ...(configuredProvider?.localService && !remoteBaseUrl
      ? {
          localServiceTarget: {
            providerId,
            baseUrl,
            headers,
          },
          acquireLocalService: localServiceOptions.acquireLocalService,
        }
      : {}),
    ...(options.dimensions !== undefined
      ? { dimensions: normalizeDimensions(options.dimensions) }
      : {}),
    ...(inputType ? { inputType } : {}),
    ...(queryInputType ? { queryInputType } : {}),
    ...(documentInputType ? { documentInputType } : {}),
  };
}

/** Creates an OpenAI-compatible embedding provider and its backing client. */
async function createOpenAICompatibleEmbeddingProvider(
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
          provider: client.providerId,
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
