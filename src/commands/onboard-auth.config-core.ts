import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "../agents/synthetic-models.js";
import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
} from "../agents/venice-models.js";
import type { MoltbotConfig } from "../config/config.js";
import {
  OPENROUTER_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";
import {
  buildKimiCodeModelDefinition,
  buildMoonshotModelDefinition,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_MODEL_ID,
  KIMI_CODE_MODEL_REF,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard-auth.models.js";

export function applyZaiConfig(cfg: MoltbotConfig): MoltbotConfig {
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
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: ZAI_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyOpenrouterProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
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

export function applyVercelAiGatewayProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Vercel AI Gateway",
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

export function applyVercelAiGatewayConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyVercelAiGatewayProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyOpenrouterConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyOpenrouterProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: OPENROUTER_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyMoonshotProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MOONSHOT_DEFAULT_MODEL_REF] = {
    ...models[MOONSHOT_DEFAULT_MODEL_REF],
    alias: models[MOONSHOT_DEFAULT_MODEL_REF]?.alias ?? "Kimi K2",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.moonshot;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModel = buildMoonshotModelDefinition();
  const hasDefaultModel = existingModels.some((model) => model.id === MOONSHOT_DEFAULT_MODEL_ID);
  const mergedModels = hasDefaultModel ? existingModels : [...existingModels, defaultModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
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

export function applyMoonshotConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyMoonshotProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: MOONSHOT_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyKimiCodeProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KIMI_CODE_MODEL_REF] = {
    ...models[KIMI_CODE_MODEL_REF],
    alias: models[KIMI_CODE_MODEL_REF]?.alias ?? "Kimi Code",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers["kimi-code"];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModel = buildKimiCodeModelDefinition();
  const hasDefaultModel = existingModels.some((model) => model.id === KIMI_CODE_MODEL_ID);
  const mergedModels = hasDefaultModel ? existingModels : [...existingModels, defaultModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers["kimi-code"] = {
    ...existingProviderRest,
    baseUrl: KIMI_CODE_BASE_URL,
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

export function applyKimiCodeConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyKimiCodeProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: KIMI_CODE_MODEL_REF,
        },
      },
    },
  };
}

export function applySyntheticProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SYNTHETIC_DEFAULT_MODEL_REF] = {
    ...models[SYNTHETIC_DEFAULT_MODEL_REF],
    alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.1",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.synthetic;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition);
  const mergedModels = [
    ...existingModels,
    ...syntheticModels.filter(
      (model) => !existingModels.some((existing) => existing.id === model.id),
    ),
  ];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
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

export function applySyntheticConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applySyntheticProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: SYNTHETIC_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

/**
 * Apply Venice provider configuration without changing the default model.
 * Registers Venice models and sets up the provider, but preserves existing model selection.
 */
export function applyVeniceProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VENICE_DEFAULT_MODEL_REF] = {
    ...models[VENICE_DEFAULT_MODEL_REF],
    alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "Llama 3.3 70B",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.venice;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const veniceModels = VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  const mergedModels = [
    ...existingModels,
    ...veniceModels.filter((model) => !existingModels.some((existing) => existing.id === model.id)),
  ];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.venice = {
    ...existingProviderRest,
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : veniceModels,
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

/**
 * Apply Venice provider configuration AND set Venice as the default model.
 * Use this when Venice is the primary provider choice during onboarding.
 */
export function applyVeniceConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyVeniceProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: VENICE_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

/**
 * Apply LiteLLM provider configuration without changing the default model.
 * LiteLLM is a flexible proxy that supports many models, so base URL and model
 * are user-configurable.
 */
export function applyLitellmProviderConfig(
  cfg: MoltbotConfig,
  params: {
    baseUrl: string;
    modelId: string;
    modelName?: string;
    contextWindow?: number;
    maxTokens?: number;
  },
): MoltbotConfig {
  const modelRef = `litellm/${params.modelId}`;
  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? params.modelName ?? params.modelId,
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.litellm;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  // Detect Claude models and use Anthropic Messages API for proper cache control support
  const isClaude = params.modelId.toLowerCase().startsWith("claude-");
  const newModel = {
    id: params.modelId,
    name: params.modelName ?? params.modelId,
    // Claude models through LiteLLM should use anthropic-messages API for cache control
    ...(isClaude ? { api: "anthropic-messages" as const } : {}),
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? 128000,
    maxTokens: params.maxTokens ?? 8192,
    // LiteLLM proxies to various providers that may not support the OpenAI Responses API
    // `store` parameter. Disable it to avoid "Extra inputs are not permitted" errors.
    compat: { supportsStore: false },
  };
  const hasModel = existingModels.some((model) => model.id === params.modelId);
  const mergedModels = hasModel ? existingModels : [...existingModels, newModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.litellm = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [newModel],
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

/**
 * Apply LiteLLM provider configuration AND set LiteLLM as the default model.
 * Use this when LiteLLM is the primary provider choice during onboarding.
 */
export function applyLitellmConfig(
  cfg: MoltbotConfig,
  params: {
    baseUrl: string;
    modelId: string;
    modelName?: string;
    contextWindow?: number;
    maxTokens?: number;
  },
): MoltbotConfig {
  const next = applyLitellmProviderConfig(cfg, params);
  const modelRef = `litellm/${params.modelId}`;
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

export function applyAuthProfileConfig(
  cfg: MoltbotConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    preferProfileFirst?: boolean;
  },
): MoltbotConfig {
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
          ...existingProviderOrder.filter((profileId) => profileId !== params.profileId),
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
