import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome as withTempHomeBase } from "../plugin-sdk/test-helpers/temp-home.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

export function withModelsTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  // Models-config tests do not exercise session persistence; skip draining
  // unrelated session lock state during temp-home teardown.
  return withTempHomeBase(fn, {
    prefix: "openclaw-models-",
    skipSessionCleanup: true,
  });
}

export function installModelsConfigTestHooks(opts?: {
  restoreFetch?: boolean;
  resetPluginLoaderState?: boolean;
}) {
  let previousHome: string | undefined;
  let previousOpenClawAgentDir: string | undefined;
  let previousPiCodingAgentDir: string | undefined;
  const originalFetch = globalThis.fetch;
  const shouldResetPluginLoaderState = opts?.resetPluginLoaderState !== false;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousOpenClawAgentDir = process.env.OPENCLAW_AGENT_DIR;
    previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.OPENCLAW_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    if (shouldResetPluginLoaderState) {
      resetPluginLoaderTestStateForTest();
    }
    resetModelsJsonReadyCacheForTest();
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    if (previousOpenClawAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousOpenClawAgentDir;
    }
    if (previousPiCodingAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    if (shouldResetPluginLoaderState) {
      resetPluginLoaderTestStateForTest();
    }
    resetModelsJsonReadyCacheForTest();
    if (opts?.restoreFetch && originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });
}

export async function withTempEnv<T>(vars: string[], fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const envVar of vars) {
    previous[envVar] = process.env[envVar];
  }

  try {
    return await fn();
  } finally {
    for (const envVar of vars) {
      const value = previous[envVar];
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
  }
}

export function unsetEnv(vars: string[]) {
  for (const envVar of vars) {
    delete process.env[envVar];
  }
}

export const COPILOT_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const COPILOT_DISCOVERY_ENV_VARS = [
  ...COPILOT_TOKEN_ENV_VARS,
  "OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS",
];

export async function withUnsetCopilotTokenEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withTempEnv(COPILOT_DISCOVERY_ENV_VARS, async () => {
    unsetEnv(COPILOT_TOKEN_ENV_VARS);
    process.env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS = "github-copilot";
    return fn();
  });
}

export function mockCopilotTokenExchangeSuccess(): MockFn {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      token: "copilot-token;proxy-ep=proxy.copilot.example",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

export async function withCopilotGithubToken<T>(
  token: string,
  fn: (fetchMock: MockFn) => Promise<T>,
): Promise<T> {
  return withTempEnv(COPILOT_DISCOVERY_ENV_VARS, async () => {
    process.env.COPILOT_GITHUB_TOKEN = token;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS = "github-copilot";
    const fetchMock = mockCopilotTokenExchangeSuccess();
    return fn(fetchMock);
  });
}

export const MODELS_CONFIG_IMPLICIT_ENV_VARS = [
  "OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS",
  "VITEST",
  "NODE_ENV",
  "AI_GATEWAY_API_KEY",
  "CLOUDFLARE_AI_GATEWAY_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_HUB_TOKEN",
  "MINIMAX_API_KEY",
  "MINIMAX_API_HOST",
  "MINIMAX_OAUTH_TOKEN",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OLLAMA_API_KEY",
  "OPENCLAW_AGENT_DIR",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_CODING_AGENT_DIR",
  "QIANFAN_API_KEY",
  "QWEN_API_KEY",
  "MODELSTUDIO_API_KEY",
  "SYNTHETIC_API_KEY",
  "STEPFUN_API_KEY",
  "TOGETHER_API_KEY",
  "VOLCANO_ENGINE_API_KEY",
  "BYTEPLUS_API_KEY",
  "CHUTES_API_KEY",
  "CHUTES_OAUTH_TOKEN",
  "KILOCODE_API_KEY",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "GEMINI_API_KEY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "ANTHROPIC_VERTEX_USE_GCP_METADATA",
  "VENICE_API_KEY",
  "VLLM_API_KEY",
  "XIAOMI_API_KEY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  // Avoid ambient AWS creds unintentionally enabling Bedrock discovery.
  "AWS_ACCESS_KEY_ID",
  "AWS_CONFIG_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SESSION_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SHARED_CREDENTIALS_FILE",
];

const TEST_PROVIDER_ENV_TO_PROVIDER_IDS: Record<string, string[]> = {
  AI_GATEWAY_API_KEY: ["vercel-ai-gateway"],
  ANTHROPIC_VERTEX_PROJECT_ID: ["anthropic-vertex"],
  ANTHROPIC_VERTEX_USE_GCP_METADATA: ["anthropic-vertex"],
  AWS_ACCESS_KEY_ID: ["amazon-bedrock"],
  AWS_BEARER_TOKEN_BEDROCK: ["amazon-bedrock"],
  AWS_CONFIG_FILE: ["amazon-bedrock"],
  AWS_DEFAULT_REGION: ["amazon-bedrock"],
  AWS_PROFILE: ["amazon-bedrock"],
  AWS_REGION: ["amazon-bedrock"],
  AWS_SECRET_ACCESS_KEY: ["amazon-bedrock"],
  AWS_SESSION_TOKEN: ["amazon-bedrock"],
  AWS_SHARED_CREDENTIALS_FILE: ["amazon-bedrock"],
  BYTEPLUS_API_KEY: ["byteplus"],
  CHUTES_API_KEY: ["chutes"],
  CHUTES_OAUTH_TOKEN: ["chutes"],
  CLOUD_ML_REGION: ["anthropic-vertex"],
  CLOUDFLARE_AI_GATEWAY_API_KEY: ["cloudflare-ai-gateway"],
  COPILOT_GITHUB_TOKEN: ["github-copilot"],
  GEMINI_API_KEY: ["google"],
  GITHUB_TOKEN: ["github-copilot"],
  GH_TOKEN: ["github-copilot"],
  GOOGLE_APPLICATION_CREDENTIALS: ["anthropic-vertex"],
  GOOGLE_CLOUD_LOCATION: ["anthropic-vertex"],
  GOOGLE_CLOUD_PROJECT: ["anthropic-vertex"],
  GOOGLE_CLOUD_PROJECT_ID: ["anthropic-vertex"],
  HF_TOKEN: ["huggingface"],
  HUGGINGFACE_HUB_TOKEN: ["huggingface"],
  KILOCODE_API_KEY: ["kilocode"],
  KIMI_API_KEY: ["moonshot", "kimi"],
  KIMICODE_API_KEY: ["kimi-coding"],
  MINIMAX_API_KEY: ["minimax"],
  MINIMAX_OAUTH_TOKEN: ["minimax"],
  MODELSTUDIO_API_KEY: ["chutes"],
  MOONSHOT_API_KEY: ["moonshot"],
  NVIDIA_API_KEY: ["nvidia"],
  OLLAMA_API_KEY: ["ollama"],
  OPENAI_API_KEY: ["openai"],
  OPENROUTER_API_KEY: ["openrouter"],
  QIANFAN_API_KEY: ["qianfan"],
  STEPFUN_API_KEY: ["stepfun"],
  SYNTHETIC_API_KEY: ["custom-proxy"],
  TOGETHER_API_KEY: ["together"],
  VENICE_API_KEY: ["venice"],
  VLLM_API_KEY: ["vllm"],
  VOLCANO_ENGINE_API_KEY: ["volcengine"],
  XIAOMI_API_KEY: ["xiaomi"],
};

export function snapshotImplicitProviderEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = env ?? process.env;
  const snapshot: NodeJS.ProcessEnv = {};

  for (const envVar of MODELS_CONFIG_IMPLICIT_ENV_VARS) {
    const value = source[envVar];
    if (value !== undefined) {
      snapshot[envVar] = value;
    }
  }

  // Provider discovery tests can temporarily scrub VITEST/NODE_ENV to exercise
  // live HTTP paths. Keep the bundled plugin root pinned to the source checkout
  // so those tests do not fall back to potentially stale dist-runtime wrappers.
  snapshot.VITEST ??= process.env.VITEST;
  snapshot.NODE_ENV ??= process.env.NODE_ENV;
  snapshot.OPENCLAW_BUNDLED_PLUGINS_DIR ??=
    resolveBundledPluginsDir({ VITEST: "true" } as NodeJS.ProcessEnv) ?? undefined;

  return snapshot;
}

async function inferAuthProfileProviderIds(agentDir?: string): Promise<string[]> {
  if (!agentDir) {
    return [];
  }
  try {
    const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { provider?: string }>;
      order?: Record<string, unknown>;
    };
    const providers = new Set<string>();
    for (const providerId of Object.keys(parsed.order ?? {})) {
      if (providerId.trim()) {
        providers.add(providerId.trim());
      }
    }
    for (const profile of Object.values(parsed.profiles ?? {})) {
      const providerId = profile?.provider?.trim();
      if (providerId) {
        providers.add(providerId);
      }
    }
    return [...providers];
  } catch {
    return [];
  }
}

async function inferImplicitProviderTestPluginIds(params: {
  agentDir?: string;
  config?: OpenClawConfig;
  explicitProviders?: Record<string, unknown> | null;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): Promise<string[]> {
  const providerIds = new Set<string>();
  for (const providerId of Object.keys(params.config?.models?.providers ?? {})) {
    if (providerId.trim()) {
      providerIds.add(providerId.trim());
    }
  }
  for (const providerId of Object.keys(params.explicitProviders ?? {})) {
    if (providerId.trim()) {
      providerIds.add(providerId.trim());
    }
  }
  const legacyGrokApiKey =
    params.config?.tools?.web?.search &&
    typeof params.config.tools.web.search === "object" &&
    "grok" in params.config.tools.web.search
      ? (params.config.tools.web.search.grok as { apiKey?: unknown } | undefined)?.apiKey
      : undefined;
  if (legacyGrokApiKey !== undefined && params.config?.plugins?.entries?.xai?.enabled !== false) {
    providerIds.add("xai");
  }
  for (const [envVar, mappedProviderIds] of Object.entries(TEST_PROVIDER_ENV_TO_PROVIDER_IDS)) {
    if (!params.env[envVar]?.trim()) {
      continue;
    }
    for (const providerId of mappedProviderIds) {
      providerIds.add(providerId);
    }
  }
  for (const providerId of await inferAuthProfileProviderIds(params.agentDir)) {
    providerIds.add(providerId);
  }
  for (const [pluginId, entry] of Object.entries(params.config?.plugins?.entries ?? {})) {
    if (!pluginId.trim() || entry?.enabled === false) {
      continue;
    }
    const pluginConfig =
      entry.config && typeof entry.config === "object"
        ? (entry.config as { webSearch?: { apiKey?: unknown } })
        : undefined;
    if (pluginConfig?.webSearch?.apiKey !== undefined) {
      providerIds.add(pluginId);
    }
  }
  if (providerIds.size === 0) {
    // No config/env/auth hints: keep ambient local auto-discovery focused on the
    // one provider that is expected to probe localhost in tests.
    return ["ollama"];
  }

  const pluginIds = new Set<string>();
  for (const providerId of providerIds) {
    const owningPluginIds =
      resolveOwningPluginIdsForProvider({
        provider: providerId,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      }) ?? [];
    for (const pluginId of owningPluginIds) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export async function resolveImplicitProvidersForTest(
  params: Parameters<typeof resolveImplicitProviders>[0],
) {
  const env = snapshotImplicitProviderEnv(params.env);
  const inferredPluginIds = await inferImplicitProviderTestPluginIds({
    agentDir: params.agentDir,
    config: params.config,
    explicitProviders: params.explicitProviders,
    env,
    workspaceDir: params.workspaceDir,
  });
  if (inferredPluginIds.length > 0) {
    env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS = inferredPluginIds.join(",");
  }
  return resolveImplicitProviders({
    ...params,
    env,
  });
}

export const CUSTOM_PROXY_MODELS_CONFIG: OpenClawConfig = {
  models: {
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "TEST_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B (Proxy)",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
};
