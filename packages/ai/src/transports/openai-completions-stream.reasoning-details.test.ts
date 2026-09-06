import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createZeroUsage } from "../usage.test-support.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type OpenAICompletionsOutput,
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
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
      usage: createZeroUsage(),
      stopReason: "stop" as const,
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

    await processCompletionsStream(mockStream(), output, model, stream);

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
      usage: createZeroUsage(),
      stopReason: "stop" as const,
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

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toEqual([
      { type: "thinking", thinking: "Need to think." },
      { type: "text", text: "Visible answer." },
    ]);
  });

  it.each([
    {
      name: "keeps tool calls when reasoning_details and tool_calls share a chunk",
      model: {
        id: "openrouter/qwen/qwen3-235b-a22b",
        name: "Qwen3 235B A22B",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":"qwen3"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls"),
      ],
      expectedFirst: {
        type: "thinking",
        thinking: "Need a tool.",
        thinkingSignature: "reasoning_details",
      },
      expectedSecond: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "qwen3" },
      },
    },
    {
      name: "keeps a streaming tool call intact when visible reasoning text arrives mid-call",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { arguments: '"weather"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
      expectedSecond: { type: "text", text: "Working on it." },
    },
    {
      name: "keeps a streaming tool call intact when visible reasoning text arrives between chunks",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
        }),
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { arguments: '"weather"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
      expectedSecond: { type: "text", text: "Working on it." },
    },
  ])("$name", async ({ model: modelOverrides, chunks, expectedFirst, expectedSecond }) => {
    const model = makeCompletionsModel(modelOverrides);
    const output = createAssistantOutput(model);

    await processCompletionsStream(streamChunks(chunks), output, model, {
      push() {},
    });

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], expectedFirst);
    expectRecordFields(output.content[1], expectedSecond);
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
      usage: createZeroUsage(),
      stopReason: "stop" as const,
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

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("toolUse");
    const toolCall = (output.content as Array<{ type?: string }>).find(
      (item) => item.type === "toolCall",
    );
    expectRecordFields(toolCall, { type: "toolCall", id: "call_1", name: "lookup" });
  });
});
