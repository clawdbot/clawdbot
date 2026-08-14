import path from "node:path";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
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

const LLAMA_CPP_SETUP_REMEDIATION = [
  "Run `openclaw configure` and choose llama.cpp once.",
  "Retry `openclaw memory status --deep` after setup completes.",
] as const;

class LlamaCppStartupPrerequisiteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlamaCppStartupPrerequisiteError";
  }
}

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

function resolveConfiguredProvider(options: EmbeddingProviderCreateOptions): ModelProviderConfig {
  const provider = options.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (!provider?.localService || !provider.baseUrl) {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-config-missing",
      "Local embeddings need the managed llama.cpp server config. Run `openclaw configure`, choose llama.cpp once, then retry `openclaw memory status --deep`.",
    );
  }
  return provider;
}

function resolveProviderPort(provider: ModelProviderConfig): number {
  let port: number;
  try {
    port = Number(new URL(provider.baseUrl ?? "").port);
  } catch {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-base-url-invalid",
      "Managed llama.cpp provider baseUrl must be a valid URL.",
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new LlamaCppStartupPrerequisiteError(
      "managed-server-port-missing",
      "Managed llama.cpp provider baseUrl must include a loopback port.",
    );
  }
  return port;
}

function resolveChatModel(
  options: EmbeddingProviderCreateOptions,
  provider: ModelProviderConfig,
): ModelProviderConfig["models"][number] {
  const configuredPrimary = options.config.agents?.defaults?.model;
  const primaryRef =
    typeof configuredPrimary === "string" ? configuredPrimary : configuredPrimary?.primary;
  const primaryId = primaryRef?.startsWith(`${LLAMA_CPP_PROVIDER_ID}/`)
    ? primaryRef.slice(LLAMA_CPP_PROVIDER_ID.length + 1)
    : undefined;
  const chatModel =
    provider.models.find((model) => model.id === primaryId) ??
    provider.models.find((model) => model.id !== DEFAULT_LLAMA_CPP_MODEL_ID) ??
    provider.models[0];
  if (!chatModel) {
    throw new LlamaCppStartupPrerequisiteError(
      "chat-model-preset-missing",
      "Managed llama.cpp provider has no chat model preset.",
    );
  }
  return chatModel;
}

async function prepareEmbeddingServer(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
): Promise<void> {
  const provider = resolveConfiguredProvider(options);
  const chatModel = resolveChatModel(options, provider);
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
        port: resolveProviderPort(provider),
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
  inspectStartupPrerequisites: (options) => {
    try {
      const provider = resolveConfiguredProvider(options);
      resolveProviderPort(provider);
      resolveChatModel(options, provider);
      return { status: "ready" };
    } catch (error) {
      if (error instanceof LlamaCppStartupPrerequisiteError) {
        return {
          status: "blocked",
          issues: [
            {
              code: error.code,
              message: error.message,
              remediation: LLAMA_CPP_SETUP_REMEDIATION,
            },
          ],
        };
      }
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
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
        baseUrl: resolveConfiguredProvider(options).baseUrl ?? "",
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
