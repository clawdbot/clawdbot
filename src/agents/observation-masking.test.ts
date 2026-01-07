import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { maskToolResultsForContext } from "./observation-masking.js";

const toolResult = (id: string, text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

describe("maskToolResultsForContext", () => {
  it("masks all but the most recent tool result", () => {
    const messages = [
      userMessage("hello"),
      toolResult("t1", "first"),
      toolResult("t2", "second"),
    ];
    const masked = maskToolResultsForContext(messages, {
      keepLast: 1,
      placeholder: "MASKED",
    });

    expect(masked[1]).not.toBe(messages[1]);
    expect((masked[1] as { content?: unknown }).content).toEqual([
      { type: "text", text: "MASKED" },
    ]);
    expect(masked[2]).toBe(messages[2]);
    expect((masked[2] as { content?: unknown }).content).toEqual([
      { type: "text", text: "second" },
    ]);
  });

  it("returns original messages when no masking is needed", () => {
    const messages = [userMessage("hello"), toolResult("t1", "only")];
    const masked = maskToolResultsForContext(messages, {
      keepLast: 1,
      placeholder: "MASKED",
    });
    expect(masked).toBe(messages);
  });

  it("masks all tool results when keepLast is 0", () => {
    const messages = [toolResult("t1", "first"), toolResult("t2", "second")];
    const masked = maskToolResultsForContext(messages, {
      keepLast: 0,
      placeholder: "MASKED",
    });

    for (const entry of masked) {
      expect((entry as { content?: unknown }).content).toEqual([
        { type: "text", text: "MASKED" },
      ]);
    }
  });
});
