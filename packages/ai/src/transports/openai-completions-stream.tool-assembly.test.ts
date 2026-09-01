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
  it("resets stopReason to stop when finish_reason is tool_calls but tool_calls array is empty", async () => {
    const model = makeCompletionsModel({
      id: "nemotron-3-super",
      name: "Nemotron 3 Super",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 1000000,
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
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    const stream = {
      push: () => {},
    };

    const mockChunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "4" }),
      makeCompletionsChunk({ tool_calls: [] as never[] }, "tool_calls" as const),
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
  });

  it("accumulates arguments for parallel tool calls with split indices", async () => {
    const model = makeCompletionsModel({
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-code",
      baseUrl: "https://api.moonshot.cn",
    });

    const output = createAssistantOutput(model);

    const mockChunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_0",
            type: "function",
            function: { name: "exec", arguments: "" },
          },
          {
            index: 1,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      }),
      makeCompletionsChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }],
      }),
      makeCompletionsChunk(
        {
          tool_calls: [{ index: 1, function: { arguments: '{"path":"/tmp"}' } }],
        },
        "tool_calls" as const,
      ),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, {
      push() {},
    });

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "toolCall",
      id: "call_0",
      name: "exec",
      arguments: { command: "ls" },
    });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "/tmp" },
    });
  });

  it("keeps buffered visible text before following tool calls", async () => {
    const model = makeCompletionsModel({
      id: "plain-openai-compatible",
      name: "Plain OpenAI Compatible",
      provider: "plain-openai-compatible",
      baseUrl: "https://api.compat.test/v1",
      reasoning: false,
    });
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: "Use <" }),
        makeCompletionsChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "exec", arguments: '{"command":"ls"}' },
              },
            ],
          },
          "tool_calls" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content[0]).toEqual({
      type: "text",
      text: "Use <",
      textSignature: '{"v":1,"id":"commentary-0","phase":"commentary"}',
    });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_0",
      name: "exec",
      arguments: { command: "ls" },
    });
  });
});
