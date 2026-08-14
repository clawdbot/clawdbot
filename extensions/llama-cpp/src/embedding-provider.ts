import path from "node:path";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  inspectLlamaCppEmbeddingStartupPrerequisites,
  resolveConfiguredLlamaCppProvider,
  resolveLlamaCppChatModel,
  resolveLlamaCppProviderPort,
} from "./embedding-provider-preflight.js";
import { selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
  type LlamaServerRuntimeFacts,
} from "./managed-server.js";

type LlamaCppLocalOptions = {
  modelPath?: string;
  modelCacheDir?: string;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
const preparedEmbeddingServers = new Map<string, Promise<void>>();

type LlamaCppModelIdentity = {
  model: string;
  cacheKeyData: Record<string, unknown>;
  aliases: Array<{ model: string; cacheKeyData: Record<string, unknown> }>;
};

function readLocalOptions(options: { local?: unknown }): LlamaCppLocalOptions {
  return (options.local as LlamaCppLocalOptions | undefined) ?? {};
}

function createCacheKeyData(model: string, dimensions?: number): Record<string, unknown> {
  return {
    provider: "local",
    model,
    ...(typeof dimensions === "number" ? { outputDimensionality: dimensions } : {}),
  };
}

function resolveModelIdentity(
  local: LlamaCppLocalOptions,
  modelPath: string,
  dimensions?: number,
): LlamaCppModelIdentity {
  const configuredCacheDir =
    normalizeOptionalString(local.modelCacheDir) ?? resolveLlamaCppModelCacheDir();
  const currentDefaultPath = path.resolve(
    configuredCacheDir,
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  );
  const legacyDefaultPath = path.resolve(
    resolveLegacyLlamaCppModelCacheDir(),
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  );
  const isUri = /^(?:hf:|https?:\/\/)/iu.test(modelPath);
  const resolvedPath = isUri ? undefined : path.resolve(configuredCacheDir, modelPath);
  const isDefault =
    modelPath === DEFAULT_LLAMA_CPP_EMBEDDING_MODEL ||
    resolvedPath === currentDefaultPath ||
    resolvedPath === legacyDefaultPath;
  if (!isDefault) {
    return {
      model: modelPath,
      cacheKeyData: createCacheKeyData(modelPath, dimensions),
      aliases: [],
    };
  }
  const aliases = new Set([
    currentDefaultPath,
    legacyDefaultPath,
    DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  ]);
  if (modelPath !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    aliases.add(modelPath);
  }
  return {
    model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    cacheKeyData: createCacheKeyData(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL, dimensions),
    aliases: [...aliases].map((model) => ({
      model,
      cacheKeyData: createCacheKeyData(model, dimensions),
    })),
  };
}

async function prepareEmbeddingServer(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
): Promise<void> {
  const provider = resolveConfiguredLlamaCppProvider(options);
  const chatModel = resolveLlamaCppChatModel(options, provider);
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const key = JSON.stringify([provider.baseUrl, chatModel.id, embeddingSource, cacheDir]);
  const pending =
    preparedEmbeddingServers.get(key) ??
    (async () => {
      const [chatModelPath, embeddingModelPath] = await Promise.all([
        ensureLlamaCppModel({
          source: resolveLlamaCppModelSource(chatModel),
          cacheDir,
          download: false,
        }),
        ensureLlamaCppModel({
          source: embeddingSource,
          cacheDir,
          download: true,
        }),
      ]);
      const configuredContext = chatModel.params?.contextSize;
      await prepareManagedLlamaServer({
        chatModelId: chatModel.id,
        chatModelPath,
        contextSize:
          typeof configuredContext === "number" && configuredContext > 0
            ? Math.floor(configuredContext)
            : chatModel.contextTokens,
        maxTokens: chatModel.maxTokens,
        embeddingModelPath,
        port: resolveLlamaCppProviderPort(provider),
      });
    })();
  preparedEmbeddingServers.set(key, pending);
  try {
    await pending;
  } catch (error) {
    if (preparedEmbeddingServers.get(key) === pending) {
      preparedEmbeddingServers.delete(key);
    }
    throw error;
  }
}

function wrapProvider(params: {
  provider: EmbeddingProvider;
  canonicalModel: string;
  baseUrl: string;
}): EmbeddingProvider {
  let runtimeFacts: LlamaServerRuntimeFacts | undefined;
  const refreshFacts = async (loadError?: string) => {
    runtimeFacts = await inspectLlamaServerRuntime({
      baseUrl: params.baseUrl,
      modelId: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      backend: selectLlamaServerAsset().backend,
      loadError,
    });
  };
  const withFacts = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      const value = await operation();
      await refreshFacts();
      return value;
    } catch (error) {
      await refreshFacts(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const wrapped: EmbeddingProvider = {
    id: "local",
    model: params.canonicalModel,
    dimensions: params.provider.dimensions,
    maxInputTokens: params.provider.maxInputTokens,
    embed: async (input, callOptions) =>
      await withFacts(async () => await params.provider.embed(input, callOptions)),
    embedBatch: async (inputs, callOptions) =>
      await withFacts(async () => await params.provider.embedBatch(inputs, callOptions)),
    close: params.provider.close,
  };
  Object.defineProperty(wrapped, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    enumerable: false,
    value: () => runtimeFacts,
  });
  return wrapped;
}

export const llamaCppEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: "local",
  defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  transport: "local",
  formatSetupError: (error) =>
    `Managed local embeddings are unavailable. Run \`openclaw configure\`, choose llama.cpp, and retry. ${error instanceof Error ? error.message : String(error)}`,
  resolveIndexIdentity: (options) => {
    const local = readLocalOptions(options);
    const modelPath = normalizeOptionalString(local.modelPath) ?? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL;
    return resolveModelIdentity(local, modelPath, options.dimensions);
  },
  inspectStartupPrerequisites: inspectLlamaCppEmbeddingStartupPrerequisites,
  create: async (options) => {
    const local = readLocalOptions(options);
    const modelPath = normalizeOptionalString(local.modelPath) ?? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL;
    await prepareEmbeddingServer(options, modelPath);
    const genericAdapter = getEmbeddingProvider("openai-compatible", options.config);
    if (!genericAdapter) {
      throw new Error("OpenAI-compatible embedding transport is unavailable.");
    }
    const result = await genericAdapter.create({
      ...options,
      provider: LLAMA_CPP_PROVIDER_ID,
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      remote: undefined,
    });
    if (!result.provider) {
      return result;
    }
    const identity = resolveModelIdentity(local, modelPath, options.dimensions);
    return {
      provider: wrapProvider({
        provider: result.provider,
        canonicalModel: identity.model,
        baseUrl: resolveConfiguredLlamaCppProvider(options).baseUrl ?? "",
      }),
      runtime: {
        id: "local",
        inlineQueryTimeoutMs: 5 * 60_000,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: identity.cacheKeyData,
        ...(identity.aliases.length > 0 ? { indexIdentityAliases: identity.aliases } : {}),
      },
    };
  },
};
