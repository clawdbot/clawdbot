import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
  it("promotes tool calls when stream completes cleanly without finish_reason", async () => {
    const model = makeCompletionsModel({
      id: "qwen3.6-27b",
      name: "Qwen 3.6 27B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 131072,
    });

    const output = createAssistantOutput(model);
    const stream = { push: () => {} };

    const mockChunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_cleanstream",
            function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, stream, {
      sawStreamDONE: () => true,
    });

    expect(output.stopReason).toBe("toolUse");
    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
  });

  it.each([
    {
      name: "does not promote native tool calls when stream ends without [DONE] and without finish_reason",
      chunks: [
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_nodone",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
            },
          ],
        }),
      ],
    },
    {
      name: "strips tool calls when stream has visible text and no finish_reason",
      chunks: [
        makeCompletionsChunk({ content: "Let me think about this." }),
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_with_text",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
            },
          ],
        }),
      ],
    },
  ])("$name", async ({ chunks }) => {
    const model = makeCompletionsModel({
      id: "qwen3.6-27b",
      name: "Qwen 3.6 27B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 131072,
    });

    const output = createAssistantOutput(model);
    const stream = { push: () => {} };

    await processCompletionsStream(streamChunks(chunks), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(
      output.content.filter((block) => (block as { type?: string }).type === "toolCall"),
    ).toStrictEqual([]);
  });

  it("strips tool call blocks when provider signals finish_reason stop after visible text", async () => {
    const model = makeCompletionsModel({
      id: "llama-3.3-70b",
      name: "Llama 3.3 70B",
      provider: "llamacpp",
      baseUrl: "http://localhost:8080/v1",
      reasoning: false,
      contextWindow: 131072,
    });

    const output = createAssistantOutput(model);
    const stream = { push: () => {} };

    const mockChunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Here is the answer." }),
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_spurious",
              function: { name: "bash", arguments: '{"cmd":"rm -rf /"}' },
            },
          ],
        },
        "stop",
      ),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(
      output.content.filter((block) => (block as { type?: string }).type === "toolCall"),
    ).toStrictEqual([]);
    expect(output.content.some((block) => (block as { type?: string }).type === "text")).toBe(true);
  });

  it("promotes native tool calls through fetch wrapper when SSE terminates cleanly with [DONE] without finish_reason", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        void body;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // Emit a delta.tool_calls chunk with no finish_reason
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_loopback_done",
                  function: { name: "bash", arguments: '{"cmd":"echo loopback"}' },
                },
              ],
            }),
          )}\n\n`,
        );
        // Split CRLF-formatted terminal proof across chunks. The SDK accepts this
        // framing, so the raw terminal observer must preserve the same contract.
        res.write("data: [DO");
        res.write("NE]\r\n\r\n");
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
      const baseModel = makeCompletionsModel({
        id: "qwen3.6-27b",
        name: "Qwen 3.6 27B",
        provider: "vllm",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        contextWindow: 131072,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Run a command", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      let hasToolCallEvent = false;
      const doneMessage: { content?: Array<{ type?: string }> } = {};
      for await (const event of stream as AsyncIterable<{
        type: string;
        reason?: string;
        message?: { content?: Array<{ type?: string }> };
      }>) {
        if (event.type === "toolcall_start") {
          hasToolCallEvent = true;
        }
        if (event.type === "done") {
          doneReason = event.reason;
          if (event.message) {
            Object.assign(doneMessage, event.message);
          }
        }
      }

      // fetch wrapper detected data: [DONE] → sawStreamDONE=true → promotion to toolUse
      expect(doneReason).toBe("toolUse");
      expect(hasToolCallEvent).toBe(true);
      // The output message should retain the toolCall blocks
      const toolCallBlocks =
        doneMessage.content?.filter((block) => block.type === "toolCall") ?? [];
      expect(toolCallBlocks).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    { name: "an empty response", delta: undefined, done: false, finishReason: undefined },
    {
      name: "a partial visible response",
      delta: { content: "A partial answer" },
      done: false,
      finishReason: undefined,
    },
    {
      name: "an unfinished native tool call",
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_loopback_nodone",
            function: { name: "bash", arguments: '{"cmd":"echo no done"}' },
          },
        ],
      },
      done: false,
      finishReason: undefined,
    },
    {
      name: "a clean SSE terminal without finish_reason",
      delta: { content: "A complete answer" },
      done: true,
      finishReason: undefined,
    },
    {
      name: "an explicit finish_reason without an SSE terminal",
      delta: { content: "A complete answer" },
      done: false,
      finishReason: "stop" as const,
    },
  ])("preserves an honest terminal outcome for $name", async ({ delta, done, finishReason }) => {
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        void body;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (delta) {
          res.write(`data: ${JSON.stringify(makeCompletionsChunk(delta, finishReason))}\n\n`);
        }
        if (done) {
          res.write("data: [DONE]\n\n");
        }
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
      const baseModel = makeCompletionsModel({
        id: "qwen3.6-27b",
        name: "Qwen 3.6 27B",
        provider: "vllm",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        contextWindow: 131072,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Run a command", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let terminalEvent: string | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
      }>) {
        if (event.type === "done" || event.type === "error") {
          terminalEvent = event.type;
        }
      }

      const result = await (await stream).result();
      const cleanTerminal = done || Boolean(finishReason);
      expect(terminalEvent).toBe(cleanTerminal ? "done" : "error");
      expect(result.stopReason).toBe(cleanTerminal ? "stop" : "error");
      if (!cleanTerminal) {
        expect(result.errorMessage).toContain("Stream ended without finish_reason");
      }
      expect(result.content.filter((block) => block.type === "toolCall")).toStrictEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("tags narration before toolcall_start reaches consumers", async () => {
    const model = makeCompletionsModel({
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
      contextWindow: 131072,
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const stream = { push: (event: unknown) => events.push(event as CapturedStreamEvent) };
    const chunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Importing ORDER-1234…" }),
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_import",
              function: { name: "import_order", arguments: '{"id":"ORDER-1234"}' },
            },
          ],
        },
        "tool_calls",
      ),
    ] as const;
    async function* mockStream() {
      for (const chunk of chunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, stream);

    const toolStart = events.find((event) => event.type === "toolcall_start") as
      | { partial?: { content?: Array<{ type?: string; textSignature?: string }> } }
      | undefined;
    const partialText = toolStart?.partial?.content?.find((block) => block.type === "text");
    expect(String(partialText?.textSignature)).toContain('"phase":"commentary"');
  });

  it("rolls back provisional tags when stop strips spurious tool calls", async () => {
    const model = makeCompletionsModel({
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
      contextWindow: 131072,
    });
    const output = createAssistantOutput(model);
    const chunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Here is the answer." }),
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_spurious",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
            },
          ],
        },
        "stop",
      ),
    ] as const;
    async function* mockStream() {
      for (const chunk of chunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, { push() {} });

    expect(output.stopReason).toBe("stop");
    expect(output.content).toStrictEqual([{ type: "text", text: "Here is the answer." }]);
  });

  it("keeps ordinary text unphased when tool_calls is empty", async () => {
    const model = makeCompletionsModel({
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
      contextWindow: 131072,
    });
    const output = createAssistantOutput(model);
    const chunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "Ordinary answer." }),
      makeCompletionsChunk({ tool_calls: [] }, "stop"),
    ] as const;
    async function* mockStream() {
      for (const chunk of chunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, { push() {} });

    expect(output.content).toStrictEqual([{ type: "text", text: "Ordinary answer." }]);
  });

  it("leaves content unchanged when no tool calls and finish_reason is stop", async () => {
    const model = makeCompletionsModel({
      id: "llama-3.3-70b",
      name: "Llama 3.3 70B",
      provider: "llamacpp",
      baseUrl: "http://localhost:8080/v1",
      reasoning: false,
      contextWindow: 131072,
    });

    const output = createAssistantOutput(model);
    const stream = { push: () => {} };

    const mockChunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Just a text reply." }, "stop"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(output.content).toHaveLength(1);
    expect((output.content[0] as { type?: string }).type).toBe("text");
  });

  it("replaces the stored function name on a fragmented continuation (managed parity)", async () => {
    // The managed path (no mode: "direct") invokes the same processCompletionsStream
    // assembler. A fragmented function name arriving in two nonempty snapshots on
    // the same index must resolve to the latest snapshot, matching the direct
    // provider and the pinned OpenAI SDK. This satisfies the issue's
    // "managed-parity assertions" requirement.
    const model = makeCompletionsModel({
      id: "qwen3.6-27b",
      name: "Qwen 3.6 27B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow: 131072,
    });

    const output = createAssistantOutput(model);
    const stream = { push: () => {} };

    const chunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_managed",
            function: { name: "get_", arguments: '{"city":' },
            type: "function",
          },
        ],
      }),
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            function: { name: "weather", arguments: '"Paris"}' },
            type: "function",
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls"),
    ];

    await processCompletionsStream(streamChunks(chunks), output, model, stream);

    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
    const toolCall = toolCalls[0] as { id?: string; name?: string; arguments?: unknown };
    expect(toolCall.id).toBe("call_managed");
    expect(toolCall.name).toBe("weather");
    expect(toolCall.arguments).toEqual({ city: "Paris" });
  });
});
