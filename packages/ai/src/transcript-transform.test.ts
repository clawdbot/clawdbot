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

describe("transcript-transform / #137729 unguarded trim", () => {
  it("does not crash on an assistant content block without an id", () => {
    // A runtime attachment block may carry no id even though the static union
    // requires one; before the fix this crashed every subsequent turn.
    const attachmentBlock = { type: "attachment", data: "x" } as unknown as ToolCall;
    const message = assistantMessage([attachmentBlock]);

    expect(() => transformMessages([message], baseModel)).not.toThrow();
    const [out] = transformMessages([message], baseModel) as AssistantMessage[];
    expect((out.content[0] as { id?: string }).id).toBe("");
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
    expect((out.content[0] as ToolCall).id).toBe("call_1");
  });
});
