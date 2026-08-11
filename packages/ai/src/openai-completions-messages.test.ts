import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("convertMessages assistant text replay", () => {
  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
  });

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});
