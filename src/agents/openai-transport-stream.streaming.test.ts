import { createServer } from "node:http";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  classifyAssistantFailoverReason,
  formatUserFacingAssistantErrorText,
} from "./embedded-agent-helpers.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-transport-stream.js";
import {
  parseTransportChunkUsage,
  type CapturedStreamEvent,
  makeCompletionsModel,
  makeCompletionsChunk,
  createAssistantOutput,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("openai transport stream", () => {
  it("passes provider request timeouts to OpenAI SDK clients", () => {
    const requestTimeoutMs = 900_000;

    const responsesModel = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "custom-openai",
      baseUrl: "https://api.example.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      requestTimeoutMs,
    } satisfies Model<"openai-responses"> & { requestTimeoutMs: number };
    const azureModel = {
      ...responsesModel,
      api: "azure-openai-responses",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-5.4",
    } satisfies Model<"azure-openai-responses"> & { requestTimeoutMs: number };
    const completionsModel = {
      ...responsesModel,
      api: "openai-completions",
      reasoning: false,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(testing.buildOpenAISdkClientOptions(responsesModel).timeout).toBe(requestTimeoutMs);
    expect(testing.buildOpenAISdkClientOptions(azureModel).timeout).toBe(requestTimeoutMs);
    expect(testing.buildOpenAISdkClientOptions(completionsModel).timeout).toBe(requestTimeoutMs);
  });

  it("passes provider request timeouts to OpenAI SDK per-request options", () => {
    const signal = new AbortController().signal;
    const model = {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      requestTimeoutMs: 900_000.7,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(testing.buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
    });
    expect(
      testing.buildOpenAISdkRequestOptions(
        { ...model, requestTimeoutMs: -1 } as Model<"openai-completions">,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("streams OpenAI-compatible loopback requests with the configured SDK timeout", async () => {
    let captured: { path?: string; timeout?: string; model?: string; roles?: string[] } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ role?: string }>;
        };
        captured = {
          path: req.url,
          timeout: Array.isArray(req.headers["x-stainless-timeout"])
            ? req.headers["x-stainless-timeout"][0]
            : req.headers["x-stainless-timeout"],
          model: parsed.model,
          roles: parsed.messages?.map((message) => message.role ?? ""),
        };
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({}, "stop", {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
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
      const baseModel = {
        id: "mlx-community/Qwen3-30B-A3B-6bit",
        name: "Qwen3 MLX",
        api: "openai-completions",
        provider: "mlx",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
        requestTimeoutMs: 900_000,
      } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(captured.path).toBe("/v1/chat/completions");
      expect(captured.timeout).toBe("900");
      expect(captured.model).toBe("mlx-community/Qwen3-30B-A3B-6bit");
      expect(captured.roles).toEqual(["system", "user"]);
      expect(doneReason).toBe("stop");
      expect(text).toBe("OK");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses ModelStudio chat streams with no user or assistant payload turns", async () => {
    const model = makeCompletionsModel({
      id: "qwen-coder-plus",
      name: "qwen-coder-plus",
      provider: "qwen",
      baseUrl: "",
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 256,
    });
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      {
        systemPrompt: "runtime-only system prompt",
        messages: [],
        tools: [],
      } as never,
      { apiKey: "test-key" } as never,
    );

    let errorPayload: Record<string, unknown> | undefined;
    for await (const event of stream as AsyncIterable<{
      type: string;
      error?: Record<string, unknown>;
    }>) {
      if (event.type === "error") {
        errorPayload = event.error;
      }
    }

    expect(errorPayload).toMatchObject({ stopReason: "error" });
    expect(String(errorPayload?.errorMessage)).toContain(
      "contains no non-empty user or assistant messages",
    );
    expect(String(errorPayload?.errorMessage)).toContain("system/tool-only request");
  });

  it("allows generic OpenAI-compatible chat streams without the ModelStudio turn guard", async () => {
    let capturedRoles: string[] | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        capturedRoles = parsed.messages?.map((message) => message.role ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(`data: ${JSON.stringify(makeCompletionsChunk({}, "stop"))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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
        id: "generic-openai-compatible",
        name: "Generic OpenAI Compatible",
        provider: "custom-openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 256,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "runtime-only system prompt",
          messages: [],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      for await (const event of stream as AsyncIterable<{ type: string; reason?: string }>) {
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(capturedRoles).toEqual(["system"]);
      expect(doneReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("parses JSON chat completions returned to streaming requests", async () => {
    let capturedStreamFlag: unknown;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedStreamFlag = (JSON.parse(body) as { stream?: unknown }).stream;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            id: "chatcmpl-json-fallback",
            object: "chat.completion",
            model: "moonshotai/kimi-k2.6",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Need a direct answer.",
                  content: "live-ok",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
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
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        contextWindow: 256_000,
        maxTokens: 16_384,
        compat: {
          supportsReasoningEffort: true,
        },
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply live-ok", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key", reasoningEffort: "high" } as never,
      );

      let doneReason: string | undefined;
      let thinking = "";
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "thinking_delta") {
          thinking += event.delta ?? "";
        }
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(capturedStreamFlag).toBe(true);
      expect(thinking).toBe("Need a direct answer.");
      expect(text).toBe("live-ok");
      expect(doneReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("emits Qwen thinking streams when enabled without reasoning_effort support", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedPayload = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            id: "chatcmpl-qwen-thinking",
            object: "chat.completion",
            model: "qwen3.5-32b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Need a Qwen answer.",
                  content: "qwen-ok",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
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
        id: "qwen3.5-32b",
        name: "Qwen 3.5 32B",
        provider: "qwen",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        contextWindow: 131072,
        compat: {
          thinkingFormat: "qwen",
          supportsReasoningEffort: false,
        },
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply qwen-ok", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key", reasoning: "medium" } as never,
      );

      let thinking = "";
      let text = "";
      for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
        if (event.type === "thinking_delta") {
          thinking += event.delta ?? "";
        }
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
      }

      expect(capturedPayload?.enable_thinking).toBe(true);
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");
      expect(thinking).toBe("Need a Qwen answer.");
      expect(text).toBe("qwen-ok");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not emit thinking streams when reasoning is disabled", () => {
    const model = makeCompletionsModel({
      id: "grok-4.20-0309-reasoning",
      name: "Grok 4.20 0309 (Reasoning)",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      contextWindow: 1_000_000,
      maxTokens: 30_000,
    });

    expect(
      testing.shouldEmitOpenAICompletionsReasoningForModel(model, {
        apiKey: "test-key",
        reasoning: "off",
      } as never),
    ).toBe(false);
  });

  it("emits Z.ai thinking streams when enabled without reasoning_effort support", () => {
    const model = makeCompletionsModel({
      id: "glm-4.7",
      name: "GLM 4.7",
      provider: "zai",
      baseUrl: "",
      contextWindow: 128_000,
    });

    expect(
      testing.shouldEmitOpenAICompletionsReasoningForModel(model, {
        apiKey: "test-key",
        reasoning: "medium",
      } as never),
    ).toBe(true);
  });

  it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_error_metadata",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "Quota exceeded for api_key=sk-secret1234567890abcd",
              type: "rate_limit_error",
              code: "insufficient_quota",
            },
          }),
        );
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
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let errorPayload: Record<string, unknown> | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "error") {
          errorPayload = event.error;
        }
      }

      expect(errorPayload).toMatchObject({
        stopReason: "error",
        errorCode: "insufficient_quota",
        errorType: "rate_limit_error",
      });
      expect(String(errorPayload?.errorBody)).toContain("Quota exceeded");
      expect(String(errorPayload?.errorBody)).not.toContain("sk-secret1234567890abcd");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("classifies OpenAI-compatible unsupported-model detail from failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_not_supported_model",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "400",
              message: "Param Incorrect",
              param: "Not supported model some-model-id",
            },
          }),
        );
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
        id: "some-model-id",
        name: "Some Model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let errorPayload: Record<string, unknown> | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "error") {
          errorPayload = event.error;
        }
      }

      expect(errorPayload).toMatchObject({
        stopReason: "error",
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
      });
      expect(String(errorPayload?.errorBody)).toContain("Not supported model some-model-id");
      expect(classifyAssistantFailoverReason(errorPayload as never)).toBe("model_not_found");
      expect(formatUserFacingAssistantErrorText(errorPayload as never)).toBe(
        "The selected model was not found by the provider. Check the model id or choose a different model.",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves reasoning tokens without double-counting them", () => {
    const model = makeCompletionsModel({
      id: "gpt-5",
      name: "GPT-5",
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
    });

    expectRecordFields(
      parseTransportChunkUsage(
        {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
        model,
      ),
      {
        input: 7,
        output: 20,
        cacheRead: 3,
        reasoningTokens: 7,
        totalTokens: 30,
      },
    );
  });

  it("preserves a valid provider-reported usage cost", () => {
    const model = makeCompletionsModel({
      id: "openrouter/free",
      name: "OpenRouter Free",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });

    const usage = parseTransportChunkUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0,
      },
      model,
    );

    expect(usage.cost.total).toBe(0);
    expect(usage.cost.totalOrigin).toBe("provider-billed");
  });

  it("keeps the catalog estimate for an invalid provider-reported usage cost", () => {
    const model = makeCompletionsModel({
      id: "openrouter/free",
      name: "OpenRouter Free",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });

    const usage = parseTransportChunkUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: -1,
      },
      model,
    );

    expect(usage.cost.total).toBeCloseTo(0.00002);
    expect(usage.cost.totalOrigin).toBeUndefined();
  });

  it("clamps uncached prompt usage at zero", () => {
    const model = makeCompletionsModel({
      id: "gpt-5",
      name: "GPT-5",
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
    });

    expectRecordFields(
      parseTransportChunkUsage(
        {
          prompt_tokens: 2,
          completion_tokens: 5,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 4 },
        },
        model,
      ),
      {
        input: 0,
        output: 5,
        cacheRead: 4,
        totalTokens: 9,
      },
    );
  });

  it("records usage from OpenAI-compatible streaming usage chunks", async () => {
    const model = makeCompletionsModel({
      id: "glm-5",
      name: "GLM-5",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream: { push(event: unknown): void } = { push() {} };

    async function* mockStream() {
      yield makeCompletionsChunk({ role: "assistant" as const, content: "ok" }, "stop" as const);
      yield makeCompletionsChunk({}, null, {
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 10,
          total_tokens: 18,
        },
      });
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expectRecordFields(output.usage, {
      input: 8,
      output: 10,
      cacheRead: 0,
      totalTokens: 18,
    });
  });

  it("emits reasoning activity for OpenAI-compatible usage-only reasoning chunks", async () => {
    const model = makeCompletionsModel({
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "vertex-ai",
      baseUrl: "http://127.0.0.1:8787/v1beta1/projects/test/locations/us/endpoints/openapi",
      contextWindow: 1_000_000,
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({}, null, {
          choices: [],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 23,
            total_tokens: 31,
            completion_tokens_details: { reasoning_tokens: 23 },
          },
        }),
        makeCompletionsChunk({ role: "assistant" as const, content: "Hi" }, "stop" as const),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(events.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "text_start",
      "text_delta",
    ]);
    expect(events[1]).toHaveProperty("delta", "");
    expect(output.content).toEqual([
      { type: "thinking", thinking: "" },
      { type: "text", text: "Hi" },
    ]);
  });

  it("does not add trailing reasoning activity after visible OpenAI-compatible text", async () => {
    const model = makeCompletionsModel({
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "vertex-ai",
      baseUrl: "http://127.0.0.1:8787/v1beta1/projects/test/locations/us/endpoints/openapi",
      contextWindow: 1_000_000,
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({ role: "assistant" as const, content: "Hi" }),
        makeCompletionsChunk({}, null, {
          choices: [],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 25,
            total_tokens: 33,
            completion_tokens_details: { reasoning_tokens: 23 },
          },
        }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(events.map((event) => event.type)).toEqual(["text_start", "text_delta"]);
    expect(output.content).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("yields to aborts during bursty OpenAI-compatible streams", async () => {
    const model = makeCompletionsModel({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "opencode-go",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const output = createAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn() };
    let yieldedToTimer = false;

    async function* mockStream() {
      for (let index = 0; index < 512; index += 1) {
        yield makeCompletionsChunk({ role: "assistant" as const, content: "x" });
      }
    }

    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    await expect(
      testing.processOpenAICompletionsStream(mockStream(), output, model, stream, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("omits accumulated partial snapshots from OpenAI-compatible text deltas", async () => {
    const model = makeCompletionsModel({
      id: "dense-local",
      name: "Dense Local",
      provider: "local",
      baseUrl: "http://127.0.0.1:18065/v1",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({ role: "assistant" as const, content: "a" }),
        makeCompletionsChunk({ content: "b" }),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it("yields to aborts during bursty Responses streams", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn() };
    let yieldedToTimer = false;

    async function* mockStream() {
      yield { type: "response.output_item.added", item: { type: "message" } };
      for (let index = 0; index < 512; index += 1) {
        yield { type: "response.output_text.delta", delta: "x" };
      }
    }

    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    await expect(
      testing.processResponsesStream(mockStream(), output, stream, model, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("omits accumulated partial snapshots from Responses text deltas", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processResponsesStream(
      streamChunks([
        { type: "response.output_item.added", item: { type: "message" } },
        { type: "response.output_text.delta", delta: "a" },
        { type: "response.output_text.delta", delta: "b" },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it.each([
    ["omits arguments", undefined],
    ["sends empty arguments", ""],
  ])("preserves streamed Responses arguments when done %s", async (_label, doneArguments) => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const streamedArguments = '{"path":"docs/nodes/computer-use.md"}';

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: streamedArguments },
        {
          type: "response.function_call_arguments.done",
          ...(doneArguments === undefined ? {} : { arguments: doneArguments }),
          item_id: "fc_read",
          output_index: 0,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_read", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "docs/nodes/computer-use.md" },
        partialJson: streamedArguments,
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("keeps idless Responses tool-call ids stable and response-unique", async () => {
    const runOnce = async () => {
      const model = createAzureResponsesModel();
      const output = createResponsesAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      await testing.processResponsesStream(
        streamChunks([
          {
            type: "response.output_item.added",
            item: { type: "function_call", name: "computer", arguments: "" },
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", name: "computer", arguments: "{}" },
          },
        ]),
        output,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        model,
      );
      const block = output.content.find((entry) => entry.type === "toolCall") as
        | { id?: string }
        | undefined;
      const end = events.find((event) => event.type === "toolcall_end") as
        | { toolCall?: { id?: string } }
        | undefined;
      if (!block?.id || !end?.toolCall?.id) {
        throw new Error("missing tool-call lifecycle");
      }
      return { blockId: block.id, endId: end.toolCall.id };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.blockId).toMatch(/^call_[0-9a-f]{24}$/);
    expect(first.endId).toBe(first.blockId);
    expect(second.endId).toBe(second.blockId);
    expect(second.blockId).not.toBe(first.blockId);
  });

  it("materializes one stable tool call for a done-only idless Responses item", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const item = {
      type: "function_call",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 0,
          item,
        },
        {
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp_done_only_idless",
            status: "completed",
            output: [item],
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "computer",
        arguments: { action: "screenshot" },
        partialJson: '{"action":"screenshot"}',
      },
    ]);
    const toolEvents = events.filter((event) => event.type?.startsWith("toolcall_")) as Array<{
      type: string;
      contentIndex: number;
      toolCall?: { id?: string };
    }>;
    expect(toolEvents.map((event) => [event.type, event.contentIndex])).toEqual([
      ["toolcall_start", 0],
      ["toolcall_end", 0],
    ]);
    expect(toolEvents[1]?.toolCall?.id).toBe((output.content[0] as { id?: string }).id);
  });

  it("uses an SDK function call call_id directly when its optional item id is absent", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const item = {
      type: "function_call",
      call_id: "call_sdk_without_item_id",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 0,
          item,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item,
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_sdk_without_item_id",
            status: "completed",
            output: [item],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_sdk_without_item_id", name: "computer" },
    ]);
  });

  it("reconciles an idless added Responses item to its canonical done identity", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const doneItem = {
      type: "function_call",
      id: "fc_canonical",
      call_id: "call_canonical",
      name: "computer",
      arguments: '{"action":"screenshot"}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 0,
          item: { type: "function_call", name: "computer", arguments: "" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: doneItem,
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_canonical_tool_identity",
            status: "completed",
            output: [doneItem],
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_canonical|fc_canonical", name: "computer" },
    ]);
    const end = events.find((event) => event.type === "toolcall_end") as
      | { toolCall?: { id?: string } }
      | undefined;
    expect(end?.toolCall?.id).toBe("call_canonical|fc_canonical");
  });

  it("keeps interleaved Responses function calls bound to their output indices", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{
      type?: string;
      contentIndex?: number;
      toolCall?: { id?: string };
    }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 1,
          item: {
            type: "function_call",
            id: "fc_click",
            call_id: "call_click",
            name: "computer",
            arguments: "",
            status: "in_progress",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          sequence_number: 2,
          item: {
            type: "function_call",
            id: "fc_type",
            call_id: "call_type",
            name: "computer",
            arguments: "",
            status: "in_progress",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_type",
          sequence_number: 3,
          delta: '{"action":"type","text":"hello"}',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_click",
          sequence_number: 4,
          delta: '{"action":"left_click","coordinate":[10,20]}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 5,
          item: {
            type: "function_call",
            id: "fc_click",
            call_id: "call_click",
            name: "computer",
            arguments: '{"action":"left_click","coordinate":[10,20]}',
            status: "completed",
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          sequence_number: 6,
          item: {
            type: "function_call",
            id: "fc_type",
            call_id: "call_type",
            name: "computer",
            arguments: '{"action":"type","text":"hello"}',
            status: "completed",
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_click|fc_click",
        name: "computer",
        arguments: { action: "left_click", coordinate: [10, 20] },
        partialJson: '{"action":"left_click","coordinate":[10,20]}',
      },
      {
        type: "toolCall",
        id: "call_type|fc_type",
        name: "computer",
        arguments: { action: "type", text: "hello" },
        partialJson: '{"action":"type","text":"hello"}',
      },
    ]);
    expect(
      events
        .filter((event) => event.type?.startsWith("toolcall_"))
        .map((event) => [event.type, event.contentIndex]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_start", 1],
      ["toolcall_delta", 1],
      ["toolcall_delta", 0],
      ["toolcall_end", 0],
      ["toolcall_end", 1],
    ]);
    expect(
      events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall?.id),
    ).toEqual(["call_click|fc_click", "call_type|fc_type"]);
  });

  it("routes indexed Responses tool arguments when item ids rotate", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "encrypted_delta_1",
          delta: '{"path":',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "encrypted_delta_2",
          delta: '"README.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "encrypted_done",
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_read", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.content).toMatchObject([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("rejects indexed Responses completions when call ids change", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read",
              call_id: "call_read_a",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "encrypted_delta",
            delta: '{"path":"README.md"}',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read_done",
              call_id: "call_read_b",
              name: "read",
              arguments: '{"path":"README.md"}',
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_read", status: "completed" },
          },
        ]),
        output,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
  });

  it("rejects reuse of an active Responses tool-call output index", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string }> = [];

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_first_index_owner",
              call_id: "call_first_index_owner",
              name: "computer",
              arguments: "",
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_second_index_owner",
              call_id: "call_second_index_owner",
              name: "computer",
              arguments: "",
            },
          },
        ]),
        output,
        { push: (event) => events.push(event as (typeof events)[number]) },
        model,
      ),
    ).rejects.toThrow("Responses stream reused active tool-call output index 0");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("keeps parallel unindexed Responses calls bound by identity without orphans", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{
      type?: string;
      contentIndex?: number;
      toolCall?: { id?: string; arguments?: unknown };
    }> = [];
    const firstItem = {
      type: "function_call",
      id: "fc_first_unindexed",
      call_id: "call_first_unindexed",
      name: "computer",
      arguments: '{"slot":1}',
      status: "completed",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_second_unindexed",
      call_id: "call_second_unindexed",
      name: "computer",
      arguments: '{"slot":2}',
      status: "completed",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: { ...firstItem, arguments: "", status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          item: { ...secondItem, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: secondItem.id,
          delta: secondItem.arguments,
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: firstItem.id,
          delta: firstItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: firstItem.id,
          arguments: firstItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: secondItem.id,
          arguments: secondItem.arguments,
        },
        { type: "response.output_item.done", item: firstItem },
        { type: "response.output_item.done", item: secondItem },
        {
          type: "response.completed",
          response: {
            id: "resp_parallel_unindexed",
            status: "completed",
            output: [firstItem, secondItem],
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_first_unindexed|fc_first_unindexed",
        name: "computer",
        arguments: { slot: 1 },
        partialJson: '{"slot":1}',
      },
      {
        type: "toolCall",
        id: "call_second_unindexed|fc_second_unindexed",
        name: "computer",
        arguments: { slot: 2 },
        partialJson: '{"slot":2}',
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) => [event.contentIndex, event.toolCall?.id, event.toolCall?.arguments]),
    ).toEqual([
      [0, "call_first_unindexed|fc_first_unindexed", { slot: 1 }],
      [1, "call_second_unindexed|fc_second_unindexed", { slot: 2 }],
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
  });

  it("fails closed on ambiguous unindexed parallel argument events", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string }> = [];
    const firstItem = {
      type: "function_call",
      id: "fc_ambiguous_first",
      call_id: "call_ambiguous_first",
      name: "computer",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_ambiguous_second",
      call_id: "call_ambiguous_second",
      name: "computer",
    };

    await expect(
      testing.processResponsesStream(
        streamChunks([
          { type: "response.output_item.added", item: { ...firstItem, arguments: "" } },
          { type: "response.output_item.added", item: { ...secondItem, arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
          { type: "response.output_item.done", item: firstItem },
          { type: "response.output_item.done", item: secondItem },
          {
            type: "response.completed",
            response: { id: "resp_ambiguous_unindexed", status: "completed" },
          },
        ]),
        output,
        { push: (event) => events.push(event as (typeof events)[number]) },
        model,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("recovers parallel Responses arguments from done events and preserves opening names", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const firstItem = {
      type: "function_call",
      id: "fc_recovered_first",
      call_id: "call_recovered_first",
      name: "read",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_recovered_second",
      call_id: "call_recovered_second",
      name: "write",
    };

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...firstItem, arguments: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...secondItem, arguments: "" },
        },
        { type: "response.function_call_arguments.delta", delta: '{"ambiguous":true}' },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: firstItem.id,
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: secondItem.id,
          arguments: '{"path":"README.md","text":"ok"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: firstItem.id,
            call_id: firstItem.call_id,
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: secondItem.id,
            call_id: secondItem.call_id,
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_recovered_parallel", status: "completed" },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_recovered_first|fc_recovered_first",
        name: "read",
        arguments: { path: "README.md" },
        partialJson: '{"path":"README.md"}',
      },
      {
        type: "toolCall",
        id: "call_recovered_second|fc_recovered_second",
        name: "write",
        arguments: { path: "README.md", text: "ok" },
        partialJson: '{"path":"README.md","text":"ok"}',
      },
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects a completed Responses tool call whose function name changed", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_name_conflict",
              call_id: "call_name_conflict",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_name_conflict",
              call_id: "call_name_conflict",
              name: "write",
              arguments: "{}",
            },
          },
        ]),
        output,
        { push: vi.fn() },
        model,
      ),
    ).rejects.toThrow("Responses stream changed tool-call function name from read to write");
  });

  it("routes an omitted-index suffix by item id across parallel Responses calls", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string; contentIndex?: number }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_first",
          delta: '{"slot":',
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_first",
          delta: "0}",
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"slot":1}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex),
    ).toEqual([0, 0, 1]);
  });

  it("matches omitted-index parallel completions without duplicating indexed calls", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string; contentIndex?: number }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_first",
          delta: '{"incomplete":',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects omitted-index events whose identity mismatches the sole indexed call", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string; contentIndex?: number }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_other",
          delta: '{"wrong":true}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_other",
            call_id: "call_other",
            name: "computer",
            arguments: '{"wrong":true}',
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_delta")).toHaveLength(0);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("keeps sequential omitted-index Responses calls unambiguous", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: Array<{ type?: string; contentIndex?: number }> = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 7,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: '{"slot":0}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
        {
          type: "response.output_item.added",
          output_index: 8,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as (typeof events)[number]) },
      model,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex),
    ).toEqual([0, 1]);
  });

  it("handles Azure Responses text content and text delta events", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            role: "assistant",
            id: "msg_azure_text",
            content: [],
            status: "in_progress",
          },
        },
        { type: "response.text.delta", delta: "Hello" },
        { type: "response.text.delta", delta: " from Azure!" },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg_azure_text",
            content: [{ type: "text", text: "Hello from Azure!" }],
            status: "completed",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_azure_text",
            status: "completed",
            usage: {
              input_tokens: 4,
              output_tokens: 3,
              total_tokens: 7,
            },
          },
        },
      ]),
      output,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      model,
    );

    expect(events).toMatchObject([
      { type: "text_start" },
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " from Azure!" },
      { type: "text_end", content: "Hello from Azure!" },
    ]);
    expect(output.content).toMatchObject([{ type: "text", text: "Hello from Azure!" }]);
    expectRecordFields(output.usage, {
      input: 4,
      output: 3,
      totalTokens: 7,
    });
    expect(output.responseId).toBe("resp_azure_text");
  });

  it("skips null and non-object OpenAI-compatible stream chunks", async () => {
    const model = makeCompletionsModel({
      id: "glm-5",
      name: "GLM-5",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream: { push(event: unknown): void } = { push() {} };

    async function* mockStream() {
      yield null as never;
      yield "not-a-chunk" as never;
      yield makeCompletionsChunk({ role: "assistant" as const, content: "ok" }, "stop" as const);
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toStrictEqual([{ type: "text", text: "ok" }]);
    expect(output.stopReason).toBe("stop");
  });

  it("surfaces chat-completions refusal deltas as visible assistant text", async () => {
    const model = makeCompletionsModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          { role: "assistant", content: null, refusal: "I can't help with that." },
          "stop",
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    expect(output.content).toStrictEqual([{ type: "text", text: "I can't help with that." }]);
    expect(output.stopReason).toBe("stop");
    expect(
      events.some(
        (event) => event.type === "text_delta" && event.delta === "I can't help with that.",
      ),
    ).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
