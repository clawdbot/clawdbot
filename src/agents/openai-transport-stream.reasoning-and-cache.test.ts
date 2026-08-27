import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  expectRecordFields,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";

function emptyContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

function lookupWeatherContext(
  parameters: Record<string, unknown> = { type: "object", properties: {} },
) {
  return {
    systemPrompt: "system",
    messages: [],
    tools: [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters,
      },
    ],
  } as never;
}

describe("openai transport stream", () => {
  it("omits responses strict tool shaping for proxy-like OpenAI routes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      lookupWeatherContext(),
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
  });

  it("keeps native responses strict mode for projected tools after dropping bad schemas", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "broken",
            description: "Broken",
            parameters: {
              type: "object",
              get properties(): never {
                throw new Error("properties exploded");
              },
            },
          },
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: {},
          },
        ],
      } as never,
      undefined,
    ) as {
      tools?: Array<{
        name?: string;
        strict?: boolean;
        parameters?: Record<string, unknown>;
      }>;
    };

    expect(params.tools).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("still normalizes responses tool parameters when strict is omitted", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      lookupWeatherContext({}),
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: {},
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]?.strict).toBe(false);
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("adds native OpenAI turn metadata on direct Responses routes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      emptyContext(),
      { sessionId: "session-123" } as never,
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
        openclaw_turn_attempt: "1",
        openclaw_transport: "stream",
      },
    ) as { metadata?: Record<string, string> };

    expectRecordFields(params.metadata, {
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
      openclaw_turn_attempt: "1",
      openclaw_transport: "stream",
    });
  });

  it("leaves proxy-like OpenAI Responses routes without native turn metadata by default", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      emptyContext(),
      { sessionId: "session-123" } as never,
      undefined,
    ) as { metadata?: Record<string, string> };

    expect(params).not.toHaveProperty("metadata");
  });

  it("gates responses service_tier to native OpenAI endpoints", () => {
    const nativeParams = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      emptyContext(),
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };
    const proxyParams = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      emptyContext(),
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };

    expect(nativeParams.service_tier).toBe("priority");
    expect(proxyParams).not.toHaveProperty("service_tier");
  });

  it("strips store when responses compat disables it", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "custom-provider",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      emptyContext(),
      undefined,
    ) as { store?: unknown };

    expect(params).not.toHaveProperty("store");
  });

  it("uses system role for xAI default-route responses providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
      }),
      emptyContext(),
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]?.role).toBe("system");
  });
});
