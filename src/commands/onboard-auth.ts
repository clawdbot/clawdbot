import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 200000;
const DEFAULT_MINIMAX_MAX_TOKENS = 8192;
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;

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
        {
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 196608,
          maxTokens: 8192,
        },
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
  const hostedModel: ModelDefinitionConfig = {
    id: MINIMAX_HOSTED_MODEL_ID,
    name: "MiniMax M2.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  };
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
