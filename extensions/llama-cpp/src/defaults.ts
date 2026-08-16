import os from "node:os";
import path from "node:path";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const LLAMA_CPP_PROVIDER_ID = "llama-cpp";
export const LLAMA_CPP_PROVIDER_LABEL = "llama.cpp";
const LLAMA_CPP_LOCAL_AUTH_MARKER = "llama-cpp-local";
export const LLAMA_CPP_DEFAULT_PORT = 19_432;
const LLAMA_CPP_READY_TIMEOUT_MS = 30_000;
const LLAMA_CPP_IDLE_STOP_MS = 10 * 60_000;

export function resolveLlamaCppSyntheticApiKey(): string {
  return LLAMA_CPP_LOCAL_AUTH_MARKER;
}

export const DEFAULT_LLAMA_CPP_MODEL_ID = "gemma-4-e4b-it-q4_k_m";
export const DEFAULT_LLAMA_CPP_MODEL_REF = `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`;
export const DEFAULT_LLAMA_CPP_MODEL_URI =
  "hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_REVISION = "bfc15c382204943c3a8fff0c750b94ae2364d7a3";
export const DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE =
  "hf_unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES = 4_977_171_584;
export const DEFAULT_LLAMA_CPP_MODEL_SHA256 =
  "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87";
// The full OpenClaw agent system prompt alone is ~31K tokens, so 8K overflows on
// the first turn. 64K leaves real headroom for history and tool output; Gemma 4
// supports far more, and the 16 GiB offer floor already bounds weaker machines.
export const DEFAULT_LLAMA_CPP_CONTEXT_SIZE = 65536;

export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_REVISION =
  "66f974f8cd48cc3b9c41c516b95508e75b4bee64";
export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID = "embeddinggemma-300m-qat-q8_0";
export const DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE =
  "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf";
export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES = 328_577_056;
export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256 =
  "6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67";

// 5 GB weights + KV cache + OS headroom. Below 16 GiB the default model
// thrashes, so onboarding omits the download offer entirely.
const LLAMA_CPP_DEFAULT_MODEL_RAM_FLOOR_BYTES = 16 * 1024 ** 3;

export function meetsLlamaCppDefaultModelRamFloor(totalmemBytes = os.totalmem()): boolean {
  return totalmemBytes >= LLAMA_CPP_DEFAULT_MODEL_RAM_FLOOR_BYTES;
}

export function resolveLlamaCppDataDir(): string {
  return path.join(resolveStateDir(), "tools", "llama.cpp");
}

export function resolveLlamaCppModelCacheDir(provider?: ModelProviderConfig): string {
  const configured = provider?.params?.modelCacheDir;
  return typeof configured === "string" && configured.trim()
    ? resolveHomePath(configured.trim())
    : path.join(resolveStateDir(), "models", "llama.cpp");
}

export function resolveLegacyLlamaCppModelCacheDir(): string {
  return path.join(os.homedir(), ".node-llama-cpp", "models");
}

export function resolveHomePath(value: string): string {
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
  if (/^(?:hf:|https?:\/\/)/iu.test(source)) {
    return null;
  }
  return path.isAbsolute(source) ? source : path.resolve(cacheDir, source);
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
      contextSize: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
    },
    compat: {
      supportsTools: true,
      supportsUsageInStreaming: true,
      toolSchemaProfile: "llamacpp",
    },
  };
}

export function buildLlamaCppProviderConfig(
  existing?: ModelProviderConfig,
  managed?: {
    baseUrl: string;
    command: string;
    args: string[];
    healthUrl: string;
  },
): ModelProviderConfig {
  const defaultModel = buildDefaultLlamaCppModel();
  const configuredModels = existing?.models ?? [];
  const models = configuredModels.some((model) => model.id === defaultModel.id)
    ? configuredModels
    : [...configuredModels, defaultModel];
  return {
    ...existing,
    baseUrl:
      managed?.baseUrl ?? existing?.baseUrl ?? `http://127.0.0.1:${LLAMA_CPP_DEFAULT_PORT}/v1`,
    apiKey: existing?.apiKey ?? resolveLlamaCppSyntheticApiKey(),
    api: "openai-completions",
    timeoutSeconds: existing?.timeoutSeconds ?? 600,
    ...(managed
      ? {
          localService: {
            command: managed.command,
            args: managed.args,
            healthUrl: managed.healthUrl,
            readyTimeoutMs: LLAMA_CPP_READY_TIMEOUT_MS,
            idleStopMs: LLAMA_CPP_IDLE_STOP_MS,
          },
        }
      : {}),
    models,
  };
}
