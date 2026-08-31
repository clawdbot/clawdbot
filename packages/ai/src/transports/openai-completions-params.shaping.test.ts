import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import {
  attachModelProviderRequestTransport,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

describe("openai completions params", () => {
  it("keeps OpenRouter thinking format for declared OpenRouter providers on custom proxy URLs", () => {
    const params = buildOpenAICompletionsParams(
      attachModelProviderRequestTransport(
        makeCompletionsModel({
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          provider: "openrouter",
          baseUrl: "https://proxy.example.com/v1",
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    );

    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("keeps OpenRouter thinking format for native OpenRouter hosts behind custom provider ids", () => {
    const params = buildOpenAICompletionsParams(
      attachModelProviderRequestTransport(
        makeCompletionsModel({
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          provider: "custom-openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    );

    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("forwards temperature and top_p to chat completions request params", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
      }),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      } as never,
      {
        temperature: 0.4,
        topP: 0.9,
      },
    );

    expect(params.temperature).toBe(0.4);
    expect(params.top_p).toBe(0.9);
  });

  it("forwards penalty params and seed to chat completions request params", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
      }),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      } as never,
      {
        frequencyPenalty: -0.5,
        presencePenalty: 1.25,
        seed: 12345,
      },
    );

    expect(params.frequency_penalty).toBe(-0.5);
    expect(params.presence_penalty).toBe(1.25);
    expect(params.seed).toBe(12345);
  });

  it("forwards stop sequences to chat completions request params", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
      }),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      } as never,
      {
        stop: ["User:", "Assistant:"],
      },
    );

    expect(params.stop).toEqual(["User:", "Assistant:"]);
  });

  it("forwards response_format to chat completions request params", () => {
    const model = makeCompletionsModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      reasoning: false,
    });

    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [],
    } as never;

    {
      const params = buildOpenAICompletionsParams(model, context, {
        responseFormat: { type: "json_object" },
      });
      expect(params.response_format).toEqual({ type: "json_object" });
    }

    {
      const params = buildOpenAICompletionsParams(model, context, {
        responseFormat: { type: "text" },
      });
      expect(params.response_format).toEqual({ type: "text" });
    }

    {
      const params = buildOpenAICompletionsParams(model, context, {
        responseFormat: { type: "json_schema", json_schema: {} },
      });
      expect(params.response_format).toEqual({ type: "json_schema", json_schema: {} });
    }

    {
      const schema = {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      };
      const params = buildOpenAICompletionsParams(model, context, { responseFormat: schema });
      expect(params.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "openclaw_response", schema },
      });
    }

    {
      const params = buildOpenAICompletionsParams(model, context, {});
      expect(params).not.toHaveProperty("response_format");
    }
  });

  it("does not infer JSON Schema response formats for legacy first-party OpenAI models", () => {
    const responseFormat = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    const build = (id: string) =>
      buildOpenAICompletionsParams(
        makeCompletionsModel({
          id,
          name: id,
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: false,
        }),
        { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] } as never,
        { responseFormat },
      );

    expect(build("gpt-4-turbo")).not.toHaveProperty("response_format");
    expect(build("gpt-4o-audio-preview")).not.toHaveProperty("response_format");
    expect(build("gpt-4o-2024-05-13")).not.toHaveProperty("response_format");
    expect(build("o1-mini")).not.toHaveProperty("response_format");
    for (const id of [
      "gpt-4o",
      "gpt-4o-2024-08-06",
      "gpt-4o-mini",
      "gpt-4o-mini-2024-07-18",
      "gpt-4.1",
      "o1",
      "o1-2024-12-17",
      "o3",
      "o4-mini",
    ]) {
      expect(build(id).response_format).toMatchObject({ type: "json_schema" });
    }
  });

  it("omits JSON Schema response_format for compatible backends without support", () => {
    const model = makeCompletionsModel({
      id: "custom-model",
      name: "Custom model",
      provider: "custom-provider",
      baseUrl: "https://models.example/v1",
      reasoning: false,
      compat: { supportsJsonSchemaResponseFormat: false },
    });
    const schema = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };

    const params = buildOpenAICompletionsParams(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] } as never,
      { responseFormat: schema },
    );

    expect(params).not.toHaveProperty("response_format");

    const configuredFormat = {
      type: "json_schema",
      json_schema: { name: "configured", schema },
    };
    const configuredParams = buildOpenAICompletionsParams(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] } as never,
      { responseFormat: configuredFormat },
    );
    expect(configuredParams.response_format).toBe(configuredFormat);
  });

  it("maps JSON Schema response_format for Ollama OpenAI-compatible routes", () => {
    const model = makeCompletionsModel({
      id: "gemma4:e4b",
      name: "Gemma 4 E4B",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      reasoning: false,
      compat: { supportsJsonSchemaResponseFormat: true },
    });
    const schema = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };

    const params = buildOpenAICompletionsParams(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] } as never,
      { responseFormat: schema },
    );

    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "openclaw_response", schema },
    });

    const toolParams = buildOpenAICompletionsParams(
      model,
      {
        messages: [{ role: "user", content: "weather", timestamp: 1 }],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      { responseFormat: schema },
    );
    expect(toolParams.tools).toHaveLength(1);
    expect(toolParams).not.toHaveProperty("response_format");

    const hostedCloudParams = buildOpenAICompletionsParams(
      { ...model, id: "gemma4", baseUrl: "https://ollama.com/v1" },
      { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] } as never,
      { responseFormat: schema },
    );
    expect(hostedCloudParams).not.toHaveProperty("response_format");
  });

  it("does not build OpenRouter reasoning params for Hunter Alpha when reasoning is disabled", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    ) as { reasoning?: unknown; reasoning_effort?: unknown };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("reasoning_effort");
  });
});
