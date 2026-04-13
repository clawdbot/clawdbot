import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  resolveEnvApiKeyVarName,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";
const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

function createTestModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

function resolveMinimaxCatalogBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawHost = env.MINIMAX_API_HOST?.trim();
  if (!rawHost) {
    return MINIMAX_BASE_URL;
  }

  try {
    const url = new URL(rawHost);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (basePath.endsWith("/anthropic")) {
      return `${url.origin}${basePath}`;
    }
    return `${url.origin}/anthropic`;
  } catch {
    return MINIMAX_BASE_URL;
  }
}

function buildMinimaxPortalCatalog(params: {
  env?: NodeJS.ProcessEnv;
  envApiKey?: string;
  explicitApiKey?: string;
  explicitBaseUrl?: string;
  hasProfiles?: boolean;
}): ModelProviderConfig | null {
  const apiKey =
    params.envApiKey ??
    params.explicitApiKey ??
    (params.hasProfiles ? "MINIMAX_OAUTH_TOKEN" : undefined);
  if (!apiKey) {
    return null;
  }
  return {
    baseUrl: params.explicitBaseUrl || resolveMinimaxCatalogBaseUrl(params.env),
    api: "anthropic-messages",
    authHeader: true,
    apiKey,
    models: [createTestModel("MiniMax-M2.7")],
  };
}

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "nvidia",
      provider: {
        baseUrl: NVIDIA_BASE_URL,
        api: "openai-completions",
        models: [createTestModel("nvidia/test-model")],
      },
      env: { NVIDIA_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models?.length).toBeGreaterThan(0);
  });

  it("resolves the nvidia api key value from env", () => {
    const auth = resolveEnvApiKey("nvidia", {
      NVIDIA_API_KEY: "nvidia-test-api-key",
    } as NodeJS.ProcessEnv);

    expect(auth).toEqual({
      apiKey: "nvidia-test-api-key",
      source: "env: NVIDIA_API_KEY",
    });
  });
});

describe("MiniMax implicit provider (#15275)", () => {
  it("should use anthropic-messages API for API-key provider", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "minimax",
      provider: {
        baseUrl: MINIMAX_BASE_URL,
        api: "anthropic-messages",
        authHeader: true,
        models: [createTestModel("MiniMax-M2.7")],
      },
      env: { MINIMAX_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.api).toBe("anthropic-messages");
    expect(provider.authHeader).toBe(true);
    expect(provider.apiKey).toBe("MINIMAX_API_KEY");
    expect(provider.baseUrl).toBe("https://api.minimax.io/anthropic");
  });

  it("should respect MINIMAX_API_HOST env var for CN endpoint (#34487)", () => {
    const env = {
      MINIMAX_API_KEY: "test-key",
      MINIMAX_API_HOST: "https://api.minimaxi.com",
    } as NodeJS.ProcessEnv;

    expect(resolveMinimaxCatalogBaseUrl(env)).toBe("https://api.minimaxi.com/anthropic");
    expect(buildMinimaxPortalCatalog({ env, envApiKey: "MINIMAX_API_KEY" })?.baseUrl).toBe(
      "https://api.minimaxi.com/anthropic",
    );
  });

  it("should set authHeader for minimax portal provider", () => {
    expect(buildMinimaxPortalCatalog({ hasProfiles: true })?.authHeader).toBe(true);
  });

  it("should include minimax portal provider when MINIMAX_OAUTH_TOKEN is configured", () => {
    expect(
      resolveEnvApiKeyVarName("minimax-portal", {
        MINIMAX_OAUTH_TOKEN: "portal-token",
      } as NodeJS.ProcessEnv),
    ).toBe("MINIMAX_OAUTH_TOKEN");
    const provider = buildMinimaxPortalCatalog({ hasProfiles: true });
    expect(provider?.authHeader).toBe(true);
    expect(provider?.apiKey).toBe("MINIMAX_OAUTH_TOKEN");
  });
});

describe("vLLM provider", () => {
  it("should not include vllm when no API key is configured", () => {
    expect(resolveEnvApiKeyVarName("vllm", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("should include vllm when VLLM_API_KEY is set", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "vllm",
      provider: {
        baseUrl: VLLM_DEFAULT_BASE_URL,
        api: "openai-completions",
        models: [createTestModel("meta-llama/Meta-Llama-3-8B-Instruct")],
      },
      env: { VLLM_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("VLLM_API_KEY");
    expect(provider.baseUrl).toBe(VLLM_DEFAULT_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toHaveLength(1);
  });
});
