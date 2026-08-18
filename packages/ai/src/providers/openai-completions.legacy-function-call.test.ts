import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEvent, Context, Model } from "../types.js";
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
const TOOL_ARGUMENT_BYTE_LIMIT = 256_000;

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

type ToolCallFixture = {
  index?: number;
  id?: string;
  name?: string;
  arguments: string;
};

function toolCallDelta({
  index = 0,
  id,
  name,
  arguments: rawArguments,
}: ToolCallFixture): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    index,
    ...(id !== undefined ? { id, type: "function" as const } : {}),
    function: {
      ...(name !== undefined ? { name } : {}),
      arguments: rawArguments,
    },
  };
}

function idOnlyToolCallDelta(params: {
  id: string;
  name?: string;
  arguments: string;
}): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    id: params.id,
    type: "function",
    function: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      arguments: params.arguments,
    },
  } as ChatCompletionChunk.Choice.Delta.ToolCall;
}

function argumentsWithByteLength(bytes: number, fill = "a"): string {
  const prefix = '{"query":"';
  const suffix = '"}';
  const availableBytes = bytes - Buffer.byteLength(prefix + suffix, "utf8");
  const characterBytes = Buffer.byteLength(fill, "utf8");
  const value =
    prefix +
    fill.repeat(Math.floor(availableBytes / characterBytes)) +
    "a".repeat(availableBytes % characterBytes) +
    suffix;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  return value;
}

function splitSurrogateArguments(bytes: number): [string, string] {
  const prefix = '{"query":"';
  const suffix = '"}';
  const emoji = "😀";
  const padding = bytes - Buffer.byteLength(prefix + suffix + emoji, "utf8");
  const value = `${prefix}${"a".repeat(padding)}${emoji}${suffix}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  const surrogateBoundary = value.indexOf(emoji) + 1;
  return [value.slice(0, surrogateBoundary), value.slice(surrogateBoundary)];
}

const modernCallChunk = (
  rawArguments: string,
  { id = "call_modern", index = 0, name = "lookup" } = {},
): ChatCompletionChunk =>
  chunk({ tool_calls: [toolCallDelta({ id, index, name, arguments: rawArguments })] });

const confirmedModernCallChunks = (
  rawArguments: string,
  options?: Parameters<typeof modernCallChunk>[1],
): ChatCompletionChunk[] => [modernCallChunk(rawArguments, options), chunk({}, "tool_calls")];

function confirmedLegacyCallChunks(rawArguments: string, name = "lookup"): ChatCompletionChunk[] {
  return [chunk({ function_call: { name, arguments: rawArguments } }), chunk({}, "function_call")];
}

function installStream(chunks: ChatCompletionChunk[]): void {
  const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => (previousHost = getAiTransportHost()));

afterEach(() => configureAiTransportHost(previousHost));

const createManagedStream = createOpenAICompletionsTransportStreamFn();
type FixtureOptions = { apiKey: string; reasoningEffort?: "medium"; signal?: AbortSignal };

const FIXTURE_OPTIONS = { apiKey: "fixture-token" } satisfies FixtureOptions;

function createManagedFixtureStream(
  fixtureModel: Model<"openai-completions">,
  fixtureContext: Context,
  fixtureOptions?: FixtureOptions,
) {
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
  const startFixture = (
    chunks: ChatCompletionChunk[],
    options: FixtureOptions = FIXTURE_OPTIONS,
    fixtureModel: Model<"openai-completions"> = model,
  ) => {
    installStream(chunks);
    return createStream(fixtureModel, context, options);
  };
  const fixtureResult = (...args: Parameters<typeof startFixture>) =>
    startFixture(...args).result();
  const collectFixture = async (...args: Parameters<typeof startFixture>) => {
    const stream = startFixture(...args);
    const events: Array<{ type: AssistantMessageEvent["type"]; toolCallId?: string }> = [];
    const starts: Array<{ id: string; name: string }> = [];
    const argumentDeltas: string[] = [];
    for await (const event of stream) {
      events.push({
        type: event.type,
        ...(event.type === "toolcall_end" ? { toolCallId: event.toolCall.id } : {}),
      });
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        if (block?.type === "toolCall") {
          starts.push({ id: block.id, name: block.name });
        }
      } else if (event.type === "toolcall_delta" && event.delta) {
        argumentDeltas.push(event.delta);
      }
    }
    return {
      events,
      eventTypes: events.map((event) => event.type),
      starts,
      argumentDeltas,
      result: await stream.result(),
    };
  };
  it("preserves legacy function_call deltas and reassembles split arguments", async () => {
    const { eventTypes, result } = await collectFixture([
      chunk({ role: "assistant", function_call: { name: "lookup" } }),
      chunk({ function_call: { arguments: '{"query":"ca' } }),
      chunk({ function_call: { arguments: 'ts"}' } }),
      chunk({}, "function_call"),
    ]);

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
    const { eventTypes, result } = await collectFixture([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ content: "Trailing commentary." }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "text"]);
    expect(result.content[1]).toMatchObject({ text: "Trailing commentary." });
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("text_start"));
  });

  it("keeps content preceding a legacy call in the same provider delta", async () => {
    const result = await fixtureResult([
      chunk({
        content: "Commentary before the call.",
        function_call: { name: "lookup", arguments: '{"query":"cats"}' },
      }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
    expect(result.content[0]).toMatchObject({ text: "Commentary before the call." });
  });

  it("preserves a confirmed legacy call before later streamed reasoning", async () => {
    const { eventTypes, result } = await collectFixture(
      [
        chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
        chunk({
          reasoning_content: "Reasoning after the call.",
        } as ChatCompletionChunk.Choice.Delta),
        chunk({}, "function_call"),
      ],
      { ...FIXTURE_OPTIONS, reasoningEffort: "medium" },
      { ...model, reasoning: true },
    );

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "thinking"]);
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("thinking_start"));
  });

  it("replays buffered visible text before a superseding modern call", async () => {
    const { starts, result } = await collectFixture([
      chunk({ function_call: { name: "legacy", arguments: '{"query":"wrong"}' } }),
      chunk({ content: "Visible before the modern call." }),
      modernCallChunk('{"query":"cats"}'),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
    expect(result.content[0]).toMatchObject({ text: "Visible before the modern call." });
    expect(starts.map(({ id }) => id)).toEqual(["call_modern"]);
  });

  it("releases buffered visible text when a legacy call is not confirmed", async () => {
    const result = await fixtureResult([
      chunk({ function_call: { name: "legacy", arguments: '{"query":"discard"}' } }),
      chunk({ content: "The provider supplied an answer instead." }),
      chunk({}, "stop"),
    ]);

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "The provider supplied an answer instead." },
    ]);
  });

  it.each<[string, ChatCompletionChunk[]]>([
    [
      "keeps modern tool_calls authoritative when legacy data is also present",
      [
        chunk({
          function_call: { name: "legacy", arguments: '{"query":"wrong"}' },
          tool_calls: [
            toolCallDelta({ id: "call_modern", name: "lookup", arguments: '{"query":"ca' }),
          ],
        }),
        chunk({ function_call: { arguments: "ignore this legacy continuation" } }),
        chunk({ tool_calls: [toolCallDelta({ arguments: 'ts"}' })] }),
        chunk({}, "tool_calls"),
      ],
    ],
    [
      "replaces an earlier legacy function_call when modern tool_calls arrive later",
      [
        chunk({ function_call: { name: "legacy", arguments: '{"query":"wrong"}' } }),
        chunk({
          tool_calls: [
            toolCallDelta({
              index: 1,
              id: "call_modern",
              name: "lookup",
              arguments: '{"query":"ca',
            }),
          ],
        }),
        chunk({ tool_calls: [toolCallDelta({ index: 1, arguments: 'ts"}' })] }),
        chunk({}, "tool_calls"),
      ],
    ],
  ])("%s", async (_title, chunks) => {
    const { starts, argumentDeltas, result } = await collectFixture(chunks);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_modern",
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(starts).toEqual([{ id: "call_modern", name: "lookup" }]);
    expect(argumentDeltas).toEqual(['{"query":"ca', 'ts"}']);
  });

  it("keeps ordinary text and stop finish reasons outside the tool-call lane", async () => {
    const result = await fixtureResult([
      chunk({ role: "assistant", content: "No tool needed." }),
      chunk({}, "stop"),
    ]);

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
      const { eventTypes, result } = await collectFixture([
        ...(visibleText ? [chunk({ content: "Visible final answer." })] : []),
        modernCallChunk('{"query":"discard"}', { id: "call_unconfirmed" }),
        chunk({}, finishReason),
      ]);
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
      const { eventTypes, result } = await collectFixture(
        confirmedModernCallChunks(rawArguments, { id: "call_malformed", name }),
      );
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
    const { eventTypes, result } = await collectFixture(confirmedLegacyCallChunks(value.arguments));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("incomplete or malformed tool call");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("rejects every parallel call when a sibling has incomplete arguments", async () => {
    const { eventTypes, result } = await collectFixture([
      chunk({
        tool_calls: [
          toolCallDelta({ id: "call_valid", name: "lookup", arguments: '{"query":"cats"}' }),
          toolCallDelta({
            index: 1,
            id: "call_invalid",
            name: "lookup",
            arguments: '{"query":"dogs"',
          }),
        ],
      }),
      chunk({}, "tool_calls"),
    ]);
    expect(result.stopReason).toBe("error");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("removes provisional calls when the response is aborted mid-stream", async () => {
    const abort = new AbortController();
    const stream = startFixture(
      confirmedModernCallChunks('{"query":"cats"}', { id: "call_aborted" }),
      { ...FIXTURE_OPTIONS, signal: abort.signal },
    );
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
    const collected = await collectFixture(
      confirmedModernCallChunks('{"query":"cats"}', { id: "call_confirmed" }),
    );
    const { events, result } = collected;
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
    const { eventTypes, result } = await collectFixture([
      modernCallChunk('{"query":"cats"}', { id: "call_before_text" }),
      chunk({ content: "Trailing commentary." }),
      chunk({}, "tool_calls"),
    ]);
    expect(result.stopReason).toBe("toolUse");
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
      const { eventTypes, result } = await collectFixture([
        chunk({ function_call: { name: "lookup", arguments: '{"query":"discard"}' } }),
        chunk({}, finishReason),
      ]);

      expect(result.stopReason).toBe(stopReason);
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_start");
      expect(eventTypes).not.toContain("toolcall_delta");
    },
  );

  it.each<[string, string, string]>([
    [
      "rejects oversized legacy arguments without publishing a provisional tool call",
      "x".repeat(256_001),
      "lookup",
    ],
    [
      "rejects an oversized legacy function name before publishing a provisional call",
      "{}",
      "x".repeat(256_001),
    ],
  ])("%s", async (_title, rawArguments, name) => {
    const { eventTypes, result } = await collectFixture(
      confirmedLegacyCallChunks(rawArguments, name),
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
  });

  it("bounds an indexed modern call through an id-only continuation", async () => {
    const value = argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT + 1);
    const { eventTypes, result } = await collectFixture([
      chunk({
        tool_calls: [
          toolCallDelta({
            index: 0,
            id: "call_alias",
            name: "lookup",
            arguments: value.slice(0, 128_000),
          }),
        ],
      }),
      chunk({
        tool_calls: [idOnlyToolCallDelta({ id: "call_alias", arguments: value.slice(128_000) })],
      }),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("keeps independent id-only modern calls independently bounded", async () => {
    const { result } = await collectFixture([
      chunk({
        tool_calls: [
          idOnlyToolCallDelta({
            id: "call_id_a",
            name: "lookup",
            arguments: argumentsWithByteLength(200_000),
          }),
          idOnlyToolCallDelta({
            id: "call_id_b",
            name: "lookup",
            arguments: argumentsWithByteLength(200_000),
          }),
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(
      result.content
        .filter((block) => block.type === "toolCall")
        .map((block) => [block.id, Buffer.byteLength(JSON.stringify(block.arguments), "utf8")]),
    ).toEqual([
      ["call_id_a", 200_000],
      ["call_id_b", 200_000],
    ]);
  });

  it.each([
    {
      name: "accepts an exact-limit surrogate pair split between deltas",
      bytes: TOOL_ARGUMENT_BYTE_LIMIT,
      stopReason: "toolUse",
    },
    {
      name: "rejects an oversized surrogate pair split between deltas",
      bytes: TOOL_ARGUMENT_BYTE_LIMIT + 1,
      stopReason: "error",
    },
  ] as const)("$name", async ({ bytes, stopReason }) => {
    const [first, second] = splitSurrogateArguments(bytes);
    const { eventTypes, result } = await collectFixture([
      chunk({
        tool_calls: [
          toolCallDelta({
            index: 0,
            id: "call_surrogate",
            name: "lookup",
            arguments: first,
          }),
        ],
      }),
      chunk({ tool_calls: [toolCallDelta({ index: 0, arguments: second })] }),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe(stopReason);
    if (stopReason === "error") {
      expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
      return;
    }
    expect(result.content[0]).toMatchObject({ id: "call_surrogate", type: "toolCall" });
    expect(
      result.content[0]?.type === "toolCall"
        ? Buffer.byteLength(JSON.stringify(result.content[0].arguments), "utf8")
        : undefined,
    ).toBe(bytes);
  });

  it("measures multibyte modern arguments by UTF-8 bytes", async () => {
    const { eventTypes, result } = await collectFixture(
      confirmedModernCallChunks(argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT + 1, "é"), {
        id: "call_multibyte",
      }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("coalesces tiny provisional legacy fragments into one bounded executable delta", async () => {
    const query = "x".repeat(1_100);
    const { argumentDeltas, result } = await collectFixture([
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

    expect(result.stopReason).toBe("toolUse");
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      name: "lookup",
      arguments: { query },
    });
    expect(argumentDeltas).toEqual([JSON.stringify({ query })]);
  });

  it("bounds visible content buffered behind a provisional legacy call", async () => {
    const { eventTypes, result } = await collectFixture([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ content: "x".repeat(256_001) }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded legacy tool-call content buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes).not.toContain("text_start");
  });

  it("bounds the number of tiny deltas buffered behind a provisional legacy call", async () => {
    const result = await fixtureResult([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      ...Array.from({ length: 1_025 }, () => chunk({ content: "x" })),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded legacy tool-call content buffer limit");
    expect(result.content).toEqual([]);
  });

  it("generates a distinct legacy call id for each assistant response", async () => {
    const chunks = confirmedLegacyCallChunks('{"query":"cats"}');
    const first = await fixtureResult(chunks);
    const second = await fixtureResult(chunks);

    expect(first.content[0]).toMatchObject({ type: "toolCall" });
    expect(second.content[0]).toMatchObject({ type: "toolCall" });
    if (first.content[0]?.type === "toolCall" && second.content[0]?.type === "toolCall") {
      expect(first.content[0].id).not.toBe(second.content[0].id);
    }
  });
});
