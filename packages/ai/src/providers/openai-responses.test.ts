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
    const result = await streamOpenAIResponses(model(), context, {
      apiKey: String(1),
      maxTokens: 1,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(openAiMockState.params[0]).toMatchObject({ max_output_tokens: 16, store: false });
    expect(openAiMockState.requestOptions[0]).toMatchObject({ maxRetries: 0 });
  });
});
