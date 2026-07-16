import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  createLocalEmbeddingProvider,
  type EmbeddingInput as MemoryEmbeddingInput,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

type LlamaCppLocalOptions = {
  modelPath?: string;
  modelCacheDir?: string;
  contextSize?: number | "auto";
};

type LlamaCppEmbeddingProviderRuntimeOptions = {
  nodeLlamaCppImportUrl?: string;
};

const LLAMA_CPP_EMBEDDING_PROVIDER_ID = "local";
const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_CACHE_FILE_NAME =
  "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf";

type LlamaCppModelIdentity = {
  model: string;
  cacheKeyData: Record<string, unknown>;
  aliases: Array<{
    model: string;
    cacheKeyData: Record<string, unknown>;
  }>;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLocalOptions(options: { local?: unknown }): LlamaCppLocalOptions {
  const local = options.local as LlamaCppLocalOptions | undefined;
  return local ?? {};
}

function createLlamaCppCacheKeyData(
  model: string,
  outputDimensionality?: number,
): Record<string, unknown> {
  return {
    provider: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    model,
    ...(typeof outputDimensionality === "number" ? { outputDimensionality } : {}),
  };
}

function resolveLlamaCppModelIdentity(
  local: LlamaCppLocalOptions,
  modelPath: string,
  outputDimensionality?: number,
): LlamaCppModelIdentity {
  const modelCacheDir =
    normalizeOptionalString(local.modelCacheDir) ??
    path.join(os.homedir(), ".node-llama-cpp", "models");
  const resolvedDefaultModelPath = path.resolve(
    modelCacheDir,
    DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_CACHE_FILE_NAME,
  );
  const isModelUri = /^(?:hf:|https?:\/\/)/i.test(modelPath);
  const resolvedModelPath = isModelUri ? undefined : path.resolve(modelCacheDir, modelPath);
  // node-llama-cpp resolves the default HF URI to this exact cache target and
  // accepts its URI-derived filename relative to any configured cache directory.
  // Preserve that exact historical key; arbitrary filenames and paths stay distinct.
  if (
    modelPath !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL &&
    resolvedModelPath !== resolvedDefaultModelPath
  ) {
    return {
      model: modelPath,
      cacheKeyData: createLlamaCppCacheKeyData(modelPath, outputDimensionality),
      aliases: [],
    };
  }
  const aliasModels = new Set([
    resolvedDefaultModelPath,
    DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_CACHE_FILE_NAME,
  ]);
  if (modelPath !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    aliasModels.add(modelPath);
  }
  return {
    model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
    cacheKeyData: createLlamaCppCacheKeyData(
      DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      outputDimensionality,
    ),
    aliases: Array.from(aliasModels, (aliasModel) => ({
      model: aliasModel,
      cacheKeyData: createLlamaCppCacheKeyData(aliasModel, outputDimensionality),
    })),
  };
}

function textFromEmbeddingInput(input: EmbeddingInput): string {
  return typeof input === "string" ? input : input.text;
}

function toMemoryEmbeddingInput(input: EmbeddingInput): MemoryEmbeddingInput {
  return typeof input === "string" ? { text: input } : input;
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function formatLlamaCppSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local llama.cpp embeddings unavailable.",
    missing
      ? "Reason: node-llama-cpp is missing or failed to install."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local GGUF embeddings:",
    "1) Install the official provider plugin: openclaw plugins install @openclaw/llama-cpp-provider",
    "2) Use Node 24 for native installs/updates.",
    "3) If you use pnpm from source: pnpm approve-builds, then pnpm rebuild node-llama-cpp.",
    'Or set agents.defaults.memorySearch.provider to a remote embedding provider such as "openai", "ollama", "lmstudio", or "voyage".',
  ]
    .filter(Boolean)
    .join("\n");
}

const requireFromPlugin = createRequire(import.meta.url);

function resolveNodeLlamaCppImportUrl(): string {
  return pathToFileURL(requireFromPlugin.resolve("node-llama-cpp")).href;
}

function copyLocalRuntimeFacts(source: object, target: object): void {
  const getRuntimeFacts = Reflect.get(source, LOCAL_EMBEDDING_RUNTIME_FACTS);
  if (typeof getRuntimeFacts === "function") {
    Object.defineProperty(target, LOCAL_EMBEDDING_RUNTIME_FACTS, {
      enumerable: false,
      value: getRuntimeFacts,
    });
  }
}

function adaptMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider): EmbeddingProvider {
  const adapted: EmbeddingProvider = {
    id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    model: provider.model,
    maxInputTokens: provider.maxInputTokens,
    embed: async (input, callOptions) =>
      await provider.embedQuery(textFromEmbeddingInput(input), {
        signal: callOptions?.signal,
      }),
    embedBatch: async (inputs, callOptions) => {
      if (provider.embedBatchInputs) {
        return await provider.embedBatchInputs(inputs.map(toMemoryEmbeddingInput), {
          signal: callOptions?.signal,
        });
      }
      return await provider.embedBatch(inputs.map(textFromEmbeddingInput), {
        signal: callOptions?.signal,
      });
    },
    close: provider.close,
  };
  copyLocalRuntimeFacts(provider, adapted);
  return adapted;
}

async function createLlamaCppMemoryEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
  runtimeOptions: LlamaCppEmbeddingProviderRuntimeOptions = {},
): Promise<MemoryEmbeddingProviderCreateResult> {
  const createOptions = buildMemoryCreateOptions(options, options.outputDimensionality);
  const local = readLocalOptions(createOptions);
  const provider = await createLocalEmbeddingProvider(createOptions, {
    nodeLlamaCppImportUrl: runtimeOptions.nodeLlamaCppImportUrl ?? resolveNodeLlamaCppImportUrl(),
  });
  const identity = resolveLlamaCppModelIdentity(
    local,
    provider.model,
    createOptions.outputDimensionality,
  );
  const identifiedProvider =
    identity.model === provider.model ? provider : { ...provider, model: identity.model };
  if (identifiedProvider !== provider) {
    copyLocalRuntimeFacts(provider, identifiedProvider);
  }
  return {
    provider: identifiedProvider,
    runtime: createLlamaCppEmbeddingProviderRuntime(identity),
  };
}

async function createLlamaCppEmbeddingProviderResult(
  options: EmbeddingProviderCreateOptions,
  runtimeOptions: LlamaCppEmbeddingProviderRuntimeOptions = {},
): Promise<EmbeddingProviderCreateResult> {
  const result = await createLlamaCppMemoryEmbeddingProvider(
    buildMemoryCreateOptions(options, options.dimensions),
    runtimeOptions,
  );
  return {
    provider: result.provider ? adaptMemoryEmbeddingProvider(result.provider) : null,
    runtime: result.runtime,
  };
}

function buildMemoryCreateOptions(
  options: MemoryEmbeddingProviderCreateOptions | EmbeddingProviderCreateOptions,
  outputDimensionality: number | undefined,
): MemoryEmbeddingProviderCreateOptions {
  const local = readLocalOptions(options);
  const modelPath = normalizeOptionalString(local.modelPath) || DEFAULT_LLAMA_CPP_EMBEDDING_MODEL;
  return {
    config: options.config,
    agentDir: options.agentDir,
    provider: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    fallback: "none",
    remote: options.remote,
    model: modelPath,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    local: {
      ...local,
      modelPath,
    },
    outputDimensionality,
  };
}

function createLlamaCppEmbeddingProviderRuntime(identity: LlamaCppModelIdentity) {
  return {
    id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    inlineQueryTimeoutMs: 5 * 60_000,
    inlineBatchTimeoutMs: 10 * 60_000,
    cacheKeyData: identity.cacheKeyData,
    ...(identity.aliases.length > 0 ? { indexIdentityAliases: identity.aliases } : {}),
  };
}

export const llamaCppEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
  defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  transport: "local",
  formatSetupError: formatLlamaCppSetupError,
  resolveIndexIdentity: (options) => {
    const createOptions = buildMemoryCreateOptions(options, options.dimensions);
    const local = readLocalOptions(createOptions);
    return resolveLlamaCppModelIdentity(
      local,
      normalizeOptionalString(local.modelPath) ?? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      createOptions.outputDimensionality,
    );
  },
  create: async (options) => await createLlamaCppEmbeddingProviderResult(options),
};
