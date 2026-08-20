import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

describe("openai completions stream", () => {
  it("partitions inline reasoning tags out of OpenAI-compatible visible text", async () => {
    const model = makeCompletionsModel({
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      provider: "minimax",
      baseUrl: "https://api.minimax.test/v1",
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
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

    await processCompletionsStream(
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

  it.each([
    {
      title: "keeps literal reasoning tag examples visible without mirrored reasoning",
      text: "Use `<think>private</think>` only as an example.",
      expectedText: "Use `<think>private</think>` only as an example.",
    },
    {
      title: "keeps prose mentions of unclosed reasoning tags visible without mirrored reasoning",
      text: "The <reasoning> tag is deprecated in this example.",
      expectedText: "The <reasoning> tag is deprecated in this example.",
    },
    {
      title: "keeps prose mentions of unmatched close tags visible without mirrored reasoning",
      text: "Use </think> to close the tag.",
      expectedText: "Use </think> to close the tag.",
    },
    {
      title: "strips content-only closed reasoning tags from OpenAI-compatible visible text",
      text: "Before <think>private reasoning</think> after",
      expectedText: "Before  after",
    },
    {
      title: "keeps content-only unclosed mid-answer reasoning-looking tags visible",
      text: "Before <think>literal tag text after",
      expectedText: "Before <think>literal tag text after",
    },
  ])("$title", async ({ text, expectedText }) => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk(
          {
            content: text,
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
      text: expectedText,
    });
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("recovers fully wrapped unclosed OpenAI-compatible reasoning text", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
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

    await processCompletionsStream(
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

    await processCompletionsStream(
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

  it.each([
    {
      name: "promotes silent tool calls when provider signals finish_reason stop",
      model: {
        id: "qwen3.6-27b",
        name: "Qwen 3.6 27B",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131072,
      },
      finishReason: "stop",
    },
    {
      name: "keeps tool call blocks when provider signals finish_reason tool_calls",
      model: {
        id: "llama-3.3-70b",
        name: "Llama 3.3 70B",
        provider: "llamacpp",
        baseUrl: "http://localhost:8080/v1",
        reasoning: false,
        contextWindow: 131072,
      },
      finishReason: "tool_calls",
    },
  ])("$name", async ({ model: modelOverrides, finishReason }) => {
    const model = makeCompletionsModel(modelOverrides);
    const output = createAssistantOutput(model);

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
        finishReason,
      ),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, {
      push() {},
    });

    expect(output.stopReason).toBe("toolUse");
    const toolCalls = output.content.filter(
      (block) => (block as { type?: string }).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(1);
  });
});
