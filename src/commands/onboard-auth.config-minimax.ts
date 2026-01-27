import type { MoltbotConfig } from "../config/config.js";
import {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MINIMAX_LM_STUDIO_COST,
} from "./onboard-auth.models.js";

export function applyMinimaxProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
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
  cfg: MoltbotConfig,
  params?: { baseUrl?: string },
): MoltbotConfig {
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
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasHostedModel = existingModels.some((model) => model.id === MINIMAX_HOSTED_MODEL_ID);
  const mergedModels = hasHostedModel ? existingModels : [...existingModels, hostedModel];
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

export function applyMinimaxConfig(cfg: MoltbotConfig): MoltbotConfig {
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
                fallbacks: (next.agents.defaults.model as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: "lmstudio/minimax-m2.1-gs32",
        },
      },
    },
  };
}

export function applyMinimaxHostedConfig(
  cfg: MoltbotConfig,
  params?: { baseUrl?: string },
): MoltbotConfig {
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
  cfg: MoltbotConfig,
  modelId: string = "MiniMax-M2.1",
): MoltbotConfig {
  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.minimax;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const apiModel = buildMinimaxApiModelDefinition(modelId);
  const hasApiModel = existingModels.some((model) => model.id === modelId);
  const mergedModels = hasApiModel ? existingModels : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
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
  cfg: MoltbotConfig,
  modelId: string = "MiniMax-M2.1",
): MoltbotConfig {
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
                fallbacks: (next.agents.defaults.model as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: `minimax/${modelId}`,
        },
      },
    },
  };
}
