import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
  it.each([
    {
      name: "keeps streamed tool call arguments intact when reasoning_details repeats",
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
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: " Still thinking." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { arguments: '"qwen3"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls"),
      ],
      expectedFirst: { type: "thinking", thinking: "Need a tool." },
      expectedSecond: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "qwen3" },
      },
      expectedThird: {
        type: "thinking",
        thinking: " Still thinking.",
        thinkingSignature: "reasoning_details",
      },
    },
    {
      name: "surfaces visible OpenRouter response text from reasoning_details without dropping tools",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
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
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: {
        type: "thinking",
        thinking: "Need to look something up.",
        thinkingSignature: "reasoning_details",
      },
      expectedSecond: { type: "text", text: "Working on it." },
      expectedThird: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
    },
  ])(
    "$name",
    async ({ model: modelOverrides, chunks, expectedFirst, expectedSecond, expectedThird }) => {
      const model = makeCompletionsModel(modelOverrides);
      const output = createAssistantOutput(model);

      await processCompletionsStream(streamChunks(chunks), output, model, {
        push() {},
      });

      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toHaveLength(3);
      expectRecordFields(output.content[0], expectedFirst);
      expectRecordFields(output.content[1], expectedSecond);
      expectRecordFields(output.content[2], expectedThird);
    },
  );

  it.each([
    {
      name: "does not surface ambiguous reasoning_details text without explicit compat opt-in",
      model: {
        id: "openrouter/x-ai/grok-4",
        name: "Grok 4",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [
            { type: "reasoning.text", text: "Internal thought." },
            { type: "text", text: "Do not leak this by default." },
          ],
        }),
        makeCompletionsChunk({}, "stop" as const),
      ],
      expected: {
        type: "thinking",
        thinking: "Internal thought.",
        thinkingSignature: "reasoning_details",
      },
    },
    {
      name: "does not duplicate fallback reasoning fields when reasoning_details already provided thinking",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk(
          {
            reasoning_details: [{ type: "reasoning.text", text: "Primary reasoning." }],
            reasoning: "Duplicate fallback reasoning.",
          },
          "stop" as const,
        ),
      ],
      expected: {
        type: "thinking",
        thinking: "Primary reasoning.",
        thinkingSignature: "reasoning_details",
      },
    },
  ])("$name", async ({ model: modelOverrides, chunks, expected }) => {
    const model = makeCompletionsModel(modelOverrides);
    const output = createAssistantOutput(model);

    await processCompletionsStream(streamChunks(chunks), output, model, {
      push() {},
    });

    expect(output.content).toHaveLength(1);
    expectRecordFields(output.content[0], expected);
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

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(3);
    expectRecordFields(output.content[0], { type: "text", text: "Visible first." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: " Hidden second.",
      thinkingSignature: "reasoning_details",
    });
    expectRecordFields(output.content[2], { type: "text", text: " Visible third." });
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

    await processCompletionsStream(mockStream(), output, model, stream);

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], { type: "text", text: "Visible answer." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: "Hidden fallback reasoning.",
      thinkingSignature: "reasoning",
    });
  });

  it.each([
    {
      name: "fails fast when post-tool-call buffering grows beyond the safety cap",
      makeChunks: () => [
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({ content: "x".repeat(300_000) }),
      ],
      expectedError: "Exceeded post-tool-call delta buffer limit",
    },
    {
      name: "fails fast when streaming tool-call arguments grow beyond the safety cap",
      makeChunks: () => {
        const oversizedArgs = `"${"x".repeat(300_000)}"}`;
        return [
          makeCompletionsChunk({
            tool_calls: [
              {
                id: "call_1",
                type: "function" as const,
                function: { name: "lookup", arguments: `{${oversizedArgs}` },
              },
            ],
          }),
        ];
      },
      expectedError: "Exceeded tool-call argument buffer limit",
    },
  ])("$name", async ({ makeChunks, expectedError }) => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const output = createAssistantOutput(model);

    await expect(
      processCompletionsStream(streamChunks(makeChunks()), output, model, {
        push() {},
      }),
    ).rejects.toThrow(expectedError);
  });
});
