import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  convertToOllamaMessages,
  buildAssistantMessage,
  parseNdjsonStream,
  resolveOllamaBaseUrlForRun,
} from "./stream.js";

type GuardedFetchCall = {
  url: string;
  init?: RequestInit;
  policy?: unknown;
  auditContext?: string;
};

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("buildOllamaChatRequest", () => {
  it("omits tools when none are provided", () => {
    expect(
      buildOllamaChatRequest({
        modelId: "qwen3.5:9b",
        messages: [{ role: "user", content: "hello" }],
        options: { num_ctx: 65536 },
      }),
    ).toEqual({
      model: "qwen3.5:9b",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      options: { num_ctx: 65536 },
    });
  });

  it("strips the ollama/ prefix from chat model ids", () => {
    expect(
      buildOllamaChatRequest({
        modelId: "ollama/qwen3:14b-q8_0",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({
      model: "qwen3:14b-q8_0",
    });
  });
});

describe("createConfiguredOllamaCompatStreamWrapper", () => {
  it("adds Moonshot thinking config for Ollama cloud Kimi compat requests", async () => {
    let patchedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      options?.onPayload?.({ tool_choice: "auto" });
      return (async function* () {})();
    });
    const model = {
      api: "openai-completions",
      provider: "ollama",
      id: "kimi-k2.5:cloud",
      contextWindow: 262144,
    };

    const wrapped = createConfiguredOllamaCompatStreamWrapper({
      provider: "ollama",
      modelId: "kimi-k2.5:cloud",
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "high",
      extraParams: {},
    } as never);

    await wrapped?.(
      model as never,
      { messages: [] } as never,
      {
        onPayload: (payload: unknown) => {
          patchedPayload = payload as Record<string, unknown>;
        },
      } as never,
    );

    expect(patchedPayload).toMatchObject({
      thinking: { type: "enabled" },
      options: { num_ctx: 262144 },
    });
  });
});

describe("convertToOllamaMessages", () => {
  it("converts user text messages", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts user messages with content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", data: "base64data" },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "user", content: "describe this", images: ["base64data"] }]);
  });

  it("prepends system message when provided", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages, "You are helpful.");
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result[1]).toEqual({ role: "user", content: "hello" });
  });

  it("converts assistant messages with toolCall content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me check.");
    expect(result[0].tool_calls).toEqual([
      { function: { name: "bash", arguments: { command: "ls" } } },
    ]);
  });

  it("deserializes string arguments back to objects for Ollama (round-trip fix)", () => {
    // When tool calls round-trip through OpenAI-format storage, arguments
    // are serialized as a JSON string.  Ollama expects an object.
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_2",
            name: "Read",
            arguments: '{"file_path":"/tmp/test.txt"}',
          },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      { function: { name: "Read", arguments: { file_path: "/tmp/test.txt" } } },
    ]);
  });

  it("handles tool_use blocks with string input (Anthropic format round-trip)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "exec", input: '{"command":"echo hello"}' },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      { function: { name: "exec", arguments: { command: "echo hello" } } },
    ]);
  });

  it("preserves unsafe integers as strings when replay args are deserialized", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_3",
            name: "read",
            arguments: '{"path":9223372036854775807,"nested":{"thread":1234567890123456789}}',
          },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      {
        function: {
          name: "read",
          arguments: {
            path: "9223372036854775807",
            nested: { thread: "1234567890123456789" },
          },
        },
      },
    ]);
  });
  it("converts tool result messages with 'tool' role", () => {
    const messages = [{ role: "tool", content: "file1.txt\nfile2.txt" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "file1.txt\nfile2.txt" }]);
  });

  it("converts SDK 'toolResult' role to Ollama 'tool' role", () => {
    const messages = [{ role: "toolResult", content: "command output here" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "command output here" }]);
  });

  it("includes tool_name from SDK toolResult messages", () => {
    const messages = [{ role: "toolResult", content: "file contents here", toolName: "read" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "file contents here", tool_name: "read" }]);
  });

  it("omits tool_name when not provided in toolResult", () => {
    const messages = [{ role: "toolResult", content: "output" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "output" }]);
    expect(result[0]).not.toHaveProperty("tool_name");
  });

  it("handles empty messages array", () => {
    const result = convertToOllamaMessages([]);
    expect(result).toEqual([]);
  });
});

describe("buildAssistantMessage", () => {
  const modelInfo = { api: "ollama", provider: "ollama", id: "qwen3:32b" };

  it("builds text-only response", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: { role: "assistant" as const, content: "Hello!" },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
  });

  it("keeps thinking-only output when content is empty", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        thinking: "Thinking output",
      },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "thinking", thinking: "Thinking output" }]);
  });

  it("keeps reasoning-only output when content and thinking are empty", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        reasoning: "Reasoning output",
      },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "thinking", thinking: "Reasoning output" }]);
  });

  it("builds response with tool calls", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ function: { name: "bash", arguments: { command: "ls -la" } } }],
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 10,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.length).toBe(1); // toolCall only (empty content is skipped)
    expect(result.content[0].type).toBe("toolCall");
    const toolCall = result.content[0] as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolCall.name).toBe("bash");
    expect(toolCall.arguments).toEqual({ command: "ls -la" });
    expect(toolCall.id).toMatch(/^ollama_call_[0-9a-f-]{36}$/);
  });

  it("sets all costs to zero for local models", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: { role: "assistant" as const, content: "ok" },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});

// Helper: build a ReadableStreamDefaultReader from NDJSON lines
function mockNdjsonReader(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  let consumed = false;
  return {
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: encoder.encode(payload) };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function expectDoneEventContent(lines: string[], expectedContent: unknown) {
  await withMockNdjsonFetch(lines, async () => {
    const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
    const events = await collectStreamEvents(stream);

    const doneEvent = events.at(-1);
    if (!doneEvent || doneEvent.type !== "done") {
      throw new Error("Expected done event");
    }

    expect(doneEvent.message.content).toEqual(expectedContent);
  });
}

describe("parseNdjsonStream", () => {
  it("parses text-only streaming chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":" world"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0].message.content).toBe("Hello");
    expect(chunks[1].message.content).toBe(" world");
    expect(chunks[2].done).toBe(true);
  });

  it("parses tool_calls from intermediate chunk (not final)", async () => {
    // Ollama sends tool_calls in done:false chunk, final done:true has no tool_calls
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].done).toBe(false);
    expect(chunks[0].message.tool_calls).toHaveLength(1);
    expect(chunks[0].message.tool_calls![0].function.name).toBe("bash");
    expect(chunks[1].done).toBe(true);
    expect(chunks[1].message.tool_calls).toBeUndefined();
  });

  it("accumulates tool_calls across multiple intermediate chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"/tmp/a"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
    ]);

    // Simulate the accumulation logic from createOllamaStreamFn
    const accumulatedToolCalls: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }> = [];
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
      if (chunk.message?.tool_calls) {
        accumulatedToolCalls.push(...chunk.message.tool_calls);
      }
    }
    expect(accumulatedToolCalls).toHaveLength(2);
    expect(accumulatedToolCalls[0].function.name).toBe("read");
    expect(accumulatedToolCalls[1].function.name).toBe("bash");
    // Final done:true chunk has no tool_calls
    expect(chunks[2].message.tool_calls).toBeUndefined();
  });

  it("preserves unsafe integer tool arguments as exact strings", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"target":1234567890123456789,"nested":{"thread":9223372036854775807}}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { target?: unknown; nested?: { thread?: unknown } }
      | undefined;
    expect(args?.target).toBe("1234567890123456789");
    expect(args?.nested?.thread).toBe("9223372036854775807");
  });

  it("keeps safe integer tool arguments as numbers", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"retries":3,"delayMs":2500}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { retries?: unknown; delayMs?: unknown }
      | undefined;
    expect(args?.retries).toBe(3);
    expect(args?.delayMs).toBe(2500);
  });
});

async function withMockNdjsonFetch(
  lines: string[],
  run: (fetchMock: typeof fetchWithSsrFGuardMock) => Promise<void>,
): Promise<void> {
  fetchWithSsrFGuardMock.mockImplementation(async () => {
    const payload = lines.join("\n");
    return {
      response: new Response(`${payload}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
      release: vi.fn(async () => undefined),
    };
  });
  await run(fetchWithSsrFGuardMock);
}

function createControlledNdjsonFetch(): {
  fetchImpl: () => Promise<{ response: Response; release: () => Promise<void> }>;
  pushLine: (line: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    fetchImpl: async () => ({
      response: new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
      release: vi.fn(async () => undefined),
    }),
    pushLine(line: string) {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.enqueue(encoder.encode(`${line}\n`));
    },
    close() {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.close();
    },
  };
}

function getGuardedFetchCall(fetchMock: typeof fetchWithSsrFGuardMock): GuardedFetchCall {
  return (fetchMock.mock.calls[0]?.[0] as GuardedFetchCall | undefined) ?? { url: "" };
}

async function createOllamaTestStream(params: {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  options?: {
    apiKey?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  };
}) {
  const streamFn = createOllamaStreamFn(params.baseUrl, params.defaultHeaders);
  return streamFn(
    {
      id: "qwen3:32b",
      api: "ollama",
      provider: "custom-ollama",
      contextWindow: 131072,
    } as unknown as Parameters<typeof streamFn>[0],
    {
      messages: [{ role: "user", content: "hello" }],
    } as unknown as Parameters<typeof streamFn>[1],
    (params.options ?? {}) as unknown as Parameters<typeof streamFn>[2],
  );
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function nextEventWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 100,
): Promise<IteratorResult<T> | "timeout"> {
  return await Promise.race([
    iterator.next(),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
}

describe("createOllamaStreamFn streaming events", () => {
  it("emits start, text_start, text_delta, text_end, done for text responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" world"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual([
          "start",
          "text_start",
          "text_delta",
          "text_delta",
          "text_end",
          "done",
        ]);

        // text_delta events carry incremental deltas
        const deltas = events.filter((e) => e.type === "text_delta");
        expect(deltas[0]).toMatchObject({ contentIndex: 0, delta: "Hello" });
        expect(deltas[1]).toMatchObject({ contentIndex: 0, delta: " world" });

        // text_end carries the full accumulated content
        const textEnd = events.find((e) => e.type === "text_end");
        expect(textEnd).toMatchObject({ contentIndex: 0, content: "Hello world" });

        // start/text_start carry empty partials (before any content accumulates)
        const startEvent = events.find((e) => e.type === "start");
        expect(startEvent?.partial.content).toEqual([]);
        const textStartEvent = events.find((e) => e.type === "text_start");
        expect(textStartEvent?.partial.content).toEqual([]);

        // text_delta partials accumulate content progressively
        expect(deltas[0].partial.content).toEqual([{ type: "text", text: "Hello" }]);
        expect(deltas[1].partial.content).toEqual([{ type: "text", text: "Hello world" }]);

        // done event contains the final message
        const doneEvent = events.at(-1);
        expect(doneEvent?.type).toBe("done");
        if (doneEvent?.type === "done") {
          expect(doneEvent.message.content).toEqual([{ type: "text", text: "Hello world" }]);
        }
      },
    );
  });

  it("emits only done for tool-call-only responses (no text content)", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        // No text content means no start/text_start/text_delta/text_end events
        const types = events.map((e) => e.type);
        expect(types).toEqual(["done"]);
        const doneEvent = events[0];
        if (doneEvent.type === "done") {
          expect(doneEvent.reason).toBe("toolUse");
        }
      },
    );
  });

  it("emits text streaming events before done for mixed text + tool responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Let me check."},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
        const doneEvent = events.at(-1);
        if (doneEvent?.type === "done") {
          expect(doneEvent.reason).toBe("toolUse");
        }
      },
    );
  });

  it("emits text_end as soon as Ollama switches from text to tool calls", async () => {
    const controlledFetch = createControlledNdjsonFetch();
    fetchWithSsrFGuardMock.mockImplementation(controlledFetch.fetchImpl);

    try {
      const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
      const iterator = stream[Symbol.asyncIterator]();

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Let me check."},"done":false}',
      );

      const startEvent = await nextEventWithin(iterator);
      const textStartEvent = await nextEventWithin(iterator);
      const textDeltaEvent = await nextEventWithin(iterator);

      expect(startEvent).not.toBe("timeout");
      expect(textStartEvent).not.toBe("timeout");
      expect(textDeltaEvent).not.toBe("timeout");
      expect(startEvent).toMatchObject({ value: { type: "start" }, done: false });
      expect(textStartEvent).toMatchObject({ value: { type: "text_start" }, done: false });
      expect(textDeltaEvent).toMatchObject({
        value: { type: "text_delta", delta: "Let me check." },
        done: false,
      });

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      );

      const textEndEvent = await nextEventWithin(iterator);
      expect(textEndEvent).not.toBe("timeout");
      expect(textEndEvent).toMatchObject({
        value: {
          type: "text_end",
          contentIndex: 0,
          content: "Let me check.",
          partial: {
            content: [{ type: "text", text: "Let me check." }],
          },
        },
        done: false,
      });

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      );
      controlledFetch.close();

      const doneEvent = await nextEventWithin(iterator);
      expect(doneEvent).not.toBe("timeout");
      if (doneEvent !== "timeout" && doneEvent.done === false) {
        expect(doneEvent).toMatchObject({
          value: { type: "done", reason: "toolUse" },
          done: false,
        });

        const streamEnd = await nextEventWithin(iterator);
        expect(streamEnd).not.toBe("timeout");
        expect(streamEnd).toMatchObject({ value: undefined, done: true });
      } else {
        expect(doneEvent).toMatchObject({ value: undefined, done: true });
      }
    } finally {
      fetchWithSsrFGuardMock.mockReset();
    }
  });

  it("emits error without text_end when stream fails mid-response", async () => {
    // Simulate a stream that sends one content chunk then ends without done:true.
    // The stream function throws "Ollama API stream ended without a final response".
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"partial"},"done":false}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        // Should have streaming events for the partial content, then error (no text_end).
        expect(types).toEqual(["start", "text_start", "text_delta", "error"]);
        const errorEvent = events.at(-1);
        expect(errorEvent?.type).toBe("error");
      },
    );
  });

  it("emits a single text_delta for single-chunk responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"one shot"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);

        const delta = events.find((e) => e.type === "text_delta");
        expect(delta).toMatchObject({ delta: "one shot" });
      },
    );
  });
});

describe("createOllamaStreamFn", () => {
  it("normalizes /v1 baseUrl and maps maxTokens + signal", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const signal = new AbortController().signal;
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434/v1/",
          options: { maxTokens: 123, signal },
        });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const request = getGuardedFetchCall(fetchMock);
        expect(request.url).toBe("http://ollama-host:11434/api/chat");
        expect(request.auditContext).toBe("ollama-stream.chat");
        const requestInit = request.init ?? {};
        expect(requestInit.signal).toBe(signal);
        if (typeof requestInit.body !== "string") {
          throw new Error("Expected string request body");
        }

        const requestBody = JSON.parse(requestInit.body) as {
          options: { num_ctx?: number; num_predict?: number };
        };
        expect(requestBody.options.num_ctx).toBe(131072);
        expect(requestBody.options.num_predict).toBe(123);
      },
    );
  });

  it("uses the default loopback policy when baseUrl is empty", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({ baseUrl: "" });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        const request = getGuardedFetchCall(fetchMock);
        expect(request.url).toBe("http://127.0.0.1:11434/api/chat");
        expect(request.policy).toMatchObject({
          hostnameAllowlist: ["127.0.0.1"],
          allowPrivateNetwork: true,
        });
      },
    );
  });

  it("merges default headers and allows request headers to override them", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            "X-OLLAMA-KEY": "provider-secret",
            "X-Trace": "default",
          },
          options: {
            headers: {
              "X-Trace": "request",
              "X-Request-Only": "1",
            },
          },
        });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        const requestInit = getGuardedFetchCall(fetchMock).init ?? {};
        expect(requestInit.headers).toMatchObject({
          "Content-Type": "application/json",
          "X-OLLAMA-KEY": "provider-secret",
          "X-Trace": "request",
          "X-Request-Only": "1",
        });
      },
    );
  });

  it("preserves an explicit Authorization header when apiKey is a local marker", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            Authorization: "Bearer proxy-token",
          },
          options: {
            apiKey: "ollama-local", // pragma: allowlist secret
            headers: {
              Authorization: "Bearer proxy-token",
            },
          },
        });

        await collectStreamEvents(stream);
        const requestInit = getGuardedFetchCall(fetchMock).init ?? {};
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });

  it("allows a real apiKey to override an explicit Authorization header", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createOllamaStreamFn("http://ollama-host:11434", {
          Authorization: "Bearer proxy-token",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              id: "qwen3:32b",
              api: "ollama",
              provider: "custom-ollama",
              contextWindow: 131072,
            } as never,
            {
              messages: [{ role: "user", content: "hello" }],
            } as never,
            {
              apiKey: "real-token", // pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const requestInit = getGuardedFetchCall(fetchMock).init ?? {};
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer real-token",
        });
      },
    );
  });

  it("surfaces non-2xx HTTP response as status-prefixed error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
      release: vi.fn(async () => undefined),
    });
    try {
      const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
      const events = await collectStreamEvents(stream);

      const errorEvent = events.find((e) => e.type === "error") as
        | { type: "error"; error: { errorMessage?: string } }
        | undefined;
      expect(errorEvent).toBeDefined();
      // The error message must start with the HTTP status code so that
      // extractLeadingHttpStatus can parse it for failover/retry logic.
      expect(errorEvent!.error.errorMessage).toMatch(/^503\b/);
    } finally {
      fetchWithSsrFGuardMock.mockReset();
    }
  });

  it("keeps thinking chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ type: "thinking", thinking: "reasoned output" }],
    );
  });

  it("keeps streamed content after earlier thinking chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "final answer" },
      ],
    );
  });

  it("keeps reasoning chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ type: "thinking", thinking: "reasoned output" }],
    );
  });

  it("keeps streamed content after earlier reasoning chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "final answer" },
      ],
    );
  });
});

describe("resolveOllamaBaseUrlForRun", () => {
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

describe("createConfiguredOllamaStreamFn", () => {
  it("uses provider-level baseUrl when model baseUrl is absent", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createConfiguredOllamaStreamFn({
          model: {
            headers: { Authorization: "Bearer proxy-token" },
          },
          providerBaseUrl: "http://provider-host:11434/v1",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              id: "qwen3:32b",
              api: "ollama",
              provider: "custom-ollama",
              contextWindow: 131072,
            } as never,
            {
              messages: [{ role: "user", content: "hello" }],
            } as never,
            {
              apiKey: "ollama-local", // pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const request = getGuardedFetchCall(fetchMock);
        expect(request.url).toBe("http://provider-host:11434/api/chat");
        const requestInit = request.init ?? {};
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });
});
