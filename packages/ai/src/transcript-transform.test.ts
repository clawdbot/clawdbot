import type { AssistantMessage, Message, Model, ToolCall } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { transformMessages } from "./transcript-transform.js";

const baseModel: Model = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 100,
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function otherModelAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "other",
    model: "other-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("transcript-transform / #137729 unguarded trim", () => {
  it("does not crash on an assistant content block without an id", () => {
    // A runtime attachment block may carry no id even though the static union
    // requires one; before the fix this crashed every subsequent turn.
    const attachmentBlock = { type: "attachment", data: "x" } as unknown as ToolCall;
    const message = assistantMessage([attachmentBlock]);

    expect(() => transformMessages([message], baseModel)).not.toThrow();
    const [out] = transformMessages([message], baseModel) as AssistantMessage[];
    expect(out).toBeDefined();
    const result = out as AssistantMessage;
    expect((result.content[0] as { id?: string }).id).toBe("");
  });

  it("does not crash on a toolResult message without a toolCallId", () => {
    const toolResult = {
      role: "toolResult",
      toolName: "t",
      content: [],
      isError: false,
      timestamp: 0,
    } as unknown as Message;

    expect(() => transformMessages([toolResult], baseModel)).not.toThrow();
  });

  it("still trims tool call ids (regression)", () => {
    const call: ToolCall = {
      type: "toolCall",
      id: "  call_1  ",
      name: "t",
      arguments: {},
    };
    const message = assistantMessage([call]);

    const [out] = transformMessages([message], baseModel) as AssistantMessage[];
    expect(out).toBeDefined();
    const result = out as AssistantMessage;
    expect((result.content[0] as ToolCall).id).toBe("call_1");
  });

  it("does not crash on an async toolCall with undefined id from another model", () => {
    const asyncCall = {
      type: "toolCall",
      id: undefined,
      name: "t",
      arguments: {},
      async: true,
    } as unknown as ToolCall;
    const message = otherModelAssistantMessage([asyncCall]);

    expect(() => transformMessages([message], baseModel)).not.toThrow();
  });

  it("relocates async tool results with empty IDs beside their calls", () => {
    // Async calls from a different model should have their delayed results
    // relocated adjacent to the call, even when both IDs are empty strings.
    // An intervening assistant turn ensures the fixture actually detects a
    // skipped relocation — without it, the result would already be adjacent.
    const asyncCall: ToolCall = {
      type: "toolCall",
      id: "",
      name: "t",
      arguments: {},
      async: true,
    };
    const otherMessage = otherModelAssistantMessage([asyncCall]);
    const interveningAssistant = assistantMessage([{ type: "text", text: "intervening turn" }]);
    const toolResult: Message = {
      role: "toolResult",
      toolCallId: "",
      toolName: "t",
      content: [{ type: "text", text: "delayed result" }],
      isError: false,
      timestamp: 1,
    } as unknown as Message;

    const result = transformMessages([otherMessage, interveningAssistant, toolResult], baseModel);

    // The toolResult should be relocated to appear immediately after the
    // assistant message that made the async call, before the intervening turn.
    expect(result[0]?.role).toBe("assistant");
    expect(result[1]?.role).toBe("toolResult");
    // Assert observable contents instead of reference identity — the transform
    // may copy toolResult messages for non-vision models.
    const relocatedResult = result[1] as unknown as {
      toolCallId?: string;
      toolName?: string;
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(relocatedResult.toolCallId).toBe("");
    expect(relocatedResult.toolName).toBe("t");
    expect(relocatedResult.content[0]?.text).toContain("delayed result");
    expect(relocatedResult.isError).toBe(false);
    // The intervening assistant turn should follow the relocated result.
    expect(result[2]?.role).toBe("assistant");
  });
});
