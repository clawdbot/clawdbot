import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import {
  applyProviderConfigDefaultsForConfig,
  normalizeProviderConfigForConfigDefaults,
} from "./provider-policy.js";
import { normalizeTalkConfig } from "./talk.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-6",

  // OpenAI
  gpt: "openai/gpt-5.4",
  "gpt-mini": "openai/gpt-5.4-mini",
  "gpt-nano": "openai/gpt-5.4-nano",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
  "gemini-flash-lite": "google/gemini-3.1-flash-lite-preview",
};

const DEFAULT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const DEFAULT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text"];
const DEFAULT_MODEL_MAX_TOKENS = 8192;
const MISTRAL_SAFE_MAX_TOKENS_BY_MODEL = {
  "devstral-medium-latest": 32_768,
  "magistral-small": 40_000,
  "mistral-large-latest": 16_384,
  "mistral-medium-2508": 8_192,
  "mistral-small-latest": 16_384,
  "pixtral-large-latest": 32_768,
} as const;

type ModelDefinitionLike = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveModelCost(
  raw?: Partial<ModelDefinitionConfig["cost"]>,
): ModelDefinitionConfig["cost"] {
  return {
    input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
    output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
    cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
    cacheWrite:
      typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite,
    ...(raw?.tieredPricing ? { tieredPricing: raw.tieredPricing } : {}),
  };
}

export function resolveNormalizedProviderModelMaxTokens(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
  rawMaxTokens: number;
}): number {
  const clamped = Math.min(params.rawMaxTokens, params.contextWindow);
  if (normalizeProviderId(params.providerId) !== "mistral" || clamped < params.contextWindow) {
    return clamped;
  }

  const safeMaxTokens =
    MISTRAL_SAFE_MAX_TOKENS_BY_MODEL[
      params.modelId as keyof typeof MISTRAL_SAFE_MAX_TOKENS_BY_MODEL
    ] ?? DEFAULT_MODEL_MAX_TOKENS;
  return Math.min(safeMaxTokens, params.contextWindow);
}

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

export function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const messages = cfg.messages;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckScope) {
    return cfg;
  }

  const nextMessages = messages ? { ...messages } : {};
  nextMessages.ackReactionScope = "group-mentions";
  return {
    ...cfg,
    messages: nextMessages,
  };
}

export function applySessionDefaults(
  cfg: OpenClawConfig,
  options: SessionDefaultsOptions = {},
): OpenClawConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) {
    return cfg;
  }

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  const next: OpenClawConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey is ignored; main session is always "main".');
  }

  return next;
}

export function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig {
  return normalizeTalkConfig(config);
}

export function applyModelDefaults(cfg: OpenClawConfig): OpenClawConfig {
  let mutated = false;
  let nextCfg = cfg;

  const providerConfig = nextCfg.models?.providers;
  if (providerConfig) {
    const nextProviders = { ...providerConfig };
    for (const [providerId, provider] of Object.entries(providerConfig)) {
      const normalizedProvider = normalizeProviderConfigForConfigDefaults({
        provider: providerId,
        providerConfig: provider,
      });
      const models = normalizedProvider.models;
      if (!Array.isArray(models) || models.length === 0) {
        if (normalizedProvider !== provider) {
          nextProviders[providerId] = normalizedProvider;
          mutated = true;
        }
        continue;
      }
      const providerApi = normalizedProvider.api;
      let nextProvider = normalizedProvider;
      if (nextProvider !== provider) {
        mutated = true;
      }
      let providerMutated = false;
      const nextModels = models.map((model) => {
        const raw = model as ModelDefinitionLike;
        let modelMutated = false;

        const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : false;
        if (raw.reasoning !== reasoning) {
          modelMutated = true;
        }

        const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
        if (raw.input === undefined) {
          modelMutated = true;
        }

        const cost = resolveModelCost(raw.cost);
        const costMutated =
          !raw.cost ||
          raw.cost.input !== cost.input ||
          raw.cost.output !== cost.output ||
          raw.cost.cacheRead !== cost.cacheRead ||
          raw.cost.cacheWrite !== cost.cacheWrite;
        if (costMutated) {
          modelMutated = true;
        }

        const contextWindow = isPositiveNumber(raw.contextWindow)
          ? raw.contextWindow
          : DEFAULT_CONTEXT_TOKENS;
        if (raw.contextWindow !== contextWindow) {
          modelMutated = true;
        }

        const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
        const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
        const maxTokens = resolveNormalizedProviderModelMaxTokens({
          providerId,
          modelId: raw.id,
          contextWindow,
          rawMaxTokens,
        });
        if (raw.maxTokens !== maxTokens) {
          modelMutated = true;
        }
        const api = raw.api ?? providerApi;
        if (raw.api !== api) {
          modelMutated = true;
        }

        if (!modelMutated) {
          return model;
        }
        providerMutated = true;
        return Object.assign({}, raw, {
          reasoning,
          input,
          cost,
          contextWindow,
          maxTokens,
          api,
        }) as ModelDefinitionConfig;
      });

      if (!providerMutated) {
        if (nextProvider !== provider) {
          nextProviders[providerId] = nextProvider;
        }
        continue;
      }
      nextProviders[providerId] = { ...nextProvider, models: nextModels };
      mutated = true;
    }

    if (mutated) {
      nextCfg = {
        ...nextCfg,
        models: {
          ...nextCfg.models,
          providers: nextProviders,
        },
      };
    }
  }

  const existingAgent = nextCfg.agents?.defaults;
  if (!existingAgent) {
    return mutated ? nextCfg : cfg;
  }
  const existingModels = existingAgent.models ?? {};
  if (Object.keys(existingModels).length === 0) {
    return mutated ? nextCfg : cfg;
  }

  const nextModels: Record<string, { alias?: string }> = {
    ...existingModels,
  };

  for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    const entry = nextModels[target];
    if (!entry) {
      continue;
    }
    if (entry.alias !== undefined) {
      continue;
    }
    nextModels[target] = { ...entry, alias };
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...nextCfg,
    agents: {
      ...nextCfg.agents,
      defaults: { ...existingAgent, models: nextModels },
    },
  };
}

export function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const agents = cfg.agents;
  const defaults = agents?.defaults;
  const hasMax =
    typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
  const hasSubMax =
    typeof defaults?.subagents?.maxConcurrent === "number" &&
    Number.isFinite(defaults.subagents.maxConcurrent);
  if (hasMax && hasSubMax) {
    return cfg;
  }

  let mutated = false;
  const nextDefaults = defaults ? { ...defaults } : {};
  if (!hasMax) {
    nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
    mutated = true;
  }

  const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
  if (!hasSubMax) {
    nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: {
        ...nextDefaults,
        subagents: nextSubagents,
      },
    },
  };
}

export function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const logging = cfg.logging;
  if (!logging) {
    return cfg;
  }
  if (logging.redactSensitive) {
    return cfg;
  }
  return {
    ...cfg,
    logging: {
      ...logging,
      redactSensitive: "tools",
    },
  };
}

function hasAnthropicDefaultSignal(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
    return true;
  }
  const profiles = cfg.auth?.profiles;
  if (profiles) {
    for (const profile of Object.values(profiles)) {
      const provider = normalizeProviderId(profile?.provider);
      if (provider === "anthropic" || provider === "claude-cli") {
        return true;
      }
    }
  }
  const order = cfg.auth?.order;
  if (!order) {
    return false;
  }
  return Object.keys(order).some((provider) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (normalizedProvider !== "anthropic" && normalizedProvider !== "claude-cli") {
      return false;
    }
    return (order as Record<string, unknown>)[provider] !== undefined;
  });
}

export function applyContextPruningDefaults(cfg: OpenClawConfig): OpenClawConfig {
  if (!cfg.agents?.defaults) {
    return cfg;
  }
  if (!hasAnthropicDefaultSignal(cfg, process.env)) {
    return cfg;
  }
  return (
    applyProviderConfigDefaultsForConfig({
      provider: "anthropic",
      config: cfg,
      env: process.env,
    }) ?? cfg
  );
}

export function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) {
    return cfg;
  }
  const compaction = defaults?.compaction;
  if (compaction?.mode) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        compaction: {
          ...compaction,
          mode: "safeguard",
        },
      },
    },
  };
}

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
