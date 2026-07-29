// OpenAI-compatible embeddings HTTP endpoint.
// Bridges /v1/embeddings requests to configured OpenClaw memory providers.
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { createConfiguredProviderLocalServiceAcquirer } from "../agents/provider-local-service.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import {
  getEmbeddingProvider as getGenericEmbeddingProvider,
  type EmbeddingProvider as GenericEmbeddingProvider,
  type EmbeddingProviderAdapter as GenericEmbeddingProviderAdapter,
} from "../plugins/embedding-provider-runtime.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "../plugins/memory-embedding-providers.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMissingScopeForbidden } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  OPENCLAW_MODEL_ID,
  authorizeOpenAiCompatibleHttpModelOverride,
  getHeader,
  isUnknownGatewayAgentError,
  resolveAgentIdForRequest,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

// OpenAI-compatible `/v1/embeddings` bridge. It maps OpenClaw agent/model
// routing onto configured memory embedding providers while preserving the
// response shape expected by OpenAI SDK clients.
type OpenAiEmbeddingsHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type EmbeddingsRequest = {
  model?: unknown;
  input?: unknown;
  encoding_format?: unknown;
  dimensions?: unknown;
  user?: unknown;
};

const DEFAULT_EMBEDDINGS_BODY_BYTES = 5 * 1024 * 1024;
const MAX_EMBEDDING_INPUTS = 128;
const MAX_EMBEDDING_INPUT_CHARS = 8_192;
const MAX_EMBEDDING_TOTAL_CHARS = 65_536;
const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";
type EmbeddingProviderRequest = string;
type MemorySearchEmbeddingConfig = Pick<
  NonNullable<ReturnType<typeof resolveMemorySearchConfig>>,
  "local" | "remote" | "outputDimensionality" | "inputType" | "queryInputType" | "documentInputType"
>;

const EMBEDDING_PROVIDER_RETIREMENTS = new Map<string, Set<MemoryEmbeddingProvider>>();
const EMBEDDING_PROVIDER_ADMISSION_TAILS = new Map<string, Promise<void>>();

async function acquireEmbeddingProviderLease(
  scopeKey: string,
  create: () => Promise<MemoryEmbeddingProvider>,
  holdForCleanup: (provider: MemoryEmbeddingProvider) => boolean,
): Promise<{ provider: MemoryEmbeddingProvider; release: () => void }> {
  const previous = EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) ?? Promise.resolve();
  const createLease = async () => {
    await drainEmbeddingProviderRetirements(scopeKey);
    const provider = await create();
    if (!holdForCleanup(provider)) {
      return { provider, lifecycle: Promise.resolve(), release: () => {} };
    }
    let release: () => void = () => {};
    const lifecycle = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { provider, lifecycle, release };
  };
  const acquired = previous.then(createLease, createLease);
  const tail = acquired
    .then(async ({ lifecycle }) => await lifecycle)
    .then(
      () => undefined,
      () => undefined,
    );
  EMBEDDING_PROVIDER_ADMISSION_TAILS.set(scopeKey, tail);
  void tail.then(() => {
    if (EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) === tail) {
      EMBEDDING_PROVIDER_ADMISSION_TAILS.delete(scopeKey);
    }
  });
  const { provider, release } = await acquired;
  return { provider, release };
}

async function drainEmbeddingProviderRetirements(scopeKey: string): Promise<void> {
  const pending = EMBEDDING_PROVIDER_RETIREMENTS.get(scopeKey);
  if (!pending || pending.size === 0) {
    return;
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const provider of pending) {
    try {
      await provider.close?.();
      pending.delete(provider);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (pending.size === 0) {
    EMBEDDING_PROVIDER_RETIREMENTS.delete(scopeKey);
  }
  if (closeFailed) {
    throw firstError;
  }
}

function retainEmbeddingProviderForRetirement(
  scopeKey: string,
  provider: MemoryEmbeddingProvider,
): void {
  const pending = EMBEDDING_PROVIDER_RETIREMENTS.get(scopeKey) ?? new Set();
  pending.add(provider);
  EMBEDDING_PROVIDER_RETIREMENTS.set(scopeKey, pending);
}

export async function drainRetainedOpenAiEmbeddingProviders(): Promise<void> {
  const activeLifecycles = Array.from(EMBEDDING_PROVIDER_ADMISSION_TAILS.values());
  if (activeLifecycles.length > 0) {
    await Promise.allSettled(activeLifecycles);
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const scopeKey of Array.from(EMBEDDING_PROVIDER_RETIREMENTS.keys())) {
    try {
      await drainEmbeddingProviderRetirements(scopeKey);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw firstError;
  }
}

function coerceRequest(value: unknown): EmbeddingsRequest {
  return value && typeof value === "object" ? (value as EmbeddingsRequest) : {};
}

function resolveInputTexts(input: unknown): string[] | null {
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.every((entry) => typeof entry === "string")) {
    return input;
  }
  return null;
}

function encodeEmbeddingBase64(embedding: number[]): string {
  // OpenAI-compatible base64 embeddings are raw float32 bytes, not JSON.
  const float32 = Float32Array.from(embedding);
  return Buffer.from(float32.buffer).toString("base64");
}

// Keep request limits local to the HTTP bridge; provider adapters may support
// more, but this endpoint must protect gateway memory and request latency.
function validateInputTexts(texts: string[]): string | undefined {
  if (texts.length > MAX_EMBEDDING_INPUTS) {
    return `Too many inputs (max ${MAX_EMBEDDING_INPUTS}).`;
  }
  let totalChars = 0;
  for (const text of texts) {
    if (text.length > MAX_EMBEDDING_INPUT_CHARS) {
      return `Input too long (max ${MAX_EMBEDDING_INPUT_CHARS} chars).`;
    }
    totalChars += text.length;
    if (totalChars > MAX_EMBEDDING_TOTAL_CHARS) {
      return `Total input too large (max ${MAX_EMBEDDING_TOTAL_CHARS} chars).`;
    }
  }
  return undefined;
}

function resolveEmbeddingProviderRemoteConfig(remote: MemorySearchEmbeddingConfig["remote"]) {
  return remote
    ? {
        baseUrl: remote.baseUrl,
        apiKey: remote.apiKey,
        headers: remote.headers,
      }
    : undefined;
}

function isLocalEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  provider: EmbeddingProviderRequest;
}): boolean {
  const providerId =
    params.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : params.provider;
  return (
    getMemoryEmbeddingProvider(providerId, params.cfg)?.transport === "local" ||
    getGenericEmbeddingProvider(providerId, params.cfg)?.transport === "local"
  );
}

async function createConfiguredEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: EmbeddingProviderRequest;
  model: string;
  memorySearch?: MemorySearchEmbeddingConfig;
}): Promise<MemoryEmbeddingProvider> {
  const acquireLocalService = createConfiguredProviderLocalServiceAcquirer(() => params.cfg);
  const providerId =
    params.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : params.provider;
  // Prefer memory-specific adapters because they understand query/document
  // input types; generic embedding adapters are adapted only as a fallback.
  const createWithAdapter = async (adapter: MemoryEmbeddingProviderAdapter) => {
    const createOptions = {
      config: params.cfg,
      agentDir: params.agentDir,
      provider: providerId,
      model: params.model || adapter.defaultModel || "",
      local: params.memorySearch?.local,
      remote: resolveEmbeddingProviderRemoteConfig(params.memorySearch?.remote),
      outputDimensionality: params.memorySearch?.outputDimensionality,
      acquireLocalService,
    };
    const result = await adapter.create(createOptions);
    return result.provider;
  };
  const createWithGenericAdapter = async (adapter: GenericEmbeddingProviderAdapter) => {
    const createOptions = {
      config: params.cfg,
      agentDir: params.agentDir,
      provider: providerId,
      model: params.model || adapter.defaultModel || "",
      local: params.memorySearch?.local,
      remote: resolveEmbeddingProviderRemoteConfig(params.memorySearch?.remote),
      dimensions: params.memorySearch?.outputDimensionality,
      inputType: params.memorySearch?.inputType,
      queryInputType: params.memorySearch?.queryInputType,
      documentInputType: params.memorySearch?.documentInputType,
      acquireLocalService,
    };
    const result = await adapter.create(createOptions);
    return result.provider ? adaptGenericEmbeddingProvider(result.provider) : null;
  };

  const adapter = getMemoryEmbeddingProvider(providerId, params.cfg);
  if (adapter) {
    const provider = await createWithAdapter(adapter);
    if (!provider) {
      throw new Error(`Memory embedding provider ${providerId} is unavailable.`);
    }
    return provider;
  }

  const genericAdapter = getGenericEmbeddingProvider(providerId, params.cfg);
  if (!genericAdapter) {
    throw new Error(`Unknown memory embedding provider: ${providerId}`);
  }
  const provider = await createWithGenericAdapter(genericAdapter);
  if (!provider) {
    throw new Error(`Embedding provider ${providerId} is unavailable.`);
  }
  return provider;
}

// Generic embedding providers expose one embed API; memory search expects
// query/document methods so the HTTP endpoint can batch document-style inputs.
function adaptGenericEmbeddingProvider(
  provider: GenericEmbeddingProvider,
): MemoryEmbeddingProvider {
  return {
    id: provider.id,
    model: provider.model,
    ...(typeof provider.maxInputTokens === "number"
      ? { maxInputTokens: provider.maxInputTokens }
      : {}),
    embedQuery: async (text, options) =>
      await provider.embed(text, {
        ...options,
        inputType: "query",
      }),
    embedBatch: async (texts, options) =>
      await provider.embedBatch(texts, {
        ...options,
        inputType: "document",
      }),
    ...(provider.close ? { close: async () => await provider.close?.() } : {}),
  };
}

// Request model overrides are constrained to the configured memory provider so
// a gateway client cannot select an arbitrary embedding provider by model name.
function resolveEmbeddingsTarget(params: {
  requestModel: string;
  configuredProvider: EmbeddingProviderRequest;
}): { provider: EmbeddingProviderRequest; model: string } | { errorMessage: string } {
  const configuredProvider =
    params.configuredProvider === "auto"
      ? DEFAULT_MEMORY_EMBEDDING_PROVIDER
      : params.configuredProvider;
  const raw = params.requestModel.trim();
  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { provider: configuredProvider, model: raw };
  }

  const provider = normalizeLowercaseStringOrEmpty(raw.slice(0, slash));
  const model = raw.slice(slash + 1).trim();
  if (!model) {
    return { errorMessage: "Unsupported embedding model reference." };
  }

  if (provider !== configuredProvider) {
    return {
      errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    };
  }

  return { provider: configuredProvider, model };
}

/** Handles OpenAI-compatible embeddings requests for the configured agent memory provider. */
export async function handleOpenAiEmbeddingsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiEmbeddingsHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/embeddings",
    requiredOperatorMethod: "chat.send",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_EMBEDDINGS_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  const modelOverrideAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelOverrideAuth.allowed) {
    sendMissingScopeForbidden(res, modelOverrideAuth.missingScope);
    return true;
  }

  const payload = coerceRequest(handled.body);
  const requestModel = normalizeOptionalString(payload.model) ?? "";
  if (!requestModel) {
    sendJson(res, 400, {
      error: { message: "Missing `model`.", type: "invalid_request_error" },
    });
    return true;
  }

  const cfg = getRuntimeConfig();
  if (requestModel !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(requestModel, cfg)) {
    sendJson(res, 400, {
      error: {
        message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const texts = resolveInputTexts(payload.input);
  if (!texts) {
    sendJson(res, 400, {
      error: {
        message: "`input` must be a string or an array of strings.",
        type: "invalid_request_error",
      },
    });
    return true;
  }
  const inputError = validateInputTexts(texts);
  if (inputError) {
    sendJson(res, 400, {
      error: { message: inputError, type: "invalid_request_error" },
    });
    return true;
  }

  let agentId: string;
  try {
    agentId = resolveAgentIdForRequest({ req, model: requestModel });
  } catch (err) {
    if (isUnknownGatewayAgentError(err)) {
      sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return true;
    }
    throw err;
  }
  const agentDir = resolveAgentDir(cfg, agentId);
  const memorySearch = resolveMemorySearchConfig(cfg, agentId);
  const configuredProvider = memorySearch?.provider ?? "openai";
  const overrideModel =
    normalizeOptionalString(getHeader(req, "x-openclaw-model")) ||
    normalizeOptionalString(memorySearch?.model) ||
    "";
  const target = resolveEmbeddingsTarget({
    requestModel: overrideModel,
    configuredProvider,
  });
  if ("errorMessage" in target) {
    sendJson(res, 400, {
      error: {
        message: target.errorMessage,
        type: "invalid_request_error",
      },
    });
    return true;
  }
  const providerScopeKey = JSON.stringify([agentId, target.provider]);
  const requestedProviderNeedsCleanup = isLocalEmbeddingProvider({
    cfg,
    provider: target.provider,
  });

  try {
    const { provider, release } = await acquireEmbeddingProviderLease(
      providerScopeKey,
      async () =>
        await createConfiguredEmbeddingProvider({
          cfg,
          agentDir,
          provider: target.provider,
          model: target.model,
          memorySearch: memorySearch
            ? {
                ...memorySearch,
                outputDimensionality:
                  typeof payload.dimensions === "number" && payload.dimensions > 0
                    ? Math.floor(payload.dimensions)
                    : memorySearch.outputDimensionality,
              }
            : undefined,
        }),
      (createdProvider) =>
        requestedProviderNeedsCleanup ||
        isLocalEmbeddingProvider({ cfg, provider: createdProvider.id }),
    );
    try {
      const embeddings = await provider.embedBatch(texts);
      const encodingFormat = payload.encoding_format === "base64" ? "base64" : "float";

      sendJson(res, 200, {
        object: "list",
        data: embeddings.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding: encodingFormat === "base64" ? encodeEmbeddingBase64(embedding) : embedding,
        })),
        model: requestModel,
        usage: {
          prompt_tokens: 0,
          total_tokens: 0,
        },
      });
    } finally {
      try {
        await provider.close?.();
      } catch (closeErr) {
        retainEmbeddingProviderForRetirement(providerScopeKey, provider);
        logWarn(
          `openai-compat: failed to close embeddings provider: ${formatErrorMessage(closeErr)}`,
        );
      } finally {
        release();
      }
    }
  } catch (err) {
    logWarn(`openai-compat: embeddings request failed: ${formatErrorMessage(err)}`);
    sendJson(res, 500, {
      error: {
        message: "internal error",
        type: "api_error",
      },
    });
  }

  return true;
}
