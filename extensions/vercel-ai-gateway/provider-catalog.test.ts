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
  it.each([503, 200])(
    "preserves the public advisory builder for HTTP %s with no rows",
    async (status) => {
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: jsonResponse({ data: [] }, { status }),
        release,
      });
      await expect(buildVercelAiGatewayProvider()).resolves.toEqual(
        buildStaticVercelAiGatewayProvider(),
      );
      expect(release).toHaveBeenCalledOnce();
    },
  );

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

  it("excludes non-language models while preserving vision and legacy catalog rows", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: jsonResponse({
        data: [
          {
            id: "alibaba/qwen3-235b-a22b-thinking",
            type: "language",
            tags: ["vision", "reasoning"],
          },
          ...[
            ["embedding", "alibaba/qwen3-embedding-0.6b"],
            ["image", "bfl/flux-2-flex"],
            ["video", "alibaba/wan-v2.5-t2v-preview"],
            ["reranking", "cohere/rerank-v3.5"],
            ["speech", "fish-audio/s1"],
            ["transcription", "fish-audio/transcribe-1"],
            ["realtime", "openai/gpt-realtime-1.5"],
          ].map(([type, id]) => ({ id, type })),
          { id: "custom/legacy-model" },
        ],
      }),
      release: async () => {},
      finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    });

    expect((await buildVercelAiGatewayProvider()).models).toMatchObject([
      {
        id: "alibaba/qwen3-235b-a22b-thinking",
        reasoning: true,
        input: ["text", "image"],
      },
      { id: "custom/legacy-model", input: ["text"] },
    ]);
  });

  it("preserves empty and fully filtered catalogs", async () => {
    for (const payload of [
      [],
      { data: [] },
      { data: [{ id: "fixture/embedding-model", type: "embedding" }] },
    ]) {
      clearLiveCatalogCacheForTests();
      fetchWithSsrFGuardMock.mockReset();
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: jsonResponse(payload),
        release: async () => {},
        finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
      });

      await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).resolves.toEqual([]);
    }
  });

  it.each([
    {
      kind: "envelope",
      payload: { data: {} },
      error: "Live model catalog response must be an array or { data: [] }",
    },
    {
      kind: "row",
      payload: { data: [null] },
      error: "Vercel AI Gateway model list: malformed JSON response",
    },
  ])("propagates a malformed model list $kind", async ({ payload, error }) => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: jsonResponse(payload),
      release,
      finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    });
    await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).rejects.toThrow(error);
    expect(release).toHaveBeenCalledOnce();
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

  it("uses the trusted environment proxy for the official live catalog", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: jsonResponse({ data: [{ id: "custom/live-model" }] }),
      release,
      finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    });

    const models = await discoverVercelAiGatewayModels();

    expect(models.map((model) => model.id)).toStrictEqual(["custom/live-model"]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
