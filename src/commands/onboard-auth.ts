import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../agents/opencode-zen-models.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 200000;
const DEFAULT_MINIMAX_MAX_TOKENS = 8192;
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
export const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
export const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.1";
export const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};
const MINIMAX_HOSTED_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const MINIMAX_LM_STUDIO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const SYNTHETIC_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const SYNTHETIC_MODEL_CATALOG = [
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

const MINIMAX_MODEL_CATALOG = {
  "MiniMax-M2.1": { name: "MiniMax M2.1", reasoning: false },
  "MiniMax-M2.1-lightning": {
    name: "MiniMax M2.1 Lightning",
    reasoning: false,
  },
  "MiniMax-M2": { name: "MiniMax M2", reasoning: true },
} as const;

type MinimaxCatalogId = keyof typeof MINIMAX_MODEL_CATALOG;

function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_MODEL_CATALOG[params.id as MinimaxCatalogId];
  const fallbackReasoning = params.id === "MiniMax-M2";
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? fallbackReasoning,
    input: ["text"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}

function buildMinimaxApiModelDefinition(
  modelId: string,
): ModelDefinitionConfig {
  return buildMinimaxModelDefinition({
    id: modelId,
    cost: MINIMAX_API_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
}

function buildMoonshotModelDefinition(): ModelDefinitionConfig {
  return {
    id: MOONSHOT_DEFAULT_MODEL_ID,
    name: "Kimi K2 0905 Preview",
    reasoning: false,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  };
}

type SyntheticCatalogEntry = (typeof SYNTHETIC_MODEL_CATALOG)[number];

function buildSyntheticModelDefinition(
  entry: SyntheticCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: SYNTHETIC_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

export async function writeOAuthCredentials(
  provider: OAuthProvider,
  creds: OAuthCredentials,
  agentDir?: string,
): Promise<void> {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: `${provider}:${creds.email ?? "default"}`,
    credential: {
      type: "oauth",
      provider,
      ...creds,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setAnthropicApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: {
      type: "api_key",
      provider: "anthropic",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setGeminiApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "google:default",
    credential: {
      type: "api_key",
      provider: "google",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setMinimaxApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "minimax:default",
    credential: {
      type: "api_key",
      provider: "minimax",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setMoonshotApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "moonshot:default",
    credential: {
      type: "api_key",
      provider: "moonshot",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setSyntheticApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "synthetic:default",
    credential: {
      type: "api_key",
      provider: "synthetic",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export const ZAI_DEFAULT_MODEL_REF = "zai/glm-4.7";
export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";

export async function setZaiApiKey(key: string, agentDir?: string) {
  // Write to the multi-agent path so gateway finds credentials on startup
  upsertAuthProfile({
    profileId: "zai:default",
    credential: {
      type: "api_key",
      provider: "zai",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export async function setOpenrouterApiKey(key: string, agentDir?: string) {
  upsertAuthProfile({
    profileId: "openrouter:default",
    credential: {
      type: "api_key",
      provider: "openrouter",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export function applyZaiConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ZAI_DEFAULT_MODEL_REF] = {
    ...models[ZAI_DEFAULT_MODEL_REF],
    alias: models[ZAI_DEFAULT_MODEL_REF]?.alias ?? "GLM",
  };

  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel &&
          "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] })
                  .fallbacks,
              }
            : undefined),
          primary: ZAI_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyOpenrouterProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENROUTER_DEFAULT_MODEL_REF] = {
    ...models[OPENROUTER_DEFAULT_MODEL_REF],
    alias: models[OPENROUTER_DEFAULT_MODEL_REF]?.alias ?? "OpenRouter",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpenrouterConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applyOpenrouterProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel &&
          "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] })
                  .fallbacks,
              }
            : undefined),
          primary: OPENROUTER_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyMoonshotProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MOONSHOT_DEFAULT_MODEL_REF] = {
    ...models[MOONSHOT_DEFAULT_MODEL_REF],
    alias: models[MOONSHOT_DEFAULT_MODEL_REF]?.alias ?? "Kimi K2",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.moonshot;
  const existingModels = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];
  const defaultModel = buildMoonshotModelDefinition();
  const hasDefaultModel = existingModels.some(
    (model) => model.id === MOONSHOT_DEFAULT_MODEL_ID,
  );
  const mergedModels = hasDefaultModel
    ? existingModels
    : [...existingModels, defaultModel];
  const { apiKey: existingApiKey, ...existingProviderRest } =
    (existingProvider ?? {}) as Record<string, unknown> as { apiKey?: string };
  const resolvedApiKey =
    typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.moonshot = {
    ...existingProviderRest,
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [defaultModel],
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyMoonshotConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applyMoonshotProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel &&
          "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] })
                  .fallbacks,
              }
            : undefined),
          primary: MOONSHOT_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applySyntheticProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SYNTHETIC_DEFAULT_MODEL_REF] = {
    ...models[SYNTHETIC_DEFAULT_MODEL_REF],
    alias:
      models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.1",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.synthetic;
  const existingModels = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];
  const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(
    buildSyntheticModelDefinition,
  );
  const mergedModels = [
    ...existingModels,
    ...syntheticModels.filter(
      (model) => !existingModels.some((existing) => existing.id === model.id),
    ),
  ];
  const { apiKey: existingApiKey, ...existingProviderRest } =
    (existingProvider ?? {}) as Record<string, unknown> as { apiKey?: string };
  const resolvedApiKey =
    typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.synthetic = {
    ...existingProviderRest,
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : syntheticModels,
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applySyntheticConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applySyntheticProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel &&
          "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] })
                  .fallbacks,
              }
            : undefined),
          primary: SYNTHETIC_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyAuthProfileConfig(
  cfg: ClawdbotConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    preferProfileFirst?: boolean;
  },
): ClawdbotConfig {
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
    },
  };

  // Only maintain `auth.order` when the user explicitly configured it.
  // Default behavior: no explicit order -> resolveAuthProfileOrder can round-robin by lastUsed.
  const existingProviderOrder = cfg.auth?.order?.[params.provider];
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter(
            (profileId) => profileId !== params.profileId,
          ),
        ]
      : existingProviderOrder;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...cfg.auth?.order,
          [params.provider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : cfg.auth?.order;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}

export function applyMinimaxProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models["anthropic/claude-opus-4-5"] = {
    ...models["anthropic/claude-opus-4-5"],
    alias: models["anthropic/claude-opus-4-5"]?.alias ?? "Opus",
  };
  models["lmstudio/minimax-m2.1-gs32"] = {
    ...models["lmstudio/minimax-m2.1-gs32"],
    alias: models["lmstudio/minimax-m2.1-gs32"]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  if (!providers.lmstudio) {
    providers.lmstudio = {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lmstudio",
      api: "openai-responses",
      models: [
        buildMinimaxModelDefinition({
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          cost: MINIMAX_LM_STUDIO_COST,
          contextWindow: 196608,
          maxTokens: 8192,
        }),
      ],
    };
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyMinimaxHostedProviderConfig(
  cfg: ClawdbotConfig,
  params?: { baseUrl?: string },
): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MINIMAX_HOSTED_MODEL_REF] = {
    ...models[MINIMAX_HOSTED_MODEL_REF],
    alias: models[MINIMAX_HOSTED_MODEL_REF]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  const hostedModel = buildMinimaxModelDefinition({
    id: MINIMAX_HOSTED_MODEL_ID,
    cost: MINIMAX_HOSTED_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
  const existingProvider = providers.minimax;
  const existingModels = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];
  const hasHostedModel = existingModels.some(
    (model) => model.id === MINIMAX_HOSTED_MODEL_ID,
  );
  const mergedModels = hasHostedModel
    ? existingModels
    : [...existingModels, hostedModel];
  providers.minimax = {
    ...existingProvider,
    baseUrl: params?.baseUrl?.trim() || DEFAULT_MINIMAX_BASE_URL,
    apiKey: "minimax",
    api: "openai-completions",
    models: mergedModels.length > 0 ? mergedModels : [hostedModel],
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyMinimaxConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applyMinimaxProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(next.agents?.defaults?.model &&
          "fallbacks" in (next.agents.defaults.model as Record<string, unknown>)
            ? {
                fallbacks: (
                  next.agents.defaults.model as { fallbacks?: string[] }
                ).fallbacks,
              }
            : undefined),
          primary: "lmstudio/minimax-m2.1-gs32",
        },
      },
    },
  };
}

export function applyMinimaxHostedConfig(
  cfg: ClawdbotConfig,
  params?: { baseUrl?: string },
): ClawdbotConfig {
  const next = applyMinimaxHostedProviderConfig(cfg, params);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...next.agents?.defaults?.model,
          primary: MINIMAX_HOSTED_MODEL_REF,
        },
      },
    },
  };
}

// MiniMax Anthropic-compatible API (platform.minimax.io/anthropic)
export function applyMinimaxApiProviderConfig(
  cfg: ClawdbotConfig,
  modelId: string = "MiniMax-M2.1",
): ClawdbotConfig {
  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.minimax;
  const existingModels = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];
  const apiModel = buildMinimaxApiModelDefinition(modelId);
  const hasApiModel = existingModels.some((model) => model.id === modelId);
  const mergedModels = hasApiModel
    ? existingModels
    : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } =
    (existingProvider ?? {}) as Record<string, unknown> as { apiKey?: string };
  const resolvedApiKey =
    typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey =
    resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
  providers.minimax = {
    ...existingProviderRest,
    baseUrl: MINIMAX_API_BASE_URL,
    api: "anthropic-messages",
    ...(normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [apiModel],
  };

  const models = { ...cfg.agents?.defaults?.models };
  models[`minimax/${modelId}`] = {
    ...models[`minimax/${modelId}`],
    alias: "Minimax",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: { mode: cfg.models?.mode ?? "merge", providers },
  };
}

export function applyMinimaxApiConfig(
  cfg: ClawdbotConfig,
  modelId: string = "MiniMax-M2.1",
): ClawdbotConfig {
  const next = applyMinimaxApiProviderConfig(cfg, modelId);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(next.agents?.defaults?.model &&
          "fallbacks" in (next.agents.defaults.model as Record<string, unknown>)
            ? {
                fallbacks: (
                  next.agents.defaults.model as { fallbacks?: string[] }
                ).fallbacks,
              }
            : undefined),
          primary: `minimax/${modelId}`,
        },
      },
    },
  };
}

export async function setOpencodeZenApiKey(key: string, agentDir?: string) {
  upsertAuthProfile({
    profileId: "opencode:default",
    credential: {
      type: "api_key",
      provider: "opencode",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export function applyOpencodeZenProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  // Use the built-in opencode provider from pi-ai; only seed the allowlist alias.
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpencodeZenConfig(cfg: ClawdbotConfig): ClawdbotConfig {
  const next = applyOpencodeZenProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(next.agents?.defaults?.model &&
          "fallbacks" in (next.agents.defaults.model as Record<string, unknown>)
            ? {
                fallbacks: (
                  next.agents.defaults.model as { fallbacks?: string[] }
                ).fallbacks,
              }
            : undefined),
          primary: OPENCODE_ZEN_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
