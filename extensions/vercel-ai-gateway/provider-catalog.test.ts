// Vercel Ai Gateway tests cover provider catalog plugin behavior.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import {
  discoverVercelAiGatewayModels,
  getStaticVercelAiGatewayModelCatalog,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
  VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
} from "./api.js";
import { resolveVercelAiGatewayDynamicModel } from "./models.js";
import {
  buildStaticVercelAiGatewayProvider,
  buildVercelAiGatewayProvider,
  resolveVercelAiGatewayModel,
} from "./provider-catalog.js";

const STATIC_MODEL_IDS = [
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "moonshotai/kimi-k2.6",
];

function restoreEnvVar(name: "NODE_ENV" | "VITEST", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withLiveDiscovery<T>(run: () => Promise<T>): Promise<T> {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  try {
    return await run();
  } finally {
    restoreEnvVar("NODE_ENV", oldNodeEnv);
    restoreEnvVar("VITEST", oldVitest);
  }
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

describe("vercel ai gateway provider catalog", () => {
  it("builds the bundled Vercel AI Gateway defaults", async () => {
    const provider = await buildVercelAiGatewayProvider();

    expect(provider).toStrictEqual({
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      api: "anthropic-messages",
      models: getStaticVercelAiGatewayModelCatalog(),
    });
  });

  it("exposes the static fallback model catalog", () => {
    expect(getStaticVercelAiGatewayModelCatalog().map((model) => model.id)).toStrictEqual(
      STATIC_MODEL_IDS,
    );
  });

  it("builds an offline static provider catalog", () => {
    expect(buildStaticVercelAiGatewayProvider()).toStrictEqual({
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      api: "anthropic-messages",
      models: getStaticVercelAiGatewayModelCatalog(),
    });
  });

  it("builds runtime metadata for live-only model ids", () => {
    expect(resolveVercelAiGatewayDynamicModel("custom/provider-model")).toEqual({
      id: "custom/provider-model",
      name: "custom/provider-model",
      reasoning: false,
      input: ["text"],
      contextWindow: VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
      maxTokens: VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  });

  it("adds transport metadata for runtime model resolution", () => {
    expect(resolveVercelAiGatewayModel("custom/provider-model")).toMatchObject({
      id: "custom/provider-model",
      provider: "vercel-ai-gateway",
      api: "anthropic-messages",
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    });
  });

  it("preserves provider thinking metadata for known live-only upstream models", () => {
    expect(resolveVercelAiGatewayModel("openai/gpt-5.5")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
    });
    expect(resolveVercelAiGatewayModel("anthropic/claude-sonnet-4-6")).toMatchObject({
      input: ["text", "image"],
    });
  });

  it("falls back to the static catalog for malformed successful model list payloads", async () => {
    for (const payload of [[], { data: {} }, { data: [null] }]) {
      clearLiveCatalogCacheForTests();
      fetchWithSsrFGuardMock.mockReset();
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: jsonResponse(payload),
        release: async () => {},
        finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
      });

      await withLiveDiscovery(async () => {
        expect(await discoverVercelAiGatewayModels()).toStrictEqual(
          getStaticVercelAiGatewayModelCatalog(),
        );
      });
    }
  });

  it("falls back from malformed live token metadata", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: jsonResponse({
        data: [
          {
            id: "anthropic/claude-opus-4.6",
            name: "Claude Opus 4.6",
            context_window: -1,
            max_tokens: 128_000.5,
            tags: ["vision", "reasoning"],
          },
          {
            id: "custom/provider-model",
            name: "Custom model",
            context_window: Number.POSITIVE_INFINITY,
            max_tokens: 0,
            tags: ["reasoning"],
          },
        ],
      }),
      release: async () => {},
      finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    });

    await withLiveDiscovery(async () => {
      const models = await discoverVercelAiGatewayModels();

      expect(models[0]).toMatchObject({
        id: "anthropic/claude-opus-4.6",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
      expect(models[1]).toMatchObject({
        id: "custom/provider-model",
        contextWindow: VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
        maxTokens: VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
      });
    });
  });

  it("uses the trusted environment proxy for the official live catalog", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: jsonResponse({ data: [{ id: "custom/live-model" }] }),
      release,
      finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    });

    await withLiveDiscovery(async () => {
      const models = await discoverVercelAiGatewayModels();

      expect(models.map((model) => model.id)).toStrictEqual(["custom/live-model"]);
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
