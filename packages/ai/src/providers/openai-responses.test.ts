import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const openAiMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  params: [] as unknown[],
  requestOptions: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: vi.fn((params: unknown, requestOptions: unknown) => {
        openAiMockState.params.push(params);
        openAiMockState.requestOptions.push(requestOptions);
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      openAiMockState.configs.push(config);
    }
  },
}));

import { createOpenAIResponsesClient } from "../transports/openai-responses-client.js";
import { buildOpenAIResponsesParams } from "../transports/openai-responses-params-internal.js";
import { streamOpenAIResponses } from "./openai-responses.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function model(overrides: Partial<Model<"openai-responses">> = {}) {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies Model<"openai-responses">;
}

describe("OpenAI Responses provider", () => {
  afterEach(() => {
    openAiMockState.configs = [];
    openAiMockState.params = [];
    openAiMockState.requestOptions = [];
    configureAiTransportHost({});
  });

  it("constructs the SDK client with the host guarded fetch", async () => {
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    const result = await streamOpenAIResponses(model(), context, {
      apiKey: "sentinel-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(openAiMockState.configs).toHaveLength(1);
    expect((openAiMockState.configs[0] as { fetch?: unknown }).fetch).toBe(hostFetch);
    expect(openAiMockState.configs[0]).toMatchObject({ maxRetries: 0 });
  });

  it("fails closed before constructing an OpenAI client for another provider without an endpoint", async () => {
    const missingEndpointModel = {
      ...model(),
      provider: "openrouter",
      baseUrl: undefined,
    } as unknown as Model<"openai-responses">;

    const result = await streamOpenAIResponses(missingEndpointModel, context, {
      apiKey: "sentinel-openrouter-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('Provider "openrouter" requires an explicit base URL');
    expect(() =>
      createOpenAIResponsesClient(missingEndpointModel, context, "sentinel-openrouter-key"),
    ).toThrow('Provider "openrouter" requires an explicit base URL');
    expect(openAiMockState.configs).toEqual([]);

    const configuredModel = {
      ...missingEndpointModel,
      baseUrl: "https://openrouter.ai/api/v1",
    };
    await streamOpenAIResponses(configuredModel, context, {
      apiKey: "sentinel-openrouter-key",
    }).result();
    expect(() =>
      createOpenAIResponsesClient(configuredModel, context, "sentinel-openrouter-key"),
    ).not.toThrow();
    expect(
      openAiMockState.configs.map((config) => (config as { baseURL?: string }).baseURL),
    ).toEqual(["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"]);
  });

  it("keeps Cloudflare composed upstream auth opaque in SDK headers", async () => {
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await streamOpenAIResponses(
      model({
        provider: "cloudflare-ai-gateway",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
      }),
      context,
      { apiKey: "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end" },
    ).result();

    const config = openAiMockState.configs[0] as {
      apiKey?: string;
      defaultHeaders?: Record<string, string | null>;
      fetch?: unknown;
    };
    expect(config.apiKey).toBe("oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end");
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe(
      "Bearer oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end",
    );
    expect(config.fetch).toBe(hostFetch);
  });

  it("clamps small output limits and disables implicit SDK retries", async () => {
    const requestModel = model();
    const options = {
      apiKey: String(1),
      maxTokens: 1,
    };
    const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
    const result = await streamOpenAIResponses(requestModel, context, options).result();

    expect(result.stopReason).toBe("error");
    for (const params of [transportParams, openAiMockState.params[0]]) {
      expect(params).toMatchObject({ max_output_tokens: 16, store: false });
    }
    expect(openAiMockState.requestOptions[0]).toMatchObject({ maxRetries: 0 });
  });

  it.each([
    { id: "gpt-6-astra", cacheRetention: "short", ttl: "30m", retention: undefined },
    { id: "gpt-6-astra", cacheRetention: "long", ttl: "30m", retention: undefined },
    { id: "gpt-6-astra", cacheRetention: "none", ttl: undefined, retention: undefined },
    { id: "gpt-5.5", cacheRetention: "long", ttl: undefined, retention: "24h" },
    { id: "gpt-5.5", cacheRetention: "short", ttl: undefined, retention: undefined },
  ] as const)(
    "serializes $id $cacheRetention caching through both Responses builders",
    async ({ id, cacheRetention, ttl, retention }) => {
      const requestModel = model({ id });
      const options = { apiKey: "sentinel-key", sessionId: "cache-session", cacheRetention };
      const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
      await streamOpenAIResponses(requestModel, context, options).result();

      for (const params of [transportParams, openAiMockState.params[0]]) {
        expect(params).toHaveProperty(
          "prompt_cache_key",
          cacheRetention === "none" ? undefined : "cache-session",
        );
        expect(params).toMatchObject({ model: id });
        expect((params as { prompt_cache_retention?: unknown }).prompt_cache_retention).toBe(
          retention,
        );
        if (ttl) {
          expect(params).toHaveProperty("prompt_cache_options", { ttl });
        } else {
          expect(params).not.toHaveProperty("prompt_cache_options");
        }
      }
    },
  );

  it("keeps Astra cache fields unchanged for custom endpoints", async () => {
    const requestModel = model({ id: "gpt-6-astra", baseUrl: "https://proxy.example/v1" });
    const options = { apiKey: "sentinel-key", cacheRetention: "long" as const };
    const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
    await streamOpenAIResponses(requestModel, context, options).result();

    expect(transportParams.prompt_cache_retention).toBeUndefined();
    expect(openAiMockState.params[0]).toHaveProperty("prompt_cache_retention", "24h");
    for (const params of [transportParams, openAiMockState.params[0]]) {
      expect(params).not.toHaveProperty("prompt_cache_options");
    }
  });

  it.each([
    { reasoningEffort: undefined, expectedEffort: undefined },
    { reasoningEffort: "minimal", expectedEffort: "low" },
    { reasoningEffort: "xhigh", expectedEffort: "xhigh" },
    { reasoningEffort: "max", expectedEffort: "max" },
  ] as const)(
    "honors Astra reasoning and sampling without catalog metadata for $reasoningEffort",
    async ({ reasoningEffort, expectedEffort }) => {
      const requestModel = model({ id: "gpt-6-astra" });
      const options = { apiKey: "sentinel-key", reasoningEffort, temperature: 0.5, topP: 0.8 };
      const transportParams = buildOpenAIResponsesParams(requestModel, context, options);
      await streamOpenAIResponses(requestModel, context, options).result();

      for (const params of [transportParams, openAiMockState.params[0]]) {
        const request = params as {
          reasoning?: { effort: string };
          temperature?: number;
          top_p?: number;
        };
        expect(request.reasoning?.effort).toBe(expectedEffort);
        expect(request.temperature).toBeUndefined();
        expect(request.top_p).toBeUndefined();
      }
    },
  );
});
