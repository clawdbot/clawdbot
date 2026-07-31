import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const model = {
  id: "gpt-4",
  name: "GPT-4",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "Look up cats", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a query",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Context;

function chunk(
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-legacy-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: model.id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function installStream(chunks: ChatCompletionChunk[]): void {
  const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  configureAiTransportHost({ buildModelFetch: () => fetch });
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(
  fixtureModel: Model<"openai-completions">,
  fixtureContext: Context,
  fixtureOptions?: Parameters<typeof createManagedStream>[2],
): AssistantMessageEventStreamLike {
  const stream = createManagedStream(fixtureModel, fixtureContext, fixtureOptions);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat transport must return its event stream synchronously");
  }
  return stream;
}

describe.each([
  { name: "package", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name OpenAI Chat Completions stream", ({ createStream }) => {
  it("preserves legacy function_call deltas and reassembles split arguments", async () => {
    installStream([
      chunk({ role: "assistant", function_call: { name: "lookup" } }),
      chunk({ function_call: { arguments: '{"query":"ca' } }),
      chunk({ function_call: { arguments: 'ts"}' } }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(result.content[0]).not.toHaveProperty("partialArgs");
    expect(result.content[0]).not.toHaveProperty("streamIndex");
    expect(eventTypes).toContain("toolcall_start");
    expect(eventTypes).toContain("toolcall_delta");
  });

  it("preserves a confirmed legacy call before later visible text", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ content: "Trailing commentary." }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "text"]);
    expect(result.content[1]).toMatchObject({ text: "Trailing commentary." });
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("text_start"));
  });

  it("keeps content preceding a legacy call in the same provider delta", async () => {
    installStream([
      chunk({
        content: "Commentary before the call.",
        function_call: { name: "lookup", arguments: '{"query":"cats"}' },
      }),
      chunk({}, "function_call"),
    ]);

    const result = await createStream(model, context, { apiKey: "fixture-token" }).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
    expect(result.content[0]).toMatchObject({ text: "Commentary before the call." });
  });

  it("preserves a confirmed legacy call before later streamed reasoning", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ reasoning_content: "Reasoning after the call." } as ChatCompletionChunk.Choice.Delta),
      chunk({}, "function_call"),
    ]);

    const stream = createStream({ ...model, reasoning: true }, context, {
      apiKey: "fixture-token",
      reasoningEffort: "medium",
    });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "thinking"]);
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("thinking_start"));
  });

  it("replays buffered visible text before a superseding modern call", async () => {
    installStream([
      chunk({ function_call: { name: "legacy", arguments: '{"query":"wrong"}' } }),
      chunk({ content: "Visible before the modern call." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_modern",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const observedStarts: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === "toolCall") {
          observedStarts.push(block.id);
        }
      }
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
    expect(result.content[0]).toMatchObject({ text: "Visible before the modern call." });
    expect(observedStarts).toEqual(["call_modern"]);
  });

  it("releases buffered visible text when a legacy call is not confirmed", async () => {
    installStream([
      chunk({ function_call: { name: "legacy", arguments: '{"query":"discard"}' } }),
      chunk({ content: "The provider supplied an answer instead." }),
      chunk({}, "stop"),
    ]);

    const result = await createStream(model, context, { apiKey: "fixture-token" }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "The provider supplied an answer instead." },
    ]);
  });

  it("keeps modern tool_calls authoritative when legacy data is also present", async () => {
    installStream([
      chunk({
        function_call: { name: "legacy", arguments: '{"query":"wrong"}' },
        tool_calls: [
          {
            index: 0,
            id: "call_modern",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"ca' },
          },
        ],
      }),
      chunk({ function_call: { arguments: "ignore this legacy continuation" } }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ts"}' } }] }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const observedStarts: Array<{ id: string; name: string }> = [];
    const observedArgumentDeltas: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === "toolCall") {
          observedStarts.push({ id: block.id, name: block.name });
        }
      } else if (event.type === "toolcall_delta" && event.delta) {
        observedArgumentDeltas.push(event.delta);
      }
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_modern",
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(observedStarts).toEqual([{ id: "call_modern", name: "lookup" }]);
    expect(observedArgumentDeltas).toEqual(['{"query":"ca', 'ts"}']);
  });

  it("replaces an earlier legacy function_call when modern tool_calls arrive later", async () => {
    installStream([
      chunk({ function_call: { name: "legacy", arguments: '{"query":"wrong"}' } }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: "call_modern",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"ca' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: 'ts"}' } }] }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const observedStarts: Array<{ id: string; name: string }> = [];
    const observedArgumentDeltas: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === "toolCall") {
          observedStarts.push({ id: block.id, name: block.name });
        }
      } else if (event.type === "toolcall_delta" && event.delta) {
        observedArgumentDeltas.push(event.delta);
      }
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_modern",
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(observedStarts).toEqual([{ id: "call_modern", name: "lookup" }]);
    expect(observedArgumentDeltas).toEqual(['{"query":"ca', 'ts"}']);
  });

  it("keeps ordinary text and stop finish reasons outside the tool-call lane", async () => {
    installStream([chunk({ role: "assistant", content: "No tool needed." }), chunk({}, "stop")]);

    const result = await createStream(model, context, { apiKey: "fixture-token" }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "No tool needed." }]);
  });

  it.each([
    { finishReason: "length", visibleText: false, stopReason: "length" },
    { finishReason: "content_filter", visibleText: false, stopReason: "error" },
    { finishReason: "stop", visibleText: true, stopReason: "stop" },
  ] as const)(
    "does not publish completed modern calls discarded by a $finishReason terminal",
    async ({ finishReason, visibleText, stopReason }) => {
      installStream([
        ...(visibleText ? [chunk({ content: "Visible final answer." })] : []),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_unconfirmed",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"discard"}' },
            },
          ],
        }),
        chunk({}, finishReason),
      ]);

      const stream = createStream(model, context, { apiKey: "fixture-token" });
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      const result = await stream.result();
      expect(result.stopReason).toBe(stopReason);
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
    },
  );

  it.each([
    { reason: "incomplete JSON", name: "lookup", arguments: '{"query":"cats"' },
    { reason: "malformed JSON", name: "lookup", arguments: '{"query":}' },
    { reason: "invalid string escape", name: "lookup", arguments: String.raw`{"query":"cats\q"}` },
    { reason: "unescaped control character", name: "lookup", arguments: '{"query":"cats\n"}' },
    { reason: "non-object JSON", name: "lookup", arguments: '["cats"]' },
    { reason: "empty arguments", name: "lookup", arguments: "" },
    { reason: "missing function name", name: "", arguments: '{"query":"cats"}' },
  ] as const)(
    "rejects an authoritative modern tool terminal with $reason",
    async ({ name, arguments: rawArguments }) => {
      installStream([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_malformed",
              type: "function",
              function: { name, arguments: rawArguments },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ]);

      const stream = createStream(model, context, { apiKey: "fixture-token" });
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("incomplete or malformed tool call");
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
    },
  );

  it.each([
    { reason: "incomplete JSON", arguments: '{"query":"cats"' },
    { reason: "invalid string escape", arguments: String.raw`{"query":"cats\q"}` },
    { reason: "unescaped control character", arguments: '{"query":"cats\n"}' },
  ] as const)("rejects an authoritative legacy function terminal with $reason", async (value) => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: value.arguments } }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("incomplete or malformed tool call");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("rejects every parallel call when a sibling has incomplete arguments", async () => {
    installStream([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_valid",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
          {
            index: 1,
            id: "call_invalid",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"dogs"' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("removes provisional calls when the response is aborted mid-stream", async () => {
    installStream([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_aborted",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    const abort = new AbortController();
    const stream = createStream(model, context, { apiKey: "fixture-token", signal: abort.signal });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "toolcall_start") {
        abort.abort();
      }
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("retains an executable modern call after its confirmed tool terminal", async () => {
    installStream([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_confirmed",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const events: Array<{ type: string; toolCallId?: string }> = [];
    for await (const event of stream) {
      events.push({
        type: event.type,
        ...(event.type === "toolcall_end" ? { toolCallId: event.toolCall.id } : {}),
      });
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_confirmed",
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", toolCallId: "call_confirmed" },
    ]);
  });

  it("preserves confirmed tool completion before following text blocks close", async () => {
    installStream([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_before_text",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({ content: "Trailing commentary." }),
      chunk({}, "tool_calls"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect((await stream.result()).stopReason).toBe("toolUse");
    const toolEndIndex = eventTypes.indexOf("toolcall_end");
    expect(toolEndIndex).toBeGreaterThanOrEqual(0);
    expect(toolEndIndex).toBeLessThan(eventTypes.indexOf("done"));

    const followingTextEndIndex = eventTypes.indexOf("text_end");
    if (followingTextEndIndex >= 0) {
      expect(toolEndIndex).toBeLessThan(followingTextEndIndex);
    }
  });

  it.each([
    { finishReason: "stop", stopReason: "stop" },
    { finishReason: "length", stopReason: "length" },
    { finishReason: "content_filter", stopReason: "error" },
    { finishReason: "tool_calls", stopReason: "stop" },
  ] as const)(
    "discards provisional legacy fragments when the provider finishes with $finishReason",
    async ({ finishReason, stopReason }) => {
      installStream([
        chunk({ function_call: { name: "lookup", arguments: '{"query":"discard"}' } }),
        chunk({}, finishReason),
      ]);

      const stream = createStream(model, context, { apiKey: "fixture-token" });
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

      expect(result.stopReason).toBe(stopReason);
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_start");
      expect(eventTypes).not.toContain("toolcall_delta");
    },
  );

  it("rejects oversized legacy arguments without publishing a provisional tool call", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: "x".repeat(256_001) } }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
  });

  it("rejects an oversized legacy function name before publishing a provisional call", async () => {
    installStream([
      chunk({ function_call: { name: "x".repeat(256_001), arguments: "{}" } }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
  });

  it("coalesces tiny provisional legacy fragments into one bounded executable delta", async () => {
    const query = "x".repeat(1_100);
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"' } }),
      ...Array.from(query, (character) =>
        chunk({
          content: "",
          refusal: "",
          reasoning_details: [],
          function_call: { arguments: character },
        } as ChatCompletionChunk.Choice.Delta),
      ),
      chunk({ function_call: { arguments: '"}' } }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const argumentDeltas: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_delta" && event.delta) {
        argumentDeltas.push(event.delta);
      }
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      name: "lookup",
      arguments: { query },
    });
    expect(argumentDeltas).toEqual([JSON.stringify({ query })]);
  });

  it("bounds visible content buffered behind a provisional legacy call", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ content: "x".repeat(256_001) }),
      chunk({}, "function_call"),
    ]);

    const stream = createStream(model, context, { apiKey: "fixture-token" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded legacy tool-call content buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes).not.toContain("text_start");
  });

  it("bounds the number of tiny deltas buffered behind a provisional legacy call", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      ...Array.from({ length: 1_025 }, () => chunk({ content: "x" })),
      chunk({}, "function_call"),
    ]);

    const result = await createStream(model, context, { apiKey: "fixture-token" }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded legacy tool-call content buffer limit");
    expect(result.content).toEqual([]);
  });

  it("generates a distinct legacy call id for each assistant response", async () => {
    installStream([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({}, "function_call"),
    ]);

    const first = await createStream(model, context, { apiKey: "fixture-token" }).result();
    const second = await createStream(model, context, { apiKey: "fixture-token" }).result();

    expect(first.content[0]).toMatchObject({ type: "toolCall" });
    expect(second.content[0]).toMatchObject({ type: "toolCall" });
    if (first.content[0]?.type === "toolCall" && second.content[0]?.type === "toolCall") {
      expect(first.content[0].id).not.toBe(second.content[0].id);
    }
  });
});
