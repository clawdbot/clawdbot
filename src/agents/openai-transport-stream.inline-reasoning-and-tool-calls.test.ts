import { createServer } from "node:http";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  type OpenAICompletionsOutput,
  type CapturedStreamEvent,
  makeCompletionsModel,
  makeCompletionsChunk,
  createDeepSeekCompletionsModel,
  createAssistantOutput,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("openai transport stream", () => {
  it("partitions inline reasoning tags out of OpenAI-compatible visible text", async () => {
    const model = makeCompletionsModel({
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      provider: "minimax",
      baseUrl: "https://api.minimax.test/v1",
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "Before <thi",
        }),
        makeCompletionsChunk({
          content: "nk>private reasoning</think> after",
          reasoning_content: "private reasoning",
        }),
        makeCompletionsChunk({}, "stop" as const),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

    const visibleText = output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinkingText = output.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    expect(visibleText).toBe("Before  after");
    expect(visibleText).not.toContain("private reasoning");
    expect(thinkingText).toBe("private reasoning");
    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(1);
  });

  it("drops mirrored reasoning when disabled without recovering hidden reasoning tags", async () => {
    const model = makeCompletionsModel({
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      provider: "minimax",
      baseUrl: "https://api.minimax.test/v1",
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "<think>private reasoning",
        }),
        makeCompletionsChunk(
          {
            reasoning_content: "private reasoning",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      { emitReasoning: false },
    );

    const visibleText = output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(visibleText).toBe("");
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
    expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
  });

  it("keeps literal reasoning tag examples visible without mirrored reasoning", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "Use `<think>private</think>` only as an example.",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Use `<think>private</think>` only as an example.",
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("keeps prose mentions of unclosed reasoning tags visible without mirrored reasoning", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "The <reasoning> tag is deprecated in this example.",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "The <reasoning> tag is deprecated in this example.",
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("keeps prose mentions of unmatched close tags visible without mirrored reasoning", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "Use </think> to close the tag.",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Use </think> to close the tag.",
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("strips content-only closed reasoning tags from OpenAI-compatible visible text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "Before <think>private reasoning</think> after",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Before  after",
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("keeps content-only unclosed mid-answer reasoning-looking tags visible", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "Before <think>literal tag text after",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Before <think>literal tag text after",
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("recovers fully wrapped unclosed OpenAI-compatible reasoning text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: "<think>Visible answer from a malformed local model",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Visible answer from a malformed local model",
    });
  });

  it("does not recover buffered reasoning tags after structured thinking content", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "<think>private reasoning",
        }),
        makeCompletionsChunk(
          {
            content: { type: "reasoning", text: "private reasoning" },
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    const visibleText = output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinkingText = output.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    expect(visibleText).toBe("");
    expect(thinkingText).toBe("private reasoning");
  });

  it("keeps literal reasoning tag examples visible with mirrored reasoning", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "Use `<thi",
        }),
        makeCompletionsChunk(
          {
            content: "nk>private</think>` only as an example.",
            reasoning_content: "Actual hidden reasoning.",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toContainEqual({
      type: "text",
      text: "Use `<think>private</think>` only as an example.",
    });
    expect(output.content).toContainEqual({
      type: "thinking",
      thinking: "Actual hidden reasoning.",
      thinkingSignature: "reasoning_content",
    });
  });

  it("promotes silent tool calls when provider signals finish_reason stop", async () => {
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
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_legit",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
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

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
  });

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

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream, {
      sawStreamDONE: () => true,
    });

    expect(output.stopReason).toBe("toolUse");
    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
  });

  it.each([
    { chunks: ["data: [DO", "NE]\r\n\r\n"], expected: true },
    { chunks: ["data:[DONE]"], expected: true },
    { chunks: ['data: {"value":"[DONE]"}\n\n'], expected: false },
    { chunks: [`data: ${"x".repeat(1_024)}data: [DONE]\n\n`], expected: false },
  ])("detects only an exact bounded SSE terminal line: $chunks", ({ chunks, expected }) => {
    const detector = testing.createSseDoneDetector();
    const encoder = new TextEncoder();
    for (const chunk of chunks) {
      detector.observe(encoder.encode(chunk));
    }
    detector.finish();

    expect(detector.sawDone()).toBe(expected);
  });

  it("does not promote native tool calls when stream ends without [DONE] and without finish_reason", async () => {
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
            id: "call_nodone",
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

    // sawStreamDONE defaults to false — connection drop without [DONE]
    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    // EOF without [DONE] and without finish_reason → fail-closed
    expect(output.stopReason).toBe("stop");
    expect(
      output.content.filter((block) => (block as { type?: string }).type === "toolCall"),
    ).toStrictEqual([]);
  });

  it("strips tool calls when stream has visible text and no finish_reason", async () => {
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
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    // Visible text + tool calls without finish_reason is ambiguous;
    // conservatively strip tool calls.
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

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

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

  it("keeps tool calls fail-closed through fetch wrapper when stream ends without [DONE] and without finish_reason", async () => {
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
        // Emit delta.tool_calls chunk with no finish_reason
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_loopback_nodone",
                  function: { name: "bash", arguments: '{"cmd":"echo no done"}' },
                },
              ],
            }),
          )}\n\n`,
        );
        // Close WITHOUT data: [DONE] — simulates connection drop / truncated stream
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
      const doneMessage: { content?: Array<{ type?: string }> } = {};
      for await (const event of stream as AsyncIterable<{
        type: string;
        reason?: string;
        message?: { content?: Array<{ type?: string }> };
      }>) {
        if (event.type === "done") {
          doneReason = event.reason;
          if (event.message) {
            Object.assign(doneMessage, event.message);
          }
        }
      }

      // EOF without [DONE] → sawStreamDONE stays false → fail-closed
      expect(doneReason).toBe("stop");
      const toolCallBlocks =
        doneMessage.content?.filter((block) => block.type === "toolCall") ?? [];
      expect(toolCallBlocks).toStrictEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps tool call blocks when provider signals finish_reason tool_calls", async () => {
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
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_legit",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
            },
          ],
        },
        "tool_calls",
      ),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
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

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(output.content).toHaveLength(1);
    expect((output.content[0] as { type?: string }).type).toBe("text");
  });

  it("handles reasoning_details from OpenRouter/Qwen3 in completions stream", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const output: OpenAICompletionsOutput = {
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "I need to think about this." },
                { type: "reasoning.text", text: " Let me analyze." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({
        content: " Hello! How can I help you?",
      }),
      makeCompletionsChunk({}, "stop"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    const thinkingBlock = expectDefined(output.content[0], "output.content[0] test invariant") as {
      type: string;
      thinking: string;
    };
    const textBlock = expectDefined(output.content[1], "output.content[1] test invariant") as {
      type: string;
      text: string;
    };

    expect(output.content.length).toBe(2);
    expect(thinkingBlock.type).toBe("thinking");
    expect(thinkingBlock.thinking).toBe("I need to think about this. Let me analyze.");
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toBe(" Hello! How can I help you?");
  });

  it("normalizes structured completions content blocks without stringifying objects (#78846)", async () => {
    const model = makeCompletionsModel({
      id: "mistral-small-latest",
      name: "Mistral Small",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
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
    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              content: [
                { type: "thinking", thinking: [{ type: "text", text: "Need to think." }] },
                { type: "text", content: "Visible answer." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "stop"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toEqual([
      { type: "thinking", thinking: "Need to think.", thinkingSignature: "content" },
      { type: "text", text: "Visible answer." },
    ]);
  });

  it("keeps tool calls when reasoning_details and tool_calls share a chunk", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":"qwen3"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "thinking",
      thinking: "Need a tool.",
      thinkingSignature: "reasoning_details",
    });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "qwen3" },
    });
  });

  it("treats singular tool_call finish_reason as tool use", async () => {
    const model = makeCompletionsModel({
      id: "minimax-m2.5-8bit",
      name: "MiniMax M2.5 8bit",
      provider: "mlx-lm",
      baseUrl: "http://localhost:1234/v1",
      reasoning: false,
      contextWindow: 128000,
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

    const mockChunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_call"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    const toolCall = (output.content as Array<{ type?: string }>).find(
      (item) => item.type === "toolCall",
    );
    expectRecordFields(toolCall, { type: "toolCall", id: "call_1", name: "lookup" });
  });

  it("keeps streamed tool call arguments intact when reasoning_details repeats", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: " Still thinking." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"qwen3"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls"),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(3);
    expectRecordFields(output.content[0], { type: "thinking", thinking: "Need a tool." });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "qwen3" },
    });
    expectRecordFields(output.content[2], {
      type: "thinking",
      thinking: " Still thinking.",
      thinkingSignature: "reasoning_details",
    });
  });

  it("surfaces visible OpenRouter response text from reasoning_details without dropping tools", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "Need to look something up." },
                { type: "response.output_text", text: "Working on it." },
              ],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls" as const),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(3);
    expectRecordFields(output.content[0], {
      type: "thinking",
      thinking: "Need to look something up.",
      thinkingSignature: "reasoning_details",
    });
    expectRecordFields(output.content[1], { type: "text", text: "Working on it." });
    expectRecordFields(output.content[2], {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "weather" },
    });
  });

  it("does not surface ambiguous reasoning_details text without explicit compat opt-in", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/x-ai/grok-4",
      name: "Grok 4",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "reasoning.text", text: "Internal thought." },
                { type: "text", text: "Do not leak this by default." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "stop" as const),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(1);
    expectRecordFields(output.content[0], {
      type: "thinking",
      thinking: "Internal thought.",
      thinkingSignature: "reasoning_details",
    });
  });

  it("preserves reasoning_details item order when visible text and thinking are interleaved", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: "response.output_text", text: "Visible first." },
                { type: "reasoning.text", text: " Hidden second." },
                { type: "response.text", text: " Visible third." },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(3);
    expectRecordFields(output.content[0], { type: "text", text: "Visible first." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: " Hidden second.",
      thinkingSignature: "reasoning_details",
    });
    expectRecordFields(output.content[2], { type: "text", text: " Visible third." });
  });

  it("does not duplicate fallback reasoning fields when reasoning_details already provided thinking", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "Primary reasoning." }],
              reasoning: "Duplicate fallback reasoning.",
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(1);
    expectRecordFields(output.content[0], {
      type: "thinking",
      thinking: "Primary reasoning.",
      thinkingSignature: "reasoning_details",
    });
  });

  it("keeps fallback thinking when reasoning_details only carries visible text", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Visible answer." }],
              reasoning: "Hidden fallback reasoning.",
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: "stop" as const,
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], { type: "text", text: "Visible answer." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: "Hidden fallback reasoning.",
      thinkingSignature: "reasoning",
    });
  });

  it("keeps a streaming tool call intact when visible reasoning text arrives mid-call", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls" as const),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "weather" },
    });
    expectRecordFields(output.content[1], { type: "text", text: "Working on it." });
  });

  it("keeps a streaming tool call intact when visible reasoning text arrives between chunks", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { arguments: '"weather"}' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls" as const),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "weather" },
    });
    expectRecordFields(output.content[1], { type: "text", text: "Working on it." });
  });

  it("fails fast when post-tool-call buffering grows beyond the safety cap", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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
    const oversizedText = "x".repeat(300_000);

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: '{"query":' },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              content: oversizedText,
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await expect(
      testing.processOpenAICompletionsStream(mockStream(), output, model, stream),
    ).rejects.toThrow("Exceeded post-tool-call delta buffer limit");
  });

  it("fails fast when streaming tool-call arguments grow beyond the safety cap", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
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
    const oversizedArgs = `"${"x".repeat(300_000)}"}`;

    const mockChunks = [
      makeCompletionsChunk({}, null, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function" as const,
                  function: { name: "lookup", arguments: `{${oversizedArgs}` },
                },
              ],
            } as Record<string, unknown>,
            logprobs: null,
            finish_reason: null,
          },
        ],
      }),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await expect(
      testing.processOpenAICompletionsStream(mockStream(), output, model, stream),
    ).rejects.toThrow("Exceeded tool-call argument buffer limit");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
