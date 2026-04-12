import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createThrowingRuntime,
  readJsonFile,
  type NonInteractiveRuntime,
} from "./onboard-non-interactive.test-helpers.js";

type OnboardEnv = {
  configPath: string;
  runtime: NonInteractiveRuntime;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MINIMAX_API_BASE_URL = "https://api.minimax.chat/v1";
const MINIMAX_CN_API_BASE_URL = "https://api.minimax.chat/v1";
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.4";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const TEST_AUTH_STORE_VERSION = 1;
const TEST_MAIN_AUTH_STORE_KEY = "__main__";

const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH must be set for provider auth onboarding tests");
    }
    let raw: string | null = null;
    try {
      raw = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const hash = raw === null ? undefined : crypto.createHash("sha256").update(raw).digest("hex");
    return {
      path: path.resolve(configPath),
      exists: raw !== null,
      valid: true,
      raw,
      hash,
      config: structuredClone(parsed),
      sourceConfig: structuredClone(parsed),
      runtimeConfig: structuredClone(parsed),
    };
  }),
);
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH must be set for provider auth onboarding tests");
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(params.nextConfig, null, 2)}\n`, "utf-8");
    return {
      path: configPath,
      previousHash: null,
      snapshot: {},
      nextConfig: params.nextConfig,
    };
  }),
);
const testAuthProfileStores = vi.hoisted(
  () => new Map<string, { version: number; profiles: Record<string, Record<string, unknown>> }>(),
);

function normalizeStoredSecret(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\r", "").replaceAll("\n", "").trim() : "";
}

function cloneTestAuthStore(store: {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
}) {
  return structuredClone(store);
}

function writeRuntimeAuthSnapshots() {
  if (!replaceRuntimeAuthProfileStoreSnapshots) {
    return;
  }
  replaceRuntimeAuthProfileStoreSnapshots(
    Array.from(testAuthProfileStores.entries()).map(([key, store]) =>
      key === TEST_MAIN_AUTH_STORE_KEY
        ? { store: cloneTestAuthStore(store) as never }
        : { agentDir: key, store: cloneTestAuthStore(store) as never },
    ),
  );
}

function getOrCreateTestAuthStore(agentDir?: string) {
  const key = agentDir?.trim() || TEST_MAIN_AUTH_STORE_KEY;
  let store = testAuthProfileStores.get(key);
  if (!store) {
    store = { version: TEST_AUTH_STORE_VERSION, profiles: {} };
    testAuthProfileStores.set(key, store);
  }
  return store;
}

function upsertAuthProfile(params: {
  profileId: string;
  credential: Record<string, unknown>;
  agentDir?: string;
}) {
  const credential =
    params.credential.type === "api_key" && typeof params.credential.key === "string"
      ? {
          ...params.credential,
          key: normalizeStoredSecret(params.credential.key),
        }
      : params.credential.type === "token" && typeof params.credential.token === "string"
        ? {
            ...params.credential,
            token: normalizeStoredSecret(params.credential.token),
          }
        : params.credential;
  for (const targetAgentDir of new Set([undefined, params.agentDir])) {
    const store = getOrCreateTestAuthStore(targetAgentDir);
    store.profiles[params.profileId] = credential;
  }
  writeRuntimeAuthSnapshots();
}

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  replaceConfigFile: replaceConfigFileMock,
  resolveGatewayPort: (cfg?: { gateway?: { port?: unknown } }) =>
    typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789,
}));

vi.mock("./onboard-non-interactive/local/auth-choice.plugin-providers.js", async () => {
  const [
    { resolveDefaultAgentId, resolveAgentDir, resolveAgentWorkspaceDir },
    { resolveDefaultAgentWorkspaceDir },
    { enablePluginInConfig },
    { configureOpenAICompatibleSelfHostedProviderNonInteractive },
    { detectZaiEndpoint },
  ] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/workspace.js"),
    import("../plugins/enable.js"),
    import("../plugins/provider-self-hosted-setup.js"),
    import("../plugins/provider-zai-endpoint.js"),
  ]);

  const ZAI_FALLBACKS = {
    "zai-api-key": {
      baseUrl: ZAI_GLOBAL_BASE_URL,
      modelId: "glm-5.1",
    },
    "zai-coding-cn": {
      baseUrl: ZAI_CODING_CN_BASE_URL,
      modelId: "glm-4.7",
    },
    "zai-coding-global": {
      baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
      modelId: "glm-5.1",
    },
  } as const;

  type HandlerContext = {
    authChoice: string;
    config: Record<string, unknown>;
    baseConfig: Record<string, unknown>;
    opts: Record<string, unknown>;
    runtime: {
      error: (message: string) => void;
      exit: (code: number) => void;
      log: (s: string) => void;
    };
    agentDir?: string;
    workspaceDir?: string;
    resolveApiKey: (input: {
      provider: string;
      flagValue?: string;
      flagName: `--${string}`;
      envVar: string;
      envVarName?: string;
      allowProfile?: boolean;
      required?: boolean;
    }) => Promise<{
      key: string;
      source: "profile" | "env" | "flag";
      envVarName?: string;
    } | null>;
    toApiKeyCredential: (input: {
      provider: string;
      resolved: {
        key: string;
        source: "profile" | "env" | "flag";
        envVarName?: string;
      };
      email?: string;
      metadata?: Record<string, string>;
    }) => Record<string, unknown> | null;
  };

  type ChoiceHandler = {
    providerId: string;
    label: string;
    pluginId?: string;
    runNonInteractive: (ctx: HandlerContext) => Promise<unknown>;
  };

  function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.replaceAll("\r", "").replaceAll("\n", "").trim() : "";
  }

  function withProviderConfig(
    cfg: Record<string, unknown>,
    providerId: string,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const models =
      cfg.models && typeof cfg.models === "object" ? (cfg.models as Record<string, unknown>) : {};
    const providers =
      models.providers && typeof models.providers === "object"
        ? (models.providers as Record<string, unknown>)
        : {};
    const existing =
      providers[providerId] && typeof providers[providerId] === "object"
        ? (providers[providerId] as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      models: {
        ...models,
        providers: {
          ...providers,
          [providerId]: {
            ...existing,
            ...patch,
          },
        },
      },
    };
  }

  function buildTestProviderModel(
    id: string,
    params?: {
      reasoning?: boolean;
      input?: Array<"text" | "image">;
      contextWindow?: number;
      maxTokens?: number;
    },
  ): Record<string, unknown> {
    return {
      id,
      name: id,
      reasoning: params?.reasoning ?? false,
      input: params?.input ?? ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: params?.contextWindow ?? 131072,
      maxTokens: params?.maxTokens ?? 16384,
    };
  }

  function applyAuthProfileConfig(
    cfg: Record<string, unknown>,
    params: {
      profileId: string;
      provider: string;
      mode: "api_key" | "oauth" | "token";
      email?: string;
      displayName?: string;
    },
  ): Record<string, unknown> {
    const auth =
      cfg.auth && typeof cfg.auth === "object" ? (cfg.auth as Record<string, unknown>) : {};
    const profiles =
      auth.profiles && typeof auth.profiles === "object"
        ? (auth.profiles as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      auth: {
        ...auth,
        profiles: {
          ...profiles,
          [params.profileId]: {
            provider: params.provider,
            mode: params.mode,
            ...(params.email ? { email: params.email } : {}),
            ...(params.displayName ? { displayName: params.displayName } : {}),
          },
        },
      },
    };
  }

  function applyPrimaryModel(cfg: Record<string, unknown>, model: string): Record<string, unknown> {
    const agents =
      cfg.agents && typeof cfg.agents === "object" ? (cfg.agents as Record<string, unknown>) : {};
    const defaults =
      agents.defaults && typeof agents.defaults === "object"
        ? (agents.defaults as Record<string, unknown>)
        : {};
    const models =
      defaults.models && typeof defaults.models === "object"
        ? (defaults.models as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      agents: {
        ...agents,
        defaults: {
          ...defaults,
          model: {
            primary: model,
          },
          models: {
            ...models,
            [model]: models[model] ?? {},
          },
        },
      },
    };
  }

  function createApiKeyChoice(params: {
    providerId: string;
    label: string;
    optionKey: string;
    flagName: `--${string}`;
    envVar: string;
    choiceId: string;
    pluginId?: string;
    defaultModel?: string;
    profileId?: string;
    profileIds?: string[];
    applyConfig?: (cfg: Record<string, unknown>) => Record<string, unknown>;
  }): ChoiceHandler {
    const profileIds =
      params.profileIds?.map((value) => value.trim()).filter(Boolean) ??
      (params.profileId ? [params.profileId] : [`${params.providerId}:default`]);
    return {
      providerId: params.providerId,
      label: params.label,
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
      runNonInteractive: async (ctx) => {
        const resolved = await ctx.resolveApiKey({
          provider: params.providerId,
          flagValue: normalizeText(ctx.opts[params.optionKey]),
          flagName: params.flagName,
          envVar: params.envVar,
        });
        if (!resolved) {
          return null;
        }
        if (resolved.source !== "profile") {
          for (const profileId of profileIds) {
            const credential = ctx.toApiKeyCredential({
              provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
              resolved,
            });
            if (!credential) {
              return null;
            }
            upsertAuthProfile({
              profileId,
              credential,
              agentDir: ctx.agentDir,
            });
          }
        }
        let next = ctx.config;
        for (const profileId of profileIds) {
          next = applyAuthProfileConfig(next, {
            profileId,
            provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
            mode: "api_key",
          });
        }
        if (params.applyConfig) {
          next = params.applyConfig(next);
        }
        return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
      },
    };
  }

  function createSelfHostedChoice(params: {
    providerId: string;
    label: string;
    defaultBaseUrl: string;
    defaultApiKeyEnvVar: string;
    modelPlaceholder: string;
  }): ChoiceHandler {
    return {
      providerId: params.providerId,
      label: params.label,
      runNonInteractive: async (ctx) =>
        await configureOpenAICompatibleSelfHostedProviderNonInteractive({
          ctx: ctx as never,
          providerId: params.providerId,
          providerLabel: params.label,
          defaultBaseUrl: params.defaultBaseUrl,
          defaultApiKeyEnvVar: params.defaultApiKeyEnvVar,
          modelPlaceholder: params.modelPlaceholder,
        }),
    };
  }

  function createZaiChoice(
    choiceId: "zai-api-key" | "zai-coding-cn" | "zai-coding-global",
  ): ChoiceHandler {
    return {
      providerId: "zai",
      label: "Z.AI",
      runNonInteractive: async (ctx) => {
        const resolved = await ctx.resolveApiKey({
          provider: "zai",
          flagValue: normalizeText(ctx.opts.zaiApiKey),
          flagName: "--zai-api-key",
          envVar: "ZAI_API_KEY",
        });
        if (!resolved) {
          return null;
        }
        if (resolved.source !== "profile") {
          const credential = ctx.toApiKeyCredential({ provider: "zai", resolved });
          if (!credential) {
            return null;
          }
          upsertAuthProfile({
            profileId: "zai:default",
            credential: credential as never,
            agentDir: ctx.agentDir,
          });
        }
        const detected = await detectZaiEndpoint({
          apiKey: resolved.key,
          ...(choiceId === "zai-coding-global"
            ? { endpoint: "coding-global" as const }
            : choiceId === "zai-coding-cn"
              ? { endpoint: "coding-cn" as const }
              : {}),
        });
        const fallback = ZAI_FALLBACKS[choiceId];
        let next = applyAuthProfileConfig(ctx.config as never, {
          profileId: "zai:default",
          provider: "zai",
          mode: "api_key",
        });
        next = withProviderConfig(next, "zai", {
          baseUrl: detected?.baseUrl ?? fallback.baseUrl,
          api: "openai-completions",
          models: [
            buildTestProviderModel(detected?.modelId ?? fallback.modelId, {
              input: ["text"],
            }),
          ],
        });
        return applyPrimaryModel(next as never, `zai/${detected?.modelId ?? fallback.modelId}`);
      },
    };
  }

  const cloudflareAiGatewayChoice: ChoiceHandler = {
    providerId: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    runNonInteractive: async (ctx) => {
      const accountId = normalizeText(ctx.opts.cloudflareAiGatewayAccountId);
      const gatewayId = normalizeText(ctx.opts.cloudflareAiGatewayGatewayId);
      const resolved = await ctx.resolveApiKey({
        provider: "cloudflare-ai-gateway",
        flagValue: normalizeText(ctx.opts.cloudflareAiGatewayApiKey),
        flagName: "--cloudflare-ai-gateway-api-key",
        envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      });
      if (!resolved) {
        return null;
      }
      if (resolved.source !== "profile") {
        const credential = ctx.toApiKeyCredential({
          provider: "cloudflare-ai-gateway",
          resolved,
          metadata: { accountId, gatewayId },
        });
        if (!credential) {
          return null;
        }
        upsertAuthProfile({
          profileId: "cloudflare-ai-gateway:default",
          credential: credential as never,
          agentDir: ctx.agentDir,
        });
      }
      const withProfile = applyAuthProfileConfig(ctx.config as never, {
        profileId: "cloudflare-ai-gateway:default",
        provider: "cloudflare-ai-gateway",
        mode: "api_key",
      });
      return applyPrimaryModel(withProfile, "cloudflare-ai-gateway/claude-sonnet-4-5");
    },
  };

  const choiceMap = new Map<string, ChoiceHandler>([
    [
      "setup-token",
      {
        providerId: "anthropic",
        label: "Anthropic setup-token",
        async runNonInteractive(ctx) {
          const token = normalizeText(ctx.opts.token);
          if (!token) {
            ctx.runtime.error("Anthropic setup-token auth requires --token.");
            ctx.runtime.exit(1);
            return null;
          }
          upsertAuthProfile({
            profileId: (ctx.opts.tokenProfileId as string | undefined) ?? "anthropic:default",
            credential: {
              type: "token",
              provider: "anthropic",
              token,
            } as never,
            agentDir: ctx.agentDir,
          });
          const withProfile = applyAuthProfileConfig(ctx.config as never, {
            profileId: (ctx.opts.tokenProfileId as string | undefined) ?? "anthropic:default",
            provider: "anthropic",
            mode: "token",
          });
          return applyPrimaryModel(withProfile, "anthropic/claude-sonnet-4-6");
        },
      },
    ],
    [
      "apiKey",
      createApiKeyChoice({
        providerId: "anthropic",
        label: "Anthropic",
        choiceId: "apiKey",
        optionKey: "anthropicApiKey",
        flagName: "--anthropic-api-key",
        envVar: "ANTHROPIC_API_KEY",
      }),
    ],
    [
      "minimax-global-api",
      createApiKeyChoice({
        providerId: "minimax",
        label: "MiniMax",
        choiceId: "minimax-global-api",
        optionKey: "minimaxApiKey",
        flagName: "--minimax-api-key",
        envVar: "MINIMAX_API_KEY",
        profileId: "minimax:global",
        defaultModel: "minimax/MiniMax-M2.7",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "minimax", {
            baseUrl: MINIMAX_API_BASE_URL,
            api: "anthropic-messages",
            models: [buildTestProviderModel("MiniMax-M2.7")],
          }),
      }),
    ],
    [
      "minimax-cn-api",
      createApiKeyChoice({
        providerId: "minimax",
        label: "MiniMax",
        choiceId: "minimax-cn-api",
        optionKey: "minimaxApiKey",
        flagName: "--minimax-api-key",
        envVar: "MINIMAX_API_KEY",
        profileId: "minimax:cn",
        defaultModel: "minimax/MiniMax-M2.7",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "minimax", {
            baseUrl: MINIMAX_CN_API_BASE_URL,
            api: "anthropic-messages",
            models: [buildTestProviderModel("MiniMax-M2.7")],
          }),
      }),
    ],
    ["zai-api-key", createZaiChoice("zai-api-key")],
    ["zai-coding-cn", createZaiChoice("zai-coding-cn")],
    ["zai-coding-global", createZaiChoice("zai-coding-global")],
    [
      "xai-api-key",
      createApiKeyChoice({
        providerId: "xai",
        label: "xAI",
        choiceId: "xai-api-key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        defaultModel: "xai/grok-4",
      }),
    ],
    [
      "mistral-api-key",
      createApiKeyChoice({
        providerId: "mistral",
        label: "Mistral",
        choiceId: "mistral-api-key",
        optionKey: "mistralApiKey",
        flagName: "--mistral-api-key",
        envVar: "MISTRAL_API_KEY",
        defaultModel: "mistral/mistral-large-latest",
      }),
    ],
    [
      "volcengine-api-key",
      createApiKeyChoice({
        providerId: "volcengine",
        label: "Volcano Engine",
        choiceId: "volcengine-api-key",
        optionKey: "volcengineApiKey",
        flagName: "--volcengine-api-key",
        envVar: "VOLCANO_ENGINE_API_KEY",
        defaultModel: "volcengine-plan/ark-code-latest",
      }),
    ],
    [
      "byteplus-api-key",
      createApiKeyChoice({
        providerId: "byteplus",
        label: "BytePlus",
        choiceId: "byteplus-api-key",
        optionKey: "byteplusApiKey",
        flagName: "--byteplus-api-key",
        envVar: "BYTEPLUS_API_KEY",
        defaultModel: "byteplus-plan/ark-code-latest",
      }),
    ],
    [
      "ai-gateway-api-key",
      createApiKeyChoice({
        providerId: "vercel-ai-gateway",
        label: "Vercel AI Gateway",
        choiceId: "ai-gateway-api-key",
        optionKey: "aiGatewayApiKey",
        flagName: "--ai-gateway-api-key",
        envVar: "AI_GATEWAY_API_KEY",
        defaultModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      }),
    ],
    [
      "openai-api-key",
      createApiKeyChoice({
        providerId: "openai",
        label: "OpenAI",
        choiceId: "openai-api-key",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
        defaultModel: OPENAI_DEFAULT_MODEL,
      }),
    ],
    [
      "openrouter-api-key",
      createApiKeyChoice({
        providerId: "openrouter",
        label: "OpenRouter",
        choiceId: "openrouter-api-key",
        optionKey: "openrouterApiKey",
        flagName: "--openrouter-api-key",
        envVar: "OPENROUTER_API_KEY",
      }),
    ],
    [
      "opencode-zen",
      createApiKeyChoice({
        providerId: "opencode",
        label: "OpenCode",
        choiceId: "opencode-zen",
        optionKey: "opencodeApiKey",
        flagName: "--opencode-api-key",
        envVar: "OPENCODE_ZEN_API_KEY",
        profileIds: ["opencode:default", "opencode-go:default"],
        defaultModel: "opencode/claude-opus-4-6",
      }),
    ],
    [
      "vllm",
      createSelfHostedChoice({
        providerId: "vllm",
        label: "vLLM",
        defaultBaseUrl: "http://127.0.0.1:8000/v1",
        defaultApiKeyEnvVar: "VLLM_API_KEY",
        modelPlaceholder: "Qwen/Qwen3-32B",
      }),
    ],
    [
      "sglang",
      createSelfHostedChoice({
        providerId: "sglang",
        label: "SGLang",
        defaultBaseUrl: "http://127.0.0.1:30000/v1",
        defaultApiKeyEnvVar: "SGLANG_API_KEY",
        modelPlaceholder: "Qwen/Qwen3-32B",
      }),
    ],
    [
      "litellm-api-key",
      createApiKeyChoice({
        providerId: "litellm",
        label: "LiteLLM",
        choiceId: "litellm-api-key",
        optionKey: "litellmApiKey",
        flagName: "--litellm-api-key",
        envVar: "LITELLM_API_KEY",
        defaultModel: "litellm/claude-opus-4-6",
      }),
    ],
    ["cloudflare-ai-gateway-api-key", cloudflareAiGatewayChoice],
    [
      "together-api-key",
      createApiKeyChoice({
        providerId: "together",
        label: "Together",
        choiceId: "together-api-key",
        optionKey: "togetherApiKey",
        flagName: "--together-api-key",
        envVar: "TOGETHER_API_KEY",
        defaultModel: "together/moonshotai/Kimi-K2.5",
      }),
    ],
    [
      "qianfan-api-key",
      createApiKeyChoice({
        providerId: "qianfan",
        label: "Qianfan",
        choiceId: "qianfan-api-key",
        optionKey: "qianfanApiKey",
        flagName: "--qianfan-api-key",
        envVar: "QIANFAN_API_KEY",
        defaultModel: "qianfan/deepseek-v3.2",
      }),
    ],
    [
      "qwen-api-key",
      createApiKeyChoice({
        providerId: "qwen",
        label: "Qwen Cloud",
        choiceId: "qwen-api-key",
        optionKey: "modelstudioApiKey",
        flagName: "--modelstudio-api-key",
        envVar: "QWEN_API_KEY",
        defaultModel: "qwen/qwen3.5-plus",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "qwen", {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [buildTestProviderModel("qwen3.5-plus")],
          }),
      }),
    ],
  ]);

  return {
    applyNonInteractivePluginProviderChoice: async (params: {
      nextConfig: Record<string, unknown>;
      authChoice: string;
      opts: Record<string, unknown>;
      runtime: HandlerContext["runtime"];
      baseConfig: Record<string, unknown>;
      resolveApiKey: HandlerContext["resolveApiKey"];
      toApiKeyCredential: HandlerContext["toApiKeyCredential"];
    }) => {
      const handler = choiceMap.get(params.authChoice);
      if (!handler) {
        return undefined;
      }

      const enableResult = enablePluginInConfig(
        params.nextConfig as never,
        handler.pluginId ?? handler.providerId,
      );
      if (!enableResult.enabled) {
        params.runtime.error(
          `${handler.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
        );
        params.runtime.exit(1);
        return null;
      }

      const agentId = resolveDefaultAgentId(enableResult.config);
      const agentDir = resolveAgentDir(enableResult.config, agentId);
      const workspaceDir =
        resolveAgentWorkspaceDir(enableResult.config, agentId) ?? resolveDefaultAgentWorkspaceDir();

      return await handler.runNonInteractive({
        authChoice: params.authChoice,
        config: enableResult.config,
        baseConfig: params.baseConfig,
        opts: params.opts,
        runtime: params.runtime,
        agentDir,
        workspaceDir,
        resolveApiKey: params.resolveApiKey,
        toApiKeyCredential: params.toApiKeyCredential,
      });
    },
  };
});

vi.mock("./onboard-helpers.js", () => {
  const normalizeGatewayTokenInput = (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
  };
  return {
    DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
    applyWizardMetadata: (cfg: unknown) => cfg,
    ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
    normalizeGatewayTokenInput,
    randomToken: () => "tok_generated_provider_auth_test_token",
    resolveControlUiLinks: ({ port }: { port: number }) => ({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
    }),
    waitForGatewayReachable: async () => ({ ok: true }),
  };
});

const NON_INTERACTIVE_DEFAULT_OPTIONS = {
  nonInteractive: true,
  skipHealth: true,
  skipChannels: true,
  json: true,
} as const;

let runNonInteractiveSetup: typeof import("./onboard-non-interactive.js").runNonInteractiveSetup;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let replaceRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").replaceRuntimeAuthProfileStoreSnapshots;
let resetFileLockStateForTest: typeof import("../infra/file-lock.js").resetFileLockStateForTest;
let clearPluginDiscoveryCache: typeof import("../plugins/discovery.js").clearPluginDiscoveryCache;
let clearPluginManifestRegistryCache: typeof import("../plugins/manifest-registry.js").clearPluginManifestRegistryCache;

type ProviderAuthConfigSnapshot = {
  auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
  agents?: { defaults?: { model?: { primary?: string } } };
  models?: {
    providers?: Record<
      string,
      {
        baseUrl?: string;
        api?: string;
        apiKey?: string | { source?: string; id?: string };
        models?: Array<{ id?: string }>;
      }
    >;
  };
};

function createZaiFetchMock(responses: Record<string, number>): FetchLike {
  return vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    const parsedBody =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    const key = `${url}::${parsedBody.model ?? ""}`;
    const status = responses[key] ?? 404;
    return new Response(
      JSON.stringify(
        status === 200 ? { ok: true } : { error: { code: "unsupported", message: "unsupported" } },
      ),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  });
}

async function withZaiProbeFetch<T>(
  responses: Record<string, number>,
  run: (fetchMock: FetchLike) => Promise<T>,
): Promise<T> {
  const originalVitest = process.env.VITEST;
  delete process.env.VITEST;
  const fetchMock = createZaiFetchMock(responses);
  vi.stubGlobal("fetch", fetchMock);
  try {
    return await run(fetchMock);
  } finally {
    vi.unstubAllGlobals();
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
  }
}

function expectZaiProbeCalls(
  fetchMock: FetchLike,
  expected: Array<{ url: string; modelId: string }>,
): void {
  const calls = (
    fetchMock as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }
  ).mock.calls;

  expect(calls).toHaveLength(expected.length);
  for (const [index, probe] of expected.entries()) {
    const [input, init] = calls[index] ?? [];
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input === "object" && "url" in input && typeof input.url === "string"
            ? input.url
            : undefined;
    expect(requestUrl).toBe(probe.url);
    expect(init?.method).toBe("POST");
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    expect(body.model).toBe(probe.modelId);
  }
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isTransient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!isTransient || attempt === 4) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
}

async function withOnboardEnv(
  prefix: string,
  run: (ctx: OnboardEnv) => Promise<void>,
): Promise<void> {
  const tempHome = await makeTempWorkspace(prefix);
  const configPath = path.join(tempHome, "openclaw.json");
  const runtime = createThrowingRuntime();

  try {
    await withEnvAsync(
      {
        HOME: tempHome,
        OPENCLAW_STATE_DIR: tempHome,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        CUSTOM_API_KEY: undefined,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
      },
      async () => {
        await run({ configPath, runtime });
      },
    );
  } finally {
    await removeDirWithRetry(tempHome);
  }
}

async function runNonInteractiveSetupWithDefaults(
  runtime: NonInteractiveRuntime,
  options: Record<string, unknown>,
): Promise<void> {
  await runNonInteractiveSetup(
    {
      ...NON_INTERACTIVE_DEFAULT_OPTIONS,
      ...options,
    },
    runtime,
  );
}

async function runOnboardingAndReadConfig(
  env: OnboardEnv,
  options: Record<string, unknown>,
): Promise<ProviderAuthConfigSnapshot> {
  await runNonInteractiveSetupWithDefaults(env.runtime, {
    skipSkills: true,
    ...options,
  });
  return readJsonFile<ProviderAuthConfigSnapshot>(env.configPath);
}

const CUSTOM_LOCAL_BASE_URL = "https://models.custom.local/v1";
const CUSTOM_LOCAL_MODEL_ID = "local-large";
const CUSTOM_LOCAL_PROVIDER_ID = "custom-models-custom-local";

async function runCustomLocalNonInteractive(
  runtime: NonInteractiveRuntime,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await runNonInteractiveSetupWithDefaults(runtime, {
    authChoice: "custom-api-key",
    customBaseUrl: CUSTOM_LOCAL_BASE_URL,
    customModelId: CUSTOM_LOCAL_MODEL_ID,
    skipSkills: true,
    ...overrides,
  });
}

async function readCustomLocalProviderApiKey(configPath: string): Promise<string | undefined> {
  const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);
  const apiKey = cfg.models?.providers?.[CUSTOM_LOCAL_PROVIDER_ID]?.apiKey;
  return typeof apiKey === "string" ? apiKey : undefined;
}

async function readCustomLocalProviderApiKeyInput(
  configPath: string,
): Promise<string | { source?: string; id?: string } | undefined> {
  const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);
  return cfg.models?.providers?.[CUSTOM_LOCAL_PROVIDER_ID]?.apiKey;
}

async function expectApiKeyProfile(params: {
  profileId: string;
  provider: string;
  key: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  const store = getOrCreateTestAuthStore();
  const profile = store.profiles[params.profileId];
  expect(profile?.type).toBe("api_key");
  if (profile?.type === "api_key") {
    expect(profile.provider).toBe(params.provider);
    expect(profile.key).toBe(params.key);
    if (params.metadata) {
      expect(profile.metadata).toEqual(params.metadata);
    }
  }
}

async function loadProviderAuthOnboardModules(): Promise<void> {
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, replaceRuntimeAuthProfileStoreSnapshots } =
    await import("../agents/auth-profiles.js"));
  ({ resetFileLockStateForTest } = await import("../infra/file-lock.js"));
  ({ clearPluginDiscoveryCache } = await import("../plugins/discovery.js"));
  ({ clearPluginManifestRegistryCache } = await import("../plugins/manifest-registry.js"));
}

describe("onboard (non-interactive): provider auth", () => {
  beforeAll(async () => {
    await loadProviderAuthOnboardModules();
  });

  beforeEach(() => {
    testAuthProfileStores.clear();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
    ensureWorkspaceAndSessionsMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testAuthProfileStores.clear();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("stores MiniMax API key in the global auth profile", async () => {
    await withOnboardEnv("openclaw-onboard-minimax-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "minimax-global-api",
        minimaxApiKey: "sk-minimax-test", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["minimax:global"]?.provider).toBe("minimax");
      expect(cfg.auth?.profiles?.["minimax:global"]?.mode).toBe("api_key");
      await expectApiKeyProfile({
        profileId: "minimax:global",
        provider: "minimax",
        key: "sk-minimax-test",
      });
    });
  });

  it("supports MiniMax CN API endpoint auth choice", async () => {
    await withOnboardEnv("openclaw-onboard-minimax-cn-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "minimax-cn-api",
        minimaxApiKey: "sk-minimax-test", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["minimax:cn"]?.provider).toBe("minimax");
      expect(cfg.auth?.profiles?.["minimax:cn"]?.mode).toBe("api_key");
      await expectApiKeyProfile({
        profileId: "minimax:cn",
        provider: "minimax",
        key: "sk-minimax-test",
      });
    });
  });

  it("stores Z.AI API key after probing the global endpoint", async () => {
    await withZaiProbeFetch(
      {
        [`${ZAI_GLOBAL_BASE_URL}/chat/completions::glm-5.1`]: 200,
      },
      async (fetchMock) =>
        await withOnboardEnv("openclaw-onboard-zai-", async (env) => {
          const cfg = await runOnboardingAndReadConfig(env, {
            authChoice: "zai-api-key",
            zaiApiKey: "zai-test-key", // pragma: allowlist secret
          });

          expect(cfg.auth?.profiles?.["zai:default"]?.provider).toBe("zai");
          expect(cfg.auth?.profiles?.["zai:default"]?.mode).toBe("api_key");
          expectZaiProbeCalls(fetchMock, [
            {
              url: `${ZAI_GLOBAL_BASE_URL}/chat/completions`,
              modelId: "glm-5.1",
            },
          ]);
          await expectApiKeyProfile({
            profileId: "zai:default",
            provider: "zai",
            key: "zai-test-key",
          });
        }),
    );
  });

  it("supports Z.AI CN coding endpoint auth choice", async () => {
    await withZaiProbeFetch(
      {
        [`${ZAI_CODING_CN_BASE_URL}/chat/completions::glm-5.1`]: 404,
        [`${ZAI_CODING_CN_BASE_URL}/chat/completions::glm-4.7`]: 200,
      },
      async (fetchMock) =>
        await withOnboardEnv("openclaw-onboard-zai-cn-", async (env) => {
          const cfg = await runOnboardingAndReadConfig(env, {
            authChoice: "zai-coding-cn",
            zaiApiKey: "zai-test-key", // pragma: allowlist secret
          });

          expect(cfg.auth?.profiles?.["zai:default"]?.provider).toBe("zai");
          expect(cfg.auth?.profiles?.["zai:default"]?.mode).toBe("api_key");
          expectZaiProbeCalls(fetchMock, [
            {
              url: `${ZAI_CODING_CN_BASE_URL}/chat/completions`,
              modelId: "glm-5.1",
            },
            {
              url: `${ZAI_CODING_CN_BASE_URL}/chat/completions`,
              modelId: "glm-4.7",
            },
          ]);
          await expectApiKeyProfile({
            profileId: "zai:default",
            provider: "zai",
            key: "zai-test-key",
          });
        }),
    );
  });

  it("supports Z.AI Coding Plan global endpoint detection", async () => {
    await withZaiProbeFetch(
      {
        [`${ZAI_CODING_GLOBAL_BASE_URL}/chat/completions::glm-5.1`]: 200,
      },
      async (fetchMock) =>
        await withOnboardEnv("openclaw-onboard-zai-coding-global-", async (env) => {
          const cfg = await runOnboardingAndReadConfig(env, {
            authChoice: "zai-coding-global",
            zaiApiKey: "zai-test-key", // pragma: allowlist secret
          });

          expect(cfg.auth?.profiles?.["zai:default"]?.provider).toBe("zai");
          expect(cfg.auth?.profiles?.["zai:default"]?.mode).toBe("api_key");
          expectZaiProbeCalls(fetchMock, [
            {
              url: `${ZAI_CODING_GLOBAL_BASE_URL}/chat/completions`,
              modelId: "glm-5.1",
            },
          ]);
          await expectApiKeyProfile({
            profileId: "zai:default",
            provider: "zai",
            key: "zai-test-key",
          });
        }),
    );
  });

  it("stores xAI API key in the default auth profile", async () => {
    await withOnboardEnv("openclaw-onboard-xai-", async (env) => {
      const rawKey = "xai-test-\r\nkey";
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "xai-api-key",
        xaiApiKey: rawKey,
      });

      expect(cfg.auth?.profiles?.["xai:default"]?.provider).toBe("xai");
      expect(cfg.auth?.profiles?.["xai:default"]?.mode).toBe("api_key");
      await expectApiKeyProfile({ profileId: "xai:default", provider: "xai", key: "xai-test-key" });
    });
  });

  it("infers Mistral auth choice from --mistral-api-key", async () => {
    await withOnboardEnv("openclaw-onboard-mistral-infer-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        mistralApiKey: "mistral-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["mistral:default"]?.provider).toBe("mistral");
      expect(cfg.auth?.profiles?.["mistral:default"]?.mode).toBe("api_key");
      await expectApiKeyProfile({
        profileId: "mistral:default",
        provider: "mistral",
        key: "mistral-test-key",
      });
    });
  });

  it("stores Volcano Engine API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-volcengine-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "volcengine-api-key",
        volcengineApiKey: "volcengine-test-key", // pragma: allowlist secret
      });

      expect(cfg.agents?.defaults?.model?.primary).toBe("volcengine-plan/ark-code-latest");
    });
  });

  it("infers BytePlus auth choice from --byteplus-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-byteplus-infer-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        byteplusApiKey: "byteplus-test-key", // pragma: allowlist secret
      });

      expect(cfg.agents?.defaults?.model?.primary).toBe("byteplus-plan/ark-code-latest");
    });
  });

  it("stores Vercel AI Gateway API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-ai-gateway-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "ai-gateway-api-key",
        aiGatewayApiKey: "gateway-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["vercel-ai-gateway:default"]?.provider).toBe("vercel-ai-gateway");
      expect(cfg.auth?.profiles?.["vercel-ai-gateway:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe(
        "vercel-ai-gateway/anthropic/claude-opus-4.6",
      );
      await expectApiKeyProfile({
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        key: "gateway-test-key",
      });
    });
  });

  it("stores legacy Anthropic setup-token onboarding again when explicitly selected", async () => {
    await withOnboardEnv("openclaw-onboard-token-", async ({ configPath, runtime }) => {
      const cleanToken = `sk-ant-oat01-${"a".repeat(80)}`;
      const token = `${cleanToken.slice(0, 30)}\r${cleanToken.slice(30)}`;

      await runNonInteractiveSetupWithDefaults(runtime, {
        authChoice: "setup-token",
        token,
        tokenProfileId: "anthropic:default",
      });

      const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);
      expect(cfg.auth?.profiles?.["anthropic:default"]?.provider).toBe("anthropic");
      expect(cfg.auth?.profiles?.["anthropic:default"]?.mode).toBe("token");
      expect(cfg.agents?.defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-6");
      expect(getOrCreateTestAuthStore().profiles["anthropic:default"]).toMatchObject({
        provider: "anthropic",
        type: "token",
        token: cleanToken,
      });
    });
  });

  it("stores OpenAI API key and sets OpenAI default model", async () => {
    await withOnboardEnv("openclaw-onboard-openai-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "openai-api-key",
        openaiApiKey: "sk-openai-test", // pragma: allowlist secret
      });

      expect(cfg.agents?.defaults?.model?.primary).toBe(OPENAI_DEFAULT_MODEL);
    });
  });

  it.each([
    {
      name: "anthropic",
      prefix: "openclaw-onboard-ref-flag-anthropic-",
      authChoice: "apiKey",
      optionKey: "anthropicApiKey",
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
    },
    {
      name: "openai",
      prefix: "openclaw-onboard-ref-flag-openai-",
      authChoice: "openai-api-key",
      optionKey: "openaiApiKey",
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
    },
    {
      name: "openrouter",
      prefix: "openclaw-onboard-ref-flag-openrouter-",
      authChoice: "openrouter-api-key",
      optionKey: "openrouterApiKey",
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
    },
    {
      name: "xai",
      prefix: "openclaw-onboard-ref-flag-xai-",
      authChoice: "xai-api-key",
      optionKey: "xaiApiKey",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
    },
    {
      name: "volcengine",
      prefix: "openclaw-onboard-ref-flag-volcengine-",
      authChoice: "volcengine-api-key",
      optionKey: "volcengineApiKey",
      flagName: "--volcengine-api-key",
      envVar: "VOLCANO_ENGINE_API_KEY",
    },
    {
      name: "byteplus",
      prefix: "openclaw-onboard-ref-flag-byteplus-",
      authChoice: "byteplus-api-key",
      optionKey: "byteplusApiKey",
      flagName: "--byteplus-api-key",
      envVar: "BYTEPLUS_API_KEY",
    },
  ])(
    "fails fast for $name when --secret-input-mode ref uses explicit key without env and does not leak the key",
    async ({ prefix, authChoice, optionKey, flagName, envVar }) => {
      await withOnboardEnv(prefix, async ({ runtime }) => {
        const providedSecret = `${envVar.toLowerCase()}-should-not-leak`; // pragma: allowlist secret
        const options: Record<string, unknown> = {
          authChoice,
          secretInputMode: "ref", // pragma: allowlist secret
          [optionKey]: providedSecret,
          skipSkills: true,
        };
        const envOverrides: Record<string, string | undefined> = {
          [envVar]: undefined,
        };

        await withEnvAsync(envOverrides, async () => {
          let thrown: Error | undefined;
          try {
            await runNonInteractiveSetupWithDefaults(runtime, options);
          } catch (error) {
            thrown = error as Error;
          }
          expect(thrown).toBeDefined();
          const message = thrown?.message ?? "";
          expect(message).toContain(
            `${flagName} cannot be used with --secret-input-mode ref unless ${envVar} is set in env.`,
          );
          expect(message).toContain(
            `Set ${envVar} in env and omit ${flagName}, or use --secret-input-mode plaintext.`,
          );
          expect(message).not.toContain(providedSecret);
        });
      });
    },
  );

  it("stores the detected env alias as keyRef for both OpenCode runtime providers", async () => {
    await withOnboardEnv("openclaw-onboard-ref-opencode-alias-", async ({ runtime }) => {
      await withEnvAsync(
        {
          OPENCODE_API_KEY: undefined,
          OPENCODE_ZEN_API_KEY: "opencode-zen-env-key", // pragma: allowlist secret
        },
        async () => {
          await runNonInteractiveSetupWithDefaults(runtime, {
            authChoice: "opencode-zen",
            secretInputMode: "ref", // pragma: allowlist secret
            skipSkills: true,
          });

          const store = getOrCreateTestAuthStore();
          for (const profileId of ["opencode:default", "opencode-go:default"]) {
            const profile = store.profiles[profileId];
            expect(profile?.type).toBe("api_key");
            if (profile?.type === "api_key") {
              expect(profile.key).toBeUndefined();
              expect(profile.keyRef).toEqual({
                source: "env",
                provider: "default",
                id: "OPENCODE_ZEN_API_KEY",
              });
            }
          }
        },
      );
    });
  });

  it("stores LiteLLM API key in the default auth profile", async () => {
    await withOnboardEnv("openclaw-onboard-litellm-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        authChoice: "litellm-api-key",
        litellmApiKey: "litellm-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["litellm:default"]?.provider).toBe("litellm");
      expect(cfg.auth?.profiles?.["litellm:default"]?.mode).toBe("api_key");
      await expectApiKeyProfile({
        profileId: "litellm:default",
        provider: "litellm",
        key: "litellm-test-key",
      });
    });
  });

  it.each([
    {
      name: "stores Cloudflare AI Gateway API key and metadata",
      prefix: "openclaw-onboard-cf-gateway-",
      options: {
        authChoice: "cloudflare-ai-gateway-api-key",
      },
    },
    {
      name: "infers Cloudflare auth choice from API key flags",
      prefix: "openclaw-onboard-cf-gateway-infer-",
      options: {},
    },
  ])("$name", async ({ prefix, options }) => {
    await withOnboardEnv(prefix, async ({ configPath, runtime }) => {
      await runNonInteractiveSetupWithDefaults(runtime, {
        cloudflareAiGatewayAccountId: "cf-account-id",
        cloudflareAiGatewayGatewayId: "cf-gateway-id",
        cloudflareAiGatewayApiKey: "cf-gateway-test-key", // pragma: allowlist secret
        skipSkills: true,
        ...options,
      });

      const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);

      expect(cfg.auth?.profiles?.["cloudflare-ai-gateway:default"]?.provider).toBe(
        "cloudflare-ai-gateway",
      );
      expect(cfg.auth?.profiles?.["cloudflare-ai-gateway:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("cloudflare-ai-gateway/claude-sonnet-4-5");
      await expectApiKeyProfile({
        profileId: "cloudflare-ai-gateway:default",
        provider: "cloudflare-ai-gateway",
        key: "cf-gateway-test-key",
        metadata: { accountId: "cf-account-id", gatewayId: "cf-gateway-id" },
      });
    });
  });

  it("infers Together auth choice from --together-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-together-infer-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        togetherApiKey: "together-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["together:default"]?.provider).toBe("together");
      expect(cfg.auth?.profiles?.["together:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("together/moonshotai/Kimi-K2.5");
      await expectApiKeyProfile({
        profileId: "together:default",
        provider: "together",
        key: "together-test-key",
      });
    });
  });

  it("infers QIANFAN auth choice from --qianfan-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-qianfan-infer-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        qianfanApiKey: "qianfan-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["qianfan:default"]?.provider).toBe("qianfan");
      expect(cfg.auth?.profiles?.["qianfan:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("qianfan/deepseek-v3.2");
      await expectApiKeyProfile({
        profileId: "qianfan:default",
        provider: "qianfan",
        key: "qianfan-test-key",
      });
    });
  });

  it("infers Qwen auth choice from --modelstudio-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-modelstudio-infer-", async (env) => {
      const cfg = await runOnboardingAndReadConfig(env, {
        modelstudioApiKey: "modelstudio-test-key", // pragma: allowlist secret
      });

      expect(cfg.auth?.profiles?.["qwen:default"]?.provider).toBe("qwen");
      expect(cfg.auth?.profiles?.["qwen:default"]?.mode).toBe("api_key");
      expect(cfg.models?.providers?.qwen?.baseUrl).toBe(
        "https://coding-intl.dashscope.aliyuncs.com/v1",
      );
      expect(cfg.agents?.defaults?.model?.primary).toBe("qwen/qwen3.5-plus");
      await expectApiKeyProfile({
        profileId: "qwen:default",
        provider: "qwen",
        key: "modelstudio-test-key",
      });
    });
  });

  it("configures a custom provider from non-interactive flags", async () => {
    await withOnboardEnv("openclaw-onboard-custom-provider-", async ({ configPath, runtime }) => {
      await runNonInteractiveSetupWithDefaults(runtime, {
        authChoice: "custom-api-key",
        customBaseUrl: "https://llm.example.com/v1",
        customApiKey: "custom-test-key", // pragma: allowlist secret
        customModelId: "foo-large",
        customCompatibility: "anthropic",
        skipSkills: true,
      });

      const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);

      const provider = cfg.models?.providers?.["custom-llm-example-com"];
      expect(provider?.baseUrl).toBe("https://llm.example.com/v1");
      expect(provider?.api).toBe("anthropic-messages");
      expect(provider?.apiKey).toBe("custom-test-key");
      expect(provider?.models?.some((model) => model.id === "foo-large")).toBe(true);
      expect(cfg.agents?.defaults?.model?.primary).toBe("custom-llm-example-com/foo-large");
    });
  });

  it("infers custom provider auth choice from custom flags", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-infer-",
      async ({ configPath, runtime }) => {
        await runNonInteractiveSetupWithDefaults(runtime, {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          customApiKey: "custom-test-key", // pragma: allowlist secret
          skipSkills: true,
        });

        const cfg = await readJsonFile<ProviderAuthConfigSnapshot>(configPath);

        expect(cfg.models?.providers?.["custom-models-custom-local"]?.baseUrl).toBe(
          "https://models.custom.local/v1",
        );
        expect(cfg.models?.providers?.["custom-models-custom-local"]?.api).toBe(
          "openai-completions",
        );
        expect(cfg.agents?.defaults?.model?.primary).toBe("custom-models-custom-local/local-large");
      },
    );
  });

  it("uses CUSTOM_API_KEY env fallback for non-interactive custom provider auth", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-env-fallback-",
      async ({ configPath, runtime }) => {
        process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret
        await runCustomLocalNonInteractive(runtime);
        expect(await readCustomLocalProviderApiKey(configPath)).toBe("custom-env-key");
      },
    );
  });

  it("stores CUSTOM_API_KEY env ref for non-interactive custom provider auth in ref mode", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-env-ref-",
      async ({ configPath, runtime }) => {
        process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret
        await runCustomLocalNonInteractive(runtime, {
          secretInputMode: "ref", // pragma: allowlist secret
        });
        expect(await readCustomLocalProviderApiKeyInput(configPath)).toEqual({
          source: "env",
          provider: "default",
          id: "CUSTOM_API_KEY",
        });
      },
    );
  });

  it("fails fast for custom provider ref mode when --custom-api-key is set but CUSTOM_API_KEY env is missing", async () => {
    await withOnboardEnv("openclaw-onboard-custom-provider-ref-flag-", async ({ runtime }) => {
      const providedSecret = "custom-inline-key-should-not-leak"; // pragma: allowlist secret
      await withEnvAsync({ CUSTOM_API_KEY: undefined }, async () => {
        let thrown: Error | undefined;
        try {
          await runCustomLocalNonInteractive(runtime, {
            secretInputMode: "ref", // pragma: allowlist secret
            customApiKey: providedSecret,
          });
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        const message = thrown?.message ?? "";
        expect(message).toContain(
          "--custom-api-key cannot be used with --secret-input-mode ref unless CUSTOM_API_KEY is set in env.",
        );
        expect(message).toContain(
          "Set CUSTOM_API_KEY in env and omit --custom-api-key, or use --secret-input-mode plaintext.",
        );
        expect(message).not.toContain(providedSecret);
      });
    });
  });

  it("fails custom provider auth when compatibility is invalid", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-invalid-compat-",
      async ({ runtime }) => {
        await expect(
          runNonInteractiveSetupWithDefaults(runtime, {
            authChoice: "custom-api-key",
            customBaseUrl: "https://models.custom.local/v1",
            customModelId: "local-large",
            customCompatibility: "xmlrpc",
            skipSkills: true,
          }),
        ).rejects.toThrow('Invalid --custom-compatibility (use "openai" or "anthropic").');
      },
    );
  });

  it("fails custom provider auth when explicit provider id is invalid", async () => {
    await withOnboardEnv("openclaw-onboard-custom-provider-invalid-id-", async ({ runtime }) => {
      await expect(
        runNonInteractiveSetupWithDefaults(runtime, {
          authChoice: "custom-api-key",
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          customProviderId: "!!!",
          skipSkills: true,
        }),
      ).rejects.toThrow(
        "Invalid custom provider config: Custom provider ID must include letters, numbers, or hyphens.",
      );
    });
  });

  it("fails inferred custom auth when required flags are incomplete", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-missing-required-",
      async ({ runtime }) => {
        await expect(
          runNonInteractiveSetupWithDefaults(runtime, {
            customApiKey: "custom-test-key", // pragma: allowlist secret
            skipSkills: true,
          }),
        ).rejects.toThrow('Auth choice "custom-api-key" requires a base URL and model ID.');
      },
    );
  });
});
