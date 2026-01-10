import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import {
  getOpencodeZenStaticFallbackModels,
  OPENCODE_ZEN_API_BASE_URL,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
} from "../agents/opencode-zen-models.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 200000;
const DEFAULT_MINIMAX_MAX_TOKENS = 8192;
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
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
  providers.minimax = {
    baseUrl: MINIMAX_API_BASE_URL,
    // apiKey omitted: resolved via MINIMAX_API_KEY env var or auth profile by default.
    api: "anthropic-messages",
    models: [buildMinimaxApiModelDefinition(modelId)],
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
    profileId: "opencode-zen:default",
    credential: {
      type: "api_key",
      provider: "opencode-zen",
      key,
    },
    agentDir: agentDir ?? resolveDefaultAgentDir(),
  });
}

export function applyOpencodeZenProviderConfig(
  cfg: ClawdbotConfig,
): ClawdbotConfig {
  const opencodeModels = getOpencodeZenStaticFallbackModels();

  const providers = { ...cfg.models?.providers };
  providers["opencode-zen"] = {
    baseUrl: OPENCODE_ZEN_API_BASE_URL,
    apiKey: "opencode-zen",
    api: "openai-completions",
    models: opencodeModels,
  };

  const models = { ...cfg.agents?.defaults?.models };
  for (const model of opencodeModels) {
    const key = `opencode-zen/${model.id}`;
    models[key] = models[key] ?? {};
  }
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
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
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
