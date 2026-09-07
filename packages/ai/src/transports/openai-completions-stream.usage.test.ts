import { describe, expect, it, vi } from "vitest";
import { createZeroUsage } from "../usage.test-support.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";
import { parseOpenAICompletionsUsage } from "./openai-transport-shared.js";

describe("openai completions stream", () => {
  it("preserves reasoning tokens without double-counting them", () => {
    const model = makeCompletionsModel({
      id: "gpt-5",
      name: "GPT-5",
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
    });

    expectRecordFields(
      parseOpenAICompletionsUsage(
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

    const usage = parseOpenAICompletionsUsage(
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

  it("maps cache_write_tokens as a separate write count", () => {
    const model = makeCompletionsModel({
      id: "openrouter/cached",
      name: "OpenRouter Cached",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });

    const usage = parseOpenAICompletionsUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      },
      model,
    );

    // Writes are their own bucket: they must leave `input` and land in `totalTokens`,
    // matching the plugin-sdk completions provider.
    expect(usage).toMatchObject({ input: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 15 });
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

    const usage = parseOpenAICompletionsUsage(
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
      parseOpenAICompletionsUsage(
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
      usage: createZeroUsage(),
      stopReason: "stop" as const,
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

    await processCompletionsStream(mockStream(), output, model, stream);

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

    await processCompletionsStream(
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

    await processCompletionsStream(
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
      processCompletionsStream(mockStream(), output, model, stream, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("does not finalize tool calls when cancellation ends the iterator normally", async () => {
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const abort = new AbortController();
    const events: CapturedStreamEvent[] = [];

    async function* silentlyAbortedStream() {
      yield makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_aborted",
              type: "function",
              function: { name: "read", arguments: '{"path":"example.txt"}' },
            },
          ],
        },
        "stop",
      );
      abort.abort();
    }

    await expect(
      processCompletionsStream(
        silentlyAbortedStream(),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        { signal: abort.signal },
      ),
    ).rejects.toThrow("Request was aborted");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
    expect(output.stopReason).not.toBe("toolUse");
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

    await processCompletionsStream(
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
      usage: createZeroUsage(),
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const stream: { push(event: unknown): void } = { push() {} };

    async function* mockStream() {
      yield null as never;
      yield "not-a-chunk" as never;
      yield makeCompletionsChunk({ role: "assistant" as const, content: "ok" }, "stop" as const);
    }

    await processCompletionsStream(mockStream(), output, model, stream);

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

    await processCompletionsStream(
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
