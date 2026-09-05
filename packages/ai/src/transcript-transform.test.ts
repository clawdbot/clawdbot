// Covers replay resilience for malformed persisted transcript ids (#137729).
import { describe, expect, it } from "vitest";
import { transformMessages } from "./transcript-transform.js";
import type { Message, Model } from "./types.js";

const model: Model<"openai-completions"> = {
  id: "target-model",
  name: "Target model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

describe("transformMessages with malformed persisted transcript ids", () => {
  it("normalizes assistant tool-call blocks missing an id instead of crashing", () => {
    const messages = [
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "toolCall", id: undefined, name: "read_file", arguments: {} }],
        timestamp: 1,
      },
    ] as unknown as Message[];

    const transformed = transformMessages(messages, model);
    const [message] = transformed;
    if (!message) {
      throw new Error("expected transformMessages to return the assistant message");
    }
    const [block] = message.content as Array<{ type: string; id?: string }>;
    if (!block) {
      throw new Error("expected the assistant message to keep its tool-call block");
    }
    expect(block.id).toBe("");
  });

  it("drops malformed non-tool assistant blocks instead of forwarding them as tool calls", () => {
    const messages = [
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "attachment", path: "/tmp/poison.bin" }],
        timestamp: 4,
      },
    ] as unknown as Message[];

    const transformed = transformMessages(messages, model);
    const [message] = transformed;
    if (!message) {
      throw new Error("expected transformMessages to return the assistant message");
    }
    expect(message.content).toEqual([]);
  });

  it("normalizes tool-result messages missing toolCallId instead of crashing", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: undefined,
        toolName: "read_file",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 2,
      },
    ] as unknown as Message[];

    const transformed = transformMessages(messages, model);
    const [message] = transformed;
    if (!message) {
      throw new Error("expected transformMessages to return the tool result message");
    }
    expect((message as { toolCallId?: string }).toolCallId).toBe("");
  });

  it("still trims well-formed tool-result ids", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: " call_1 ",
        toolName: "read_file",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    ] as unknown as Message[];

    const transformed = transformMessages(messages, model);
    const [message] = transformed;
    if (!message) {
      throw new Error("expected transformMessages to return the tool result message");
    }
    expect((message as { toolCallId?: string }).toolCallId).toBe("call_1");
  });
});
