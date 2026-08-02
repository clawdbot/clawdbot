// Coverage for repairing malformed streamed tool-call arguments.
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { parseStreamingJson } from "@openclaw/ai/internal/runtime";
import {
  createAnthropicMessagesTransportStreamFn,
  parseJsonObjectPreservingUnsafeIntegers,
} from "@openclaw/ai/transports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

type FakeStreamFn = (
  model: never,
  context: never,
  options: never,
) => FakeWrappedStream | Promise<FakeWrappedStream>;

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  // Minimal fake stream lets repair tests assert both streamed events and final
  // result mutation.
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

async function invokeProviderStream(params: {
  provider: string;
  modelApi: string;
  baseFn: FakeStreamFn;
  model?: unknown;
  context?: unknown;
  options?: unknown;
}): Promise<FakeWrappedStream> {
  // Repair is provider/API gated; this helper mirrors the production wrapper
  // selection before invoking the fake stream.
  const streamFn = shouldRepairMalformedToolCallArguments({
    provider: params.provider,
    modelApi: params.modelApi,
  })
    ? (wrapStreamFnRepairMalformedToolCallArguments(params.baseFn as never) as FakeStreamFn)
    : params.baseFn;
  return await Promise.resolve(
    streamFn(
      (params.model ?? {}) as never,
      (params.context ?? {}) as never,
      (params.options ?? {}) as never,
    ),
  );
}

type ToolCallRepairCaseResult = {
  partialArgs: unknown;
  streamedArgs: unknown;
  endMessageArgs: unknown;
  finalArgs: unknown;
  result: unknown;
  finalMessage: unknown;
};

async function runToolCallRepairCase(params: {
  toolName?: string;
  delta: string;
  provider?: string;
  modelApi?: string;
  includePreamble?: boolean;
  preambleToolName?: string;
}): Promise<ToolCallRepairCaseResult> {
  // One case tracks every representation of the tool call so repairs stay
  // synchronized across partial, end, and final messages.
  const toolName = params.toolName ?? "write";
  const partialToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const streamedToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const endMessageToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const finalToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const partialMessage = { role: "assistant", content: [partialToolCall] };
  const endMessage = { role: "assistant", content: [endMessageToolCall] };
  const finalMessage = { role: "assistant", content: [finalToolCall] };

  const stream = await invokeProviderStream({
    provider: params.provider ?? "openai-compatible",
    modelApi: params.modelApi ?? "openai-completions",
    baseFn: () =>
      createFakeStream({
        events: [
          ...(params.includePreamble === false
            ? []
            : [
                {
                  type: "toolcall_delta",
                  contentIndex: 0,
                  delta: `.functions.${params.preambleToolName ?? toolName}:0 `,
                  partial: partialMessage,
                },
              ]),
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: params.delta,
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
  });

  for await (const ignoredItem of stream) {
    void ignoredItem;
    // drain
  }
  const result = await stream.result();

  return {
    partialArgs: partialToolCall.arguments,
    streamedArgs: streamedToolCall.arguments,
    endMessageArgs: endMessageToolCall.arguments,
    finalArgs: finalToolCall.arguments,
    result,
    finalMessage,
  };
}

function expectAllToolCallArgs(
  result: ToolCallRepairCaseResult,
  expectedArgs: Record<string, unknown>,
): void {
  expect(result.partialArgs).toEqual(expectedArgs);
  expect(result.streamedArgs).toEqual(expectedArgs);
  expect(result.endMessageArgs).toEqual(expectedArgs);
  expect(result.finalArgs).toEqual(expectedArgs);
  expect(result.result).toBe(result.finalMessage);
}

describe("shouldRepairMalformedToolCallArguments", () => {
  it("keeps the repair enabled for kimi providers on anthropic-messages", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
  });

  it("does not apply kimi repair across provider id variants", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "anthropic-messages",
      }),
    ).toBe(false);
  });

  it("enables the repair for openai-completions even when the provider is not kimi", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-completions",
      }),
    ).toBe(true);
  });

  it("does not enable the repair for unrelated non-kimi transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("keeps kimi providers off on non-anthropic non-openai-completions transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("does not enable the repair for direct OpenAI responses", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("enables the repair for Codex and Azure Responses transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
      }),
    ).toBe(true);
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "azure-openai-responses",
        modelApi: "azure-openai-responses",
      }),
    ).toBe(true);
  });
});

describe("openai-completions malformed tool-call argument repair", () => {
  it("restores split replacement tokens after argument repair", async () => {
    const partialToolCall = { type: "toolCall", name: "send", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "send", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "send", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"text":"[MAS',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: 'KED]"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: finalMessage,
      });
    const repairedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    const transformedFn = wrapStreamFnTextTransforms({
      streamFn: repairedFn,
      output: [{ from: /\[MASKED\]/g, to: "John Smith" }],
    }) as FakeStreamFn;
    const stream = await Promise.resolve(transformedFn({} as never, {} as never, {} as never));
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => (event as { type?: string }).type === "toolcall_delta")
        .map((event) => (event as { delta?: string }).delta),
    ).toEqual(['{"text":"[MAS', 'KED]"}']);
    const endEvent = events.find(
      (event) => (event as { type?: string }).type === "toolcall_end",
    ) as { toolCall?: { arguments?: unknown } } | undefined;
    expect(endEvent?.toolCall?.arguments).toEqual({ text: "John Smith" });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ arguments: { text: "John Smith" } }],
    });
  });

  it.each([
    ["openai-completions", "sglang"],
    ["openai-chatgpt-responses", "openai"],
    ["azure-openai-responses", "azure-openai-responses"],
  ])(
    "repairs fragmented %s function-call args before tool execution",
    async (modelApi, provider) => {
      const partialToolCall = { type: "functionCall", name: "read", arguments: {} };
      const streamedToolCall = { type: "functionCall", name: "read", arguments: {} };
      const endMessageToolCall = { type: "functionCall", name: "read", arguments: {} };
      const finalToolCall = { type: "functionCall", name: "read", arguments: {} };
      const partialMessage = { role: "assistant", content: [partialToolCall] };
      const endMessage = { role: "assistant", content: [endMessageToolCall] };
      const finalMessage = { role: "assistant", content: [finalToolCall] };

      const stream = await invokeProviderStream({
        provider,
        modelApi,
        baseFn: () =>
          createFakeStream({
            events: [
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: ".functions.read:0 ",
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: '{"path":"/tmp/report.txt"',
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: "}x",
                partial: partialMessage,
              },
              {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: streamedToolCall,
                partial: partialMessage,
                message: endMessage,
              },
            ],
            resultMessage: finalMessage,
          }),
      });

      for await (const ignoredItem of stream) {
        void ignoredItem;
        // drain
      }
      const result = await stream.result();

      expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(result).toBe(finalMessage);
    },
  );

  it("repairs smart-quoted edit args with CJK, markdown, and inner smart quotes", async () => {
    const expectedContent =
      '更新 **草稿** with “smart”, “sure” and code "x"\nJSON-ish “alpha”, “path”: “ignored” snippet\nSee [“quoted”](https://example.test)\nconst re = /\\d+/;\n内部内容';
    const result = await runToolCallRepairCase({
      toolName: "edit",
      delta: String.raw` {“path”:“notes/报告.md”,“oldText”:“旧的 **草稿**”,“newText”:“更新 **草稿** with “smart”, “sure” and code "x"
JSON-ish “alpha”, “path”: “ignored” snippet
See [“quoted”](https://example.test)
const re = /\d+/;
内部内容”}`,
    });

    expectAllToolCallArgs(result, {
      path: "notes/报告.md",
      oldText: "旧的 **草稿**",
      newText: expectedContent,
    });
  });

  it("repairs smart-quoted edit args that use the current edits array schema", async () => {
    const result = await runToolCallRepairCase({
      toolName: "edit",
      delta: String.raw` {“path”:“notes/报告.md”,“edits”:[{“oldText”:“旧的 **草稿**”,“newText”:“更新 \"草稿\"\nnext”},{“oldText”:“tail”,“newText”:“done”}]}`,
    });

    expectAllToolCallArgs(result, {
      path: "notes/报告.md",
      edits: [
        { oldText: "旧的 **草稿**", newText: '更新 "草稿"\nnext' },
        { oldText: "tail", newText: "done" },
      ],
    });
  });

  it("preserves smart quotes inside ASCII-delimited JSON content with trailing junk", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: '{"path":"notes/日志.md","content":"包含“内部”与 **重点** 字样"}x',
    });

    expectAllToolCallArgs(result, {
      path: "notes/日志.md",
      content: "包含“内部”与 **重点** 字样",
    });
  });

  it("repairs smart-quoted command args that use workdir", async () => {
    const result = await runToolCallRepairCase({
      toolName: "exec",
      delta: "{“command“:“pwd“,“workdir“:“/tmp“}",
    });

    expectAllToolCallArgs(result, { command: "pwd", workdir: "/tmp" });
  });

  it("repairs an exact smart-quoted argument object without preamble or trailing junk", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”}",
    });

    expectAllToolCallArgs(result, { path: "safe.txt" });
  });

  it("repairs smart-quoted non-freeform args before schema-specific option keys", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("repairs prefixless smart-quoted read args before schema-specific option keys", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
      includePreamble: false,
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("repairs smart-quoted read args with a case-varied structured tool name", async () => {
    const result = await runToolCallRepairCase({
      toolName: "Read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
      includePreamble: false,
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("keeps unknown member-looking prose inside smart-quoted non-freeform args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      delta: String.raw` {“pattern”:“Use ”, “foo”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “foo”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });

  it("keeps known option-looking prose inside unrelated smart-quoted args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      delta: String.raw` {“pattern”:“Use ”, “limit”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “limit”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("limit");
  });

  it("uses the structured tool name over a mismatched smart-quote repair prefix", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      preambleToolName: "read",
      delta: String.raw` {“pattern”:“Use ”, “limit”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “limit”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("limit");
  });

  it("ignores inherited tool-name successor lookups while repairing smart-quoted args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "constructor",
      delta: "{“length”:“x”,“foo”:1}",
    });

    expectAllToolCallArgs(result, {});
  });

  it("decodes JSON escapes inside smart-quoted string args", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“line\nnext \"quoted\" path C:\\tmp mark \u2713 invalid \d”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: 'line\nnext "quoted" path C:\\tmp mark ✓ invalid \\d',
    });
  });

  it("keeps duplicate-looking smart-quoted args inside content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“text ”, “path”: “other.txt””}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "text ”, “path”: “other.txt”",
    });
  });

  it("keeps unknown member-looking prose inside smart-quoted content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“Use ”, “foo”: “bar” in prose”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "Use ”, “foo”: “bar” in prose",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });

  it("keeps member-looking prose inside mixed ASCII-key smart-quoted content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {"path":"safe.txt","content":“Use ”, “foo”: “bar” in prose”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "Use ”, “foo”: “bar” in prose",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });
});

// The anthropic-messages transport publishes parsed tool arguments on this growth
// cadence plus one whole-buffer parse at content_block_stop; it used to publish on
// every delta. Repair output has to land on the same arguments either way.
const ANTHROPIC_TOOL_ARGS_REPARSE_MIN_GROWTH_CHARS = 4096;
const KIMI_ANTHROPIC_MODEL = {
  id: "kimi-k2-thinking",
  name: "Kimi K2 Thinking",
  api: "anthropic-messages",
  provider: "kimi",
  baseUrl: "https://api.moonshot.test",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 8192,
};

function parseTransportToolCallArguments(partialJson: string): unknown {
  return parseJsonObjectPreservingUnsafeIntegers(partialJson) ?? parseStreamingJson(partialJson);
}

function chunkToolCallArguments(rawArguments: string, size: number): string[] {
  const deltas: string[] = [];
  for (let index = 0; index < rawArguments.length; index += size) {
    deltas.push(rawArguments.slice(index, index + size));
  }
  return deltas;
}

function createToolCallCadenceStream(params: {
  deltas: string[];
  coalesce: boolean;
}): FakeWrappedStream {
  const toolCall = { type: "toolCall", name: "write", arguments: {} as unknown };
  const message = { role: "assistant", content: [toolCall] };
  return {
    async result() {
      return message;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        let partialJson = "";
        let parsedLength = 0;
        for (const delta of params.deltas) {
          partialJson += delta;
          if (
            !params.coalesce ||
            partialJson.length - parsedLength >= ANTHROPIC_TOOL_ARGS_REPARSE_MIN_GROWTH_CHARS
          ) {
            toolCall.arguments = parseTransportToolCallArguments(partialJson);
            parsedLength = partialJson.length;
          }
          yield { type: "toolcall_delta", contentIndex: 0, delta, partial: message };
        }
        if (params.coalesce && partialJson) {
          toolCall.arguments = parseTransportToolCallArguments(partialJson);
        }
        yield { type: "toolcall_end", contentIndex: 0, toolCall, partial: message };
      })();
    },
  };
}

type StreamedToolCallArguments = {
  streamedArgs: unknown;
  messageArgs: unknown;
};

async function drainToolCallArguments(
  stream: FakeWrappedStream,
): Promise<StreamedToolCallArguments> {
  let streamedArgs: unknown;
  for await (const event of stream) {
    const typedEvent = event as { type?: string; toolCall?: { arguments?: unknown } };
    if (typedEvent.type === "toolcall_end") {
      streamedArgs = typedEvent.toolCall?.arguments;
    }
  }
  const message = (await stream.result()) as { content?: { arguments?: unknown }[] };
  return { streamedArgs, messageArgs: message.content?.[0]?.arguments };
}

async function runToolCallCadenceCase(params: {
  deltas: string[];
  coalesce: boolean;
}): Promise<StreamedToolCallArguments> {
  const stream = await invokeProviderStream({
    provider: "kimi",
    modelApi: "anthropic-messages",
    baseFn: () => createToolCallCadenceStream(params),
  });
  return await drainToolCallArguments(stream);
}

function createAnthropicToolCallSseResponse(deltas: string[]): Response {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_repair", usage: { input_tokens: 4, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_repair", name: "write", input: {} },
    },
    ...deltas.map((delta) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: delta },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function runKimiAnthropicTransportCase(params: {
  host: ReturnType<typeof getAiTransportHost>;
  deltas: string[];
}): Promise<StreamedToolCallArguments> {
  configureAiTransportHost({
    ...params.host,
    buildModelFetch: () => async () => createAnthropicToolCallSseResponse(params.deltas),
  });
  const stream = await invokeProviderStream({
    provider: "kimi",
    modelApi: "anthropic-messages",
    baseFn: createAnthropicMessagesTransportStreamFn() as unknown as FakeStreamFn,
    model: KIMI_ANTHROPIC_MODEL,
    context: { messages: [{ role: "user", content: "write the report" }], tools: [] },
    options: { apiKey: "test-key" },
  });
  return await drainToolCallArguments(stream);
}

const TOOL_CALL_CADENCE_CASES = [
  {
    name: "well-formed arguments",
    rawArguments: '{"path":"notes/report.md","content":"first draft body"}',
    deltaSize: 24,
    expectedArgs: { path: "notes/report.md", content: "first draft body" },
  },
  {
    name: "a repaired leading prefix",
    rawArguments: 'functions.write:0 {"path":"notes/report.md","content":"first draft"}',
    deltaSize: 21,
    expectedArgs: { path: "notes/report.md", content: "first draft" },
  },
  {
    name: "a repair invalidated by a later delta",
    rawArguments: '{"path":"a.txt"} then some trailing prose here',
    deltaSize: 16,
    expectedArgs: { path: "a.txt" },
  },
  {
    name: "arguments larger than the coalesce window",
    rawArguments: `{"path":"big.txt","content":"${"y".repeat(9000)}"}`,
    deltaSize: 32,
    expectedArgs: { path: "big.txt", content: "y".repeat(9000) },
  },
];

describe("kimi anthropic-messages tool-call repair across transport parse cadences", () => {
  let transportHost: ReturnType<typeof getAiTransportHost>;

  beforeAll(() => {
    transportHost = getAiTransportHost();
  });

  afterAll(() => {
    configureAiTransportHost(transportHost);
  });

  it.each(TOOL_CALL_CADENCE_CASES)(
    "repairs $name identically however the transport parses streamed arguments",
    async ({ rawArguments, deltaSize, expectedArgs }) => {
      const deltas = chunkToolCallArguments(rawArguments, deltaSize);
      const coalesced = await runToolCallCadenceCase({ deltas, coalesce: true });
      const perDelta = await runToolCallCadenceCase({ deltas, coalesce: false });
      const transported = await runKimiAnthropicTransportCase({ host: transportHost, deltas });

      expect(JSON.stringify(coalesced.streamedArgs)).toBe(JSON.stringify(perDelta.streamedArgs));
      expect(JSON.stringify(coalesced.messageArgs)).toBe(JSON.stringify(perDelta.messageArgs));
      expect(coalesced.streamedArgs).toEqual(expectedArgs);
      expect(transported.streamedArgs).toEqual(expectedArgs);
      expect(transported.messageArgs).toEqual(expectedArgs);
    },
  );
});
