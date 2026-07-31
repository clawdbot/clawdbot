import os from "node:os";
import path from "node:path";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const LLAMA_CPP_PROVIDER_ID = "llama-cpp";
export const LLAMA_CPP_PROVIDER_LABEL = "Local model (llama.cpp)";
const LLAMA_CPP_LOCAL_AUTH_MARKER = "llama-cpp-local";
const LLAMA_CPP_LOCAL_BASE_URL = "local://llama-cpp";

export function resolveLlamaCppSyntheticApiKey(): string {
  return LLAMA_CPP_LOCAL_AUTH_MARKER;
}

export const DEFAULT_LLAMA_CPP_MODEL_ID = "gemma-4-e4b-it-q4_k_m";
export const DEFAULT_LLAMA_CPP_MODEL_REF = `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`;
// Verified 2026-07-16: 4,977,169,568 bytes (about 5.0 GB) from the public
// Unsloth Hugging Face repository metadata and response headers.
export const DEFAULT_LLAMA_CPP_MODEL_URI =
  "hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE =
  "hf_unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES = 4_977_169_568;
export const DEFAULT_LLAMA_CPP_CONTEXT_SIZE = 8192;

// 5 GB weights + KV cache + OS headroom. Below 16 GiB the bundled default
// thrashes, so the owner decision for 2026-07 is to omit that offer entirely.
const LLAMA_CPP_DEFAULT_MODEL_RAM_FLOOR_BYTES = 16 * 1024 ** 3;

export function meetsLlamaCppDefaultModelRamFloor(totalmemBytes = os.totalmem()): boolean {
  return totalmemBytes >= LLAMA_CPP_DEFAULT_MODEL_RAM_FLOOR_BYTES;
}

export function resolveLlamaCppModelCacheDir(provider?: ModelProviderConfig): string {
  const configured = provider?.params?.modelCacheDir;
  return typeof configured === "string" && configured.trim()
    ? resolveHomePath(configured.trim())
    : path.join(os.homedir(), ".node-llama-cpp", "models");
}

function resolveHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveLlamaCppModelSource(model: {
  id: string;
  params?: Record<string, unknown>;
}): string {
  const configured = model.params?.modelPath;
  if (typeof configured === "string" && configured.trim()) {
    return resolveHomePath(configured.trim());
  }
  return model.id === DEFAULT_LLAMA_CPP_MODEL_ID
    ? DEFAULT_LLAMA_CPP_MODEL_URI
    : resolveHomePath(model.id);
}

export function resolveCachedLlamaCppModelPath(params: {
  model: Pick<ModelDefinitionConfig, "id" | "params">;
  provider?: ModelProviderConfig;
}): string | null {
  const source = resolveLlamaCppModelSource(params.model);
  const cacheDir = resolveLlamaCppModelCacheDir(params.provider);
  if (source === DEFAULT_LLAMA_CPP_MODEL_URI) {
    return path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
  }
  if (/^hf:/i.test(source)) {
    return null;
  }
  if (/^https?:\/\//i.test(source)) {
    return null;
  }
  const localPath = resolveHomePath(source);
  return path.isAbsolute(localPath) ? localPath : path.resolve(cacheDir, localPath);
}

function buildDefaultLlamaCppModel(): ModelDefinitionConfig {
  return {
    id: DEFAULT_LLAMA_CPP_MODEL_ID,
    name: "Gemma 4 E4B (Q4_K_M)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
    contextTokens: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
    maxTokens: 2048,
    params: {
      modelPath: DEFAULT_LLAMA_CPP_MODEL_URI,
      contextSize: "auto",
    },
    compat: { supportsTools: true, supportsUsageInStreaming: true },
  };
}

export function buildLlamaCppProviderConfig(existing?: ModelProviderConfig): ModelProviderConfig {
  const defaultModel = buildDefaultLlamaCppModel();
  const configuredModels = existing?.models ?? [];
  const models = configuredModels.some((model) => model.id === defaultModel.id)
    ? configuredModels
    : [...configuredModels, defaultModel];
  return {
    ...existing,
    baseUrl: existing?.baseUrl ?? LLAMA_CPP_LOCAL_BASE_URL,
    api: existing?.api ?? "openai-completions",
    models,
  };
}
