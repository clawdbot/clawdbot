import { describe, expect, it } from "vitest";
import type { AssistantMessage, ThinkingContent } from "../types.js";
import {
  appendAssistantThinking,
  AssistantMessageEventStream,
  readAssistantThinkingAppend,
} from "./event-stream.js";

function fixture() {
  const block: ThinkingContent = { type: "thinking", thinking: "before" };
  const message: AssistantMessage = {
    role: "assistant",
    content: [block],
    api: "openai-completions",
    provider: "synthetic",
    model: "reasoning-fixture",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = new AssistantMessageEventStream();
  const append = (delta: string) => {
    appendAssistantThinking(block, delta);
    stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message });
  };
  return { block, message, stream, append };
}

describe("native reasoning append facts", () => {
  it("accepts only the actual previous and current snapshots, including queued replacements", () => {
    const { block, message, stream, append } = fixture();
    append(" one");
    expect(readAssistantThinkingAppend(block, "before")).toBe(" one");
    append(" two");
    expect(readAssistantThinkingAppend(block, "before")).toBeUndefined();
    expect(readAssistantThinkingAppend(block, "before one")).toBe(" two");
    block.thinking = "replacement";
    expect(readAssistantThinkingAppend(block, "before one")).toBeUndefined();
    append(" three");
    expect(readAssistantThinkingAppend(block, "before one two")).toBeUndefined();
    expect(readAssistantThinkingAppend(block, "replacement")).toBe(" three");
    stream.end(message);
  });

  it("retires buffered append facts even when no delta reached the stream", () => {
    const { block, message, stream } = fixture();
    appendAssistantThinking(block, " buffered");
    expect(readAssistantThinkingAppend(block, "before")).toBe(" buffered");
    stream.push({ type: "done", reason: "stop", message });
    expect(readAssistantThinkingAppend(block, "before")).toBeUndefined();
  });

  it.each(["thinking_end", "done", "error", "end", "bare_end"] as const)(
    "releases append facts at %s even while the historical block remains reachable",
    async (boundary) => {
      const { block, message, stream, append } = fixture();
      append(" after");
      expect(readAssistantThinkingAppend(block, "before")).toBe(" after");
      switch (boundary) {
        case "thinking_end":
          stream.push({
            type: "thinking_end",
            contentIndex: 0,
            content: block.thinking,
            partial: message,
          });
          break;
        case "done":
          stream.push({ type: "done", reason: "stop", message });
          break;
        case "error":
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message, stopReason: "error" },
          });
          break;
        case "end":
          stream.end(message);
          break;
        case "bare_end":
          stream.end();
          await expect(stream.result()).rejects.toThrow("without a terminal event");
          break;
      }
      expect(message.content[0]).toBe(block);
      expect(readAssistantThinkingAppend(block, "before")).toBeUndefined();
      if (boundary !== "thinking_end") {
        append(" late");
        expect(readAssistantThinkingAppend(block, "before after")).toBeUndefined();
      }
      stream.end(message);
    },
  );
});
