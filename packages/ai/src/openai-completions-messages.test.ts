import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
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
  it("serializes advertised video in ordered Chat Completions user content", () => {
    const videoModel = {
      ...model,
      input: ["text", "image", "video"],
    } as ProviderModel<"openai-completions">;
    const context: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: "image" },
            { type: "video", mimeType: "video/mp4", data: "video" },
            { type: "text", text: "after" },
          ],
          timestamp: 1,
        },
      ],
    };

    const converted = convertMessages(
      videoModel as Model<"openai-completions">,
      context as Context,
      resolveOpenAICompletionsCompat(videoModel as Model<"openai-completions">),
    );

    expect(converted[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,image" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,video" } },
      { type: "text", text: "after" },
    ]);
  });

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

  it.each([false, true])(
    "preserves sanitized block positions with thinking-as-text %s",
    (requiresThinkingAsText) => {
      const assistant: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: "thinking", thinking: "reason\ud800" },
          { type: "text", text: " \t" },
          { type: "text", text: "first\ud800" },
          { type: "text", text: "\udc00" },
          { type: "thinking", thinking: "next😀" },
          { type: "text", text: "last😀" },
        ],
        usage: emptyUsage,
        stopReason: "stop",
        timestamp: 2,
      };
      const converted = convertMessages(
        model,
        { messages: [assistant] },
        { ...resolveOpenAICompletionsCompat(model), requiresThinkingAsText },
      );

      expect(converted).toEqual([
        {
          role: "assistant",
          content: requiresThinkingAsText
            ? [
                { type: "text", text: "reason\n\nnext😀" },
                { type: "text", text: "first" },
                { type: "text", text: "" },
                { type: "text", text: "last😀" },
              ]
            : "first\n\nlast😀",
        },
      ]);
    },
  );

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
