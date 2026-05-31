import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
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
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  OPENCLAW_MODEL_ID,
  getHeader,
  resolveAgentIdForRequest,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

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
  const float32 = Float32Array.from(embedding);
  return Buffer.from(float32.buffer).toString("base64");
}

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

async function createConfiguredEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: EmbeddingProviderRequest;
  model: string;
  memorySearch?: Pick<
    NonNullable<ReturnType<typeof resolveMemorySearchConfig>>,
    | "local"
    | "remote"
    | "outputDimensionality"
    | "inputType"
    | "queryInputType"
    | "documentInputType"
  >;
}): Promise<MemoryEmbeddingProvider> {
  const providerId =
    params.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : params.provider;
  const createWithAdapter = async (adapter: MemoryEmbeddingProviderAdapter) => {
    const result = await adapter.create({
      config: params.cfg,
      agentDir: params.agentDir,
      model: params.model || adapter.defaultModel || "",
      local: params.memorySearch?.local,
      remote: params.memorySearch?.remote
        ? {
            baseUrl: params.memorySearch?.remote.baseUrl,
            apiKey: params.memorySearch?.remote.apiKey,
            headers: params.memorySearch?.remote.headers,
          }
        : undefined,
      outputDimensionality: params.memorySearch?.outputDimensionality,
    });
    return result.provider;
  };
  const createWithGenericAdapter = async (adapter: GenericEmbeddingProviderAdapter) => {
    const result = await adapter.create({
      config: params.cfg,
      agentDir: params.agentDir,
      provider: providerId,
      model: params.model || adapter.defaultModel || "",
      local: params.memorySearch?.local,
      remote: params.memorySearch?.remote
        ? {
            baseUrl: params.memorySearch?.remote.baseUrl,
            apiKey: params.memorySearch?.remote.apiKey,
            headers: params.memorySearch?.remote.headers,
          }
        : undefined,
      dimensions: params.memorySearch?.outputDimensionality,
      inputType: params.memorySearch?.inputType,
      queryInputType: params.memorySearch?.queryInputType,
      documentInputType: params.memorySearch?.documentInputType,
    });
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
    ...(provider.close ? { close: provider.close } : {}),
  };
}

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

  const agentId = resolveAgentIdForRequest({ req, model: requestModel });
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

  try {
    const provider = await createConfiguredEmbeddingProvider({
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
    });
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
