import { afterEach, beforeEach } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome as withTempHomeBase } from "../plugin-sdk/test-helpers/temp-home.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

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
