// Imported by openai-transport-stream.test.ts to keep its mocked suite in one Vitest module graph.
import { createServer } from "node:http";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  buildOpenAICompletionsParams,
  createOpenAICompletionsTransportStreamFn,
  testing,
} from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  type CapturedStreamEvent,
  makeCompletionsModel,
  makeResponsesModel,
  makeCompletionsChunk,
  createDeepSeekCompletionsModel,
  createAssistantOutput,
  createAzureResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

describe("openai transport stream", () => {
  it("surfaces aggregated chat-completions message.refusal as visible assistant text", async () => {
    const model = makeCompletionsModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({}, null, {
          choices: [
            {
              index: 0,
              // Some OpenAI-compatible endpoints deliver a full message instead of delta.
              message: {
                role: "assistant",
                content: null,
                refusal: "Requests like this are not allowed.",
              },
              logprobs: null,
              finish_reason: "stop",
            } as unknown as ChatCompletionChunk["choices"][number],
          ],
        }),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toStrictEqual([
      { type: "text", text: "Requests like this are not allowed." },
    ]);
    expect(output.stopReason).toBe("stop");
  });

  it("filters DeepSeek DSML content without disturbing native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "before <｜DSML｜tool_use_error>body</｜DSML｜tool_use_error> after",
        }),
        makeCompletionsChunk(
          {
            content: "<|DSML|tool_calls>shadow</|DSML|tool_calls>",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      { type: "text", text: "before  after" },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
        partialArgs: '{"path":"/tmp/native.md"}',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("preserves DeepSeek visible content before same-chunk native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "I'll check",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toEqual([
      { type: "text", text: "I'll check" },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
        partialArgs: '{"path":"/tmp/native.md"}',
      },
    ]);
  });

  it("filters DeepSeek DSML text queued after native tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
        makeCompletionsChunk({
          content: "<|DSML|tool_calls>shadow</|DSML|tool_calls> visible",
        }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
        partialArgs: '{"path":"/tmp/native.md"}',
      },
      { type: "text", text: " visible" },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("keeps DeepSeek DSML state across native tool-call chunks", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "before <|DSML|tool",
            tool_calls: [
              {
                index: 0,
                id: "call_native_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
        makeCompletionsChunk({
          content: "_calls>shadow</|DSML|tool_calls> after",
        }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toEqual([
      { type: "text", text: "before " },
      {
        type: "toolCall",
        id: "call_native_1",
        name: "read",
        arguments: { path: "/tmp/native.md" },
        partialArgs: '{"path":"/tmp/native.md"}',
      },
      { type: "text", text: " after" },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("recovers DeepSeek DSML parameter tool calls emitted as text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content:
              '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n<｜DSML｜parameter name="sessionKey" string="true">current</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
          "stop",
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "session_status",
        arguments: { sessionKey: "current" },
        partialArgs: '{"sessionKey":"current"}',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it.each([
    { finishReason: "length", stopReason: "length" },
    { finishReason: "content_filter", stopReason: "error" },
  ])(
    "does not authorize recovered DeepSeek DSML calls after $finishReason",
    async ({ finishReason, stopReason }) => {
      const model = createDeepSeekCompletionsModel();
      const output = createAssistantOutput(model);
      expect(testing.getCompat(model).thinkingFormat).toBe("deepseek");

      await testing.processOpenAICompletionsStream(
        streamChunks([
          makeCompletionsChunk(
            {
              content:
                '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
            },
            finishReason,
          ),
        ]),
        output,
        model,
        { push() {} },
      );

      expect(output.stopReason).toBe(stopReason);
      expect(output.content).toEqual([]);
    },
  );

  it("does not authorize recovered DeepSeek DSML calls when the stream omits a terminal", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content:
            '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
        }),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
  });

  it("emits recovered DeepSeek content-filter terminals as errors", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk(
              {
                content:
                  '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
              },
              "content_filter",
            ),
          )}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        ...createDeepSeekCompletionsModel(),
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Read the file", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      const terminalEvents: Array<{
        type: string;
        reason?: string;
        error?: Record<string, unknown>;
      }> = [];
      for await (const event of stream as AsyncIterable<{
        type: string;
        reason?: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "done" || event.type === "error") {
          terminalEvents.push(event);
        }
      }

      expect(terminalEvents).toEqual([
        expect.objectContaining({
          type: "error",
          reason: "error",
          error: expect.objectContaining({
            stopReason: "error",
            errorMessage: "Provider finish_reason: content_filter",
            content: [],
          }),
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("parses repeated DeepSeek DSML calls with response-unique ids", async () => {
    // Guards the cached attribute matchers: repeated parses must stay identical
    // apart from invocation identity (no stale RegExp lastIndex).
    const model = createDeepSeekCompletionsModel();
    const content =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n<｜DSML｜parameter name="sessionKey" string="true">current</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';

    const runOnce = async () => {
      const output = createAssistantOutput(model);
      await testing.processOpenAICompletionsStream(
        streamChunks([makeCompletionsChunk({ content }, "stop")]),
        output,
        model,
        { push() {} },
      );
      return output.content;
    };

    const first = await runOnce();
    const second = await runOnce();
    for (const resultContent of [first, second]) {
      expect(resultContent).toEqual([
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
          name: "session_status",
          arguments: { sessionKey: "current" },
          partialArgs: '{"sessionKey":"current"}',
        },
      ]);
    }
    expect((second[0] as { id?: string }).id).not.toBe((first[0] as { id?: string }).id);
  });

  it("recovers split DeepSeek DSML JSON tool calls emitted as text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: '<|DSML|tool_calls><|DSML|invoke name="read">' }),
        makeCompletionsChunk({ content: '{"path":"/tmp/native.md"}</|DSML|invoke>' }),
        makeCompletionsChunk({ content: "</|DSML|tool_calls>" }, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "read",
        arguments: { path: "/tmp/native.md" },
        partialArgs: '{"path":"/tmp/native.md"}',
      },
    ]);
  });

  it("does not recover malformed DeepSeek DSML tool calls", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content:
              '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
          "stop",
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
  });

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
        responseFormat: { type: "json_schema", json_schema: {} },
      });
      expect(params.response_format).toEqual({ type: "json_schema", json_schema: {} });
    }

    {
      const params = buildOpenAICompletionsParams(model, context, {});
      expect(params).not.toHaveProperty("response_format");
    }
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

  it("uses system role instead of developer for responses providers that disable developer role", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]?.role).toBe("system");
  });

  it("adds explicit message item types for Responses system and user input items", () => {
    const params = buildOpenAIResponsesParams(
      createAzureResponsesModel(),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ type?: string; role?: string; content?: unknown }> };

    expect(params.input?.[0]).toMatchObject({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "system" }],
    });
    expect(params.input?.[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  it("omits Responses reasoning params when model compat disables reasoning effort", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 0309 (Reasoning)",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 30_000,
        compat: { supportsReasoningEffort: false },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("preserves xAI Grok 4.3 default reasoning by omitting default none", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
        },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("passes explicit xAI Grok 4.3 reasoning effort through", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
        },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps developer role for native OpenAI reasoning responses models", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]?.role).toBe("developer");
  });

  it("serializes Responses input messages with explicit message type and content parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
      }),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      } as never,
      undefined,
    ) as { input?: unknown };

    expect(params.input).toEqual([
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "system" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  it("uses model maxTokens for Responses params when runtime maxTokens is omitted", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        maxTokens: 65_536,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { max_output_tokens?: unknown };

    expect(params.max_output_tokens).toBe(65_536);
  });

  it("prefers promptCacheKey over sessionId for Responses prompt-cache affinity", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        sessionId: "run-session",
        promptCacheKey: "cron-cache-key",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("cron-cache-key");
  });

  it("clamps Responses promptCacheKey before sending it upstream", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        promptCacheKey: "x".repeat(80),
        sessionId: "session-123",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("x".repeat(64));
  });

  it("omits Responses prompt_cache_key when caching is disabled", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        sessionId: "run-session",
        promptCacheKey: "cron-cache-key",
        cacheRetention: "none",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBeUndefined();
  });

  it("adds fallback instructions for raw native Codex responses probes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
        tools: [],
      } as never,
      {
        maxTokens: 16,
        sessionId: "session-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Follow the user request.");
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.prompt_cache_retention).toBeUndefined();
  });

  it("treats canonical OpenAI Codex responses models as native Codex responses", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
        tools: [],
      } as never,
      {
        maxTokens: 16,
        sessionId: "session-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Follow the user request.");
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.prompt_cache_retention).toBeUndefined();
  });

  it("does not add fallback instructions for custom Codex-compatible responses backends", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
        tools: [],
      } as never,
      {
        maxTokens: 16,
        sessionId: "session-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBeUndefined();
    expect(params.max_output_tokens).toBe(16);
  });

  it("uses top-level instructions for Codex responses and preserves prompt cache identity", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(Array.isArray(params.input)).toBe(true);
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expect(
      params.input?.filter((item) => item.role === "system" || item.role === "developer"),
    ).toStrictEqual([]);
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("keeps Codex response shaping when simple completions use the OpenClaw transport alias", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openclaw-openai-responses-transport" as Api,
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("sanitizes Codex responses params after payload hooks mutate them without stripping cache identity", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
      text: { format: { type: "json_object" }, verbosity: "low" },
      top_p: 0.85,
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      payload,
    );

    expect(sanitized.prompt_cache_key).toBe("session-123");
    expect(sanitized).not.toHaveProperty("metadata");
    expect(sanitized).not.toHaveProperty("max_output_tokens");
    expect(sanitized).not.toHaveProperty("prompt_cache_retention");
    expect(sanitized).not.toHaveProperty("service_tier");
    expect(sanitized).not.toHaveProperty("temperature");
    expect(sanitized.text).toEqual({ verbosity: "low" });
    expect(sanitized).not.toHaveProperty("top_p");
  });

  it("preserves custom Codex-compatible responses params", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
      }),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.metadata).toEqual({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
    });
    expect(params.max_output_tokens).toBe(1024);
    expect(params.temperature).toBe(0.2);
    expect(params.top_p).toBe(0.85);
  });

  it("forwards response_format to responses text format request params", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      maxTokens: 65_536,
    });

    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [],
    } as never;

    {
      const params = buildOpenAIResponsesParams(model, context, {
        responseFormat: { type: "json_object" },
      }) as Record<string, unknown>;
      expect(params.text).toEqual({ format: { type: "json_object" } });
    }

    {
      const params = buildOpenAIResponsesParams(model, context, {
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "test", schema: { type: "object" } },
        },
      }) as Record<string, unknown>;
      expect(params.text).toEqual({
        format: { type: "json_schema", name: "test", schema: { type: "object" } },
      });
    }

    {
      const params = buildOpenAIResponsesParams(model, context, {}) as Record<string, unknown>;
      expect(params).not.toHaveProperty("text");
    }
  });

  it("preserves custom Codex-compatible responses params after payload hooks mutate them", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
      }),
      payload,
    );

    expect(sanitized).toEqual(payload);
  });

  it("omits native Codex replay item ids and unproven encrypted reasoning", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
          { role: "user", content: "what is the capital of the philippines", timestamp: 3 },
        ],
        tools: [],
      } as never,
      { sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
  });
});
