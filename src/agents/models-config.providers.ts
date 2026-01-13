import type { ClawdbotConfig } from "../config/config.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "./auth-profiles.js";
import { resolveEnvApiKey } from "./model-auth.js";

type ModelsConfig = NonNullable<ClawdbotConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.1";
const SYNTHETIC_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const SYNTHETIC_MODELS = [
  {
    id: SYNTHETIC_DEFAULT_MODEL_ID,
    name: "MiniMax M2.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 192000,
    maxTokens: 65536,
  },
  {
    id: "hf:moonshotai/Kimi-K2-Thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
  },
  {
    id: "hf:zai-org/GLM-4.7",
    name: "GLM-4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 128000,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-R1-0528",
    name: "DeepSeek R1 0528",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3-0324",
    name: "DeepSeek V3 0324",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3.1-Terminus",
    name: "DeepSeek V3.1 Terminus",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 159000,
    maxTokens: 8192,
  },
  {
    id: "hf:meta-llama/Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick 17B 128E Instruct FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: 524000,
    maxTokens: 8192,
  },
  {
    id: "hf:MiniMaxAI/MiniMax-M2",
    name: "MiniMax M2",
    reasoning: false,
    input: ["text"],
    contextWindow: 192000,
    maxTokens: 65536,
  },
  {
    id: "hf:moonshotai/Kimi-K2-Instruct-0905",
    name: "Kimi K2 Instruct 0905",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
  },
  {
    id: "hf:openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:Qwen/Qwen3-235B-A22B-Instruct-2507",
    name: "Qwen3 235B A22B Instruct 2507",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
  },
  {
    id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
    name: "Qwen3 Coder 480B A35B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
  },
  {
    id: "hf:Qwen/Qwen3-VL-235B-A22B-Instruct",
    name: "Qwen3 VL 235B A22B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 8192,
  },
  {
    id: "hf:zai-org/GLM-4.5",
    name: "GLM-4.5",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 128000,
  },
  {
    id: "hf:zai-org/GLM-4.6",
    name: "GLM-4.6",
    reasoning: false,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 128000,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    name: "Qwen3 235B A22B Thinking 2507",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
  },
] as const;

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function resolveEnvApiKeyVarName(provider: string): string | undefined {
  const resolved = resolveEnvApiKey(provider);
  if (!resolved) return undefined;
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): string | undefined {
  const ids = listProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const cred = params.store.profiles[id];
    if (!cred) continue;
    if (cred.type === "api_key") return cred.key;
    if (cred.type === "token") return cred.token;
  }
  return undefined;
}

export function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") return "gemini-3-pro-preview";
  if (id === "gemini-3-flash") return "gemini-3-flash-preview";
  return id;
}

function normalizeGoogleProvider(provider: ProviderConfig): ProviderConfig {
  let mutated = false;
  const models = provider.models.map((model) => {
    const nextId = normalizeGoogleModelId(model.id);
    if (nextId === model.id) return model;
    mutated = true;
    return { ...model, id: nextId };
  });
  return mutated ? { ...provider, models } : provider;
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) return providers;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    let normalizedProvider = provider;

    // Fix common misconfig: apiKey set to "${ENV_VAR}" instead of "ENV_VAR".
    if (
      normalizedProvider.apiKey &&
      normalizeApiKeyConfig(normalizedProvider.apiKey) !==
        normalizedProvider.apiKey
    ) {
      mutated = true;
      normalizedProvider = {
        ...normalizedProvider,
        apiKey: normalizeApiKeyConfig(normalizedProvider.apiKey),
      };
    }

    // If a provider defines models, pi's ModelRegistry requires apiKey to be set.
    // Fill it from the environment or auth profiles when possible.
    const hasModels =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0;
    if (hasModels && !normalizedProvider.apiKey?.trim()) {
      const fromEnv = resolveEnvApiKeyVarName(normalizedKey);
      const fromProfiles = resolveApiKeyFromProfiles({
        provider: normalizedKey,
        store: authStore,
      });
      const apiKey = fromEnv ?? fromProfiles;
      if (apiKey?.trim()) {
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey };
      }
    }

    if (normalizedKey === "google") {
      const googleNormalized = normalizeGoogleProvider(normalizedProvider);
      if (googleNormalized !== normalizedProvider) mutated = true;
      normalizedProvider = googleNormalized;
    }

    next[key] = normalizedProvider;
  }

  return mutated ? next : providers;
}

function buildMinimaxProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_API_BASE_URL,
    api: "anthropic-messages",
    models: [
      {
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.1",
        reasoning: false,
        input: ["text"],
        cost: MINIMAX_API_COST,
        contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
      },
      {
        id: MINIMAX_DEFAULT_VISION_MODEL_ID,
        name: "MiniMax VL 01",
        reasoning: false,
        input: ["text", "image"],
        cost: MINIMAX_API_COST,
        contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildMoonshotProvider(): ProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: MOONSHOT_DEFAULT_MODEL_ID,
        name: "Kimi K2 0905 Preview",
        reasoning: false,
        input: ["text"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildSyntheticProvider(): ProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: SYNTHETIC_DEFAULT_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

export function resolveImplicitProviders(params: {
  agentDir: string;
}): ModelsConfig["providers"] {
  const providers: Record<string, ProviderConfig> = {};
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  const minimaxKey =
    resolveEnvApiKeyVarName("minimax") ??
    resolveApiKeyFromProfiles({ provider: "minimax", store: authStore });
  if (minimaxKey) {
    providers.minimax = { ...buildMinimaxProvider(), apiKey: minimaxKey };
  }

  const moonshotKey =
    resolveEnvApiKeyVarName("moonshot") ??
    resolveApiKeyFromProfiles({ provider: "moonshot", store: authStore });
  if (moonshotKey) {
    providers.moonshot = { ...buildMoonshotProvider(), apiKey: moonshotKey };
  }

  const syntheticKey =
    resolveEnvApiKeyVarName("synthetic") ??
    resolveApiKeyFromProfiles({ provider: "synthetic", store: authStore });
  if (syntheticKey) {
    providers.synthetic = { ...buildSyntheticProvider(), apiKey: syntheticKey };
  }

  return providers;
}
