import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";

function asMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}

function makeDualToolUseAssistantContent() {
  return [
    { type: "toolUse", id: "tool-1", name: "test1", arguments: {} },
    { type: "toolUse", id: "tool-2", name: "test2", arguments: {} },
    { type: "text", text: "Done" },
  ];
}

function makeDualToolAnthropicTurns(nextUserContent: unknown[]) {
  return asMessages([
    { role: "user", content: [{ type: "text", text: "Use tools" }] },
    {
      role: "assistant",
      content: makeDualToolUseAssistantContent(),
    },
    {
      role: "user",
      content: nextUserContent,
    },
  ]);
}

function makeSignedThinkingGatewayToolCall(toolId: string) {
  return [
    { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    { type: "toolCall", id: toolId, name: "gateway", arguments: {} },
  ];
}

function expectAssistantToolCallsOmitted(result: AgentMessage[], expectedLength: number) {
  expect(result).toHaveLength(expectedLength);
  expect((result[1] as { role?: unknown }).role).toBe("assistant");
  expect((result[1] as { content?: unknown[] }).content).toEqual([
    { type: "text", text: "[tool calls omitted]" },
  ]);
}

describe("validate turn edge cases", () => {
  it("returns empty array unchanged", () => {
    expect(validateGeminiTurns([])).toStrictEqual([]);
    expect(validateAnthropicTurns([])).toStrictEqual([]);
  });

  it("returns single message unchanged", () => {
    const geminiMsgs = asMessages([
      {
        role: "user",
        content: "Hello",
      },
    ]);
    const anthropicMsgs = asMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ]);
    expect(validateGeminiTurns(geminiMsgs)).toEqual(geminiMsgs);
    expect(validateAnthropicTurns(anthropicMsgs)).toEqual(anthropicMsgs);
  });
});

describe("validateGeminiTurns", () => {
  it("should leave alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: [{ type: "text", text: "Good!" }] },
    ]);
    const result = validateGeminiTurns(msgs);
    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive assistant messages", () => {
    const msgs = asMessages([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        stopReason: "end_turn",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        stopReason: "end_turn",
      },
      { role: "user", content: "How are you?" },
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toEqual([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
        stopReason: "end_turn",
      },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("should preserve metadata from later message when merging", () => {
    const msgs = asMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        usage: { input: 10, output: 5 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        usage: { input: 10, output: 10 },
        stopReason: "end_turn",
      },
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
        usage: { input: 10, output: 10 },
        stopReason: "end_turn",
      },
    ]);
  });

  it("should handle toolResult messages without merging", () => {
    const msgs = asMessages([
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", input: {} }],
      },
      {
        role: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Found data" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here's the answer" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Extra thoughts" }],
      },
      { role: "user", content: "Request 2" },
    ]);

    const result = validateGeminiTurns(msgs);

    expect(result).toEqual([
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", input: {} }],
      },
      {
        role: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Found data" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the answer" },
          { type: "text", text: "Extra thoughts" },
        ],
      },
      { role: "user", content: "Request 2" },
    ]);
  });
});

describe("validateAnthropicTurns", () => {
  it("should return alternating user/assistant unchanged", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
      { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    ]);
    const result = validateAnthropicTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive user messages", () => {
    const msgs = asMessages([
      {
        role: "user",
        content: [{ type: "text", text: "First message" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Second message" }],
        timestamp: 2000,
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "First message" },
          { type: "text", text: "Second message" },
        ],
        timestamp: 2000,
      },
    ]);
  });

  it("should merge three consecutive user messages", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "One" }] },
      { role: "user", content: [{ type: "text", text: "Two" }] },
      { role: "user", content: [{ type: "text", text: "Three" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "One" },
          { type: "text", text: "Two" },
          { type: "text", text: "Three" },
        ],
      },
    ]);
  });

  it("keeps newest metadata when merging consecutive users", () => {
    const msgs = asMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Old" }],
        timestamp: 1000,
        attachments: [{ type: "image", url: "old.png" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "New" }],
        timestamp: 2000,
        attachments: [{ type: "image", url: "new.png" }],
        someCustomField: "keep-me",
      } as AgentMessage,
    ]);

    const result = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.timestamp).toBe(2000);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.content).toEqual([
      { type: "text", text: "Old" },
      { type: "text", text: "New" },
    ]);
  });

  it("merges consecutive users with images and preserves order", () => {
    const msgs = asMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", url: "img1" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "image", url: "img2" },
          { type: "text", text: "second" },
        ],
      },
    ]);

    const [merged] = validateAnthropicTurns(msgs) as Extract<AgentMessage, { role: "user" }>[];
    expect(merged.content).toEqual([
      { type: "text", text: "first" },
      { type: "image", url: "img1" },
      { type: "image", url: "img2" },
      { type: "text", text: "second" },
    ]);
  });

  it("should not merge consecutive assistant messages", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer 2" }],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toEqual(msgs);
  });

  it("should handle mixed scenario with steering messages", () => {
    // Simulates: user asks -> assistant errors -> steering user message injected
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Overloaded",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Steering: try again" }],
      },
      { role: "user", content: [{ type: "text", text: "Another follow-up" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Overloaded",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Steering: try again" },
          { type: "text", text: "Another follow-up" },
        ],
      },
    ]);
  });
});

describe("mergeConsecutiveUserTurns", () => {
  it("keeps newest metadata while merging content", () => {
    const previous = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
      attachments: [{ type: "image", url: "old.png" }],
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      role: "user",
      content: [{ type: "text", text: "after" }],
      timestamp: 2000,
      attachments: [{ type: "image", url: "new.png" }],
      someCustomField: "keep-me",
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
    expect((merged as { attachments?: unknown[] }).attachments).toEqual([
      { type: "image", url: "new.png" },
    ]);
    expect((merged as { someCustomField?: string }).someCustomField).toBe("keep-me");
    expect(merged.timestamp).toBe(2000);
  });

  it("preserves string content while merging content", () => {
    const previous = {
      role: "user",
      content: "before",
      timestamp: 1000,
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      role: "user",
      content: "after",
      timestamp: 2000,
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
  });

  it("backfills timestamp from earlier message when missing", () => {
    const previous = {
      role: "user",
      content: [{ type: "text", text: "before" }],
      timestamp: 1000,
    } as Extract<AgentMessage, { role: "user" }>;
    const current = {
      role: "user",
      content: [{ type: "text", text: "after" }],
    } as Extract<AgentMessage, { role: "user" }>;

    const merged = mergeConsecutiveUserTurns(previous, current);

    expect(merged.timestamp).toBe(1000);
  });
});

describe("validateAnthropicTurns strips dangling tool_use blocks", () => {
  it("should strip tool_use blocks without matching tool_result", () => {
    // Simulates: user asks -> assistant has tool_use -> user responds without tool_result
    // This happens after compaction trims history
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "I'll check that" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // The dangling tool_use should be stripped, but text content preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "I'll check that" }]);
  });

  it("should preserve tool_use blocks with matching tool_result", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "Here's result" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "Result" }] },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // tool_use should be preserved because matching tool_result exists
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolUse", id: "tool-1", name: "test", arguments: {} },
      { type: "text", text: "Here's result" },
    ]);
  });

  it("should insert fallback text when all content would be removed", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // Should insert fallback text since all content would be removed
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "[tool calls omitted]" }]);
  });

  it("leaves aborted tool-only assistant turns empty instead of synthesizing fallback text", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    expect((result[1] as { content?: unknown[] }).content).toStrictEqual([]);
  });

  it("should handle multiple dangling tool_use blocks", () => {
    const msgs = makeDualToolAnthropicTurns([{ type: "text", text: "OK" }]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    // Only text content should remain
    expect(assistantContent).toEqual([{ type: "text", text: "Done" }]);
  });

  it("should handle mixed tool_use with some having matching tool_result", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        type: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Result 1" }],
      },
      { type: "text", text: "Thanks" },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    // tool-1 should be preserved (has matching tool_result), tool-2 stripped, text preserved
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolUse", id: "tool-1", name: "test1", arguments: {} },
      { type: "text", text: "Done" },
    ]);
  });

  it("matches standalone toolResult messages before the next assistant turn", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "test", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "data" }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "toolCall", id: "tool-1", name: "test", arguments: {} },
    ]);
  });

  it("matches tool result blocks across intermediate non-assistant messages", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "functionCall", id: "tool-1", name: "test", arguments: {} },
          { type: "text", text: "Checking" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "still waiting" }] },
      { role: "tool", toolCallId: "tool-1", content: [{ type: "text", text: "data" }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(5);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([
      { type: "functionCall", id: "tool-1", name: "test", arguments: {} },
      { type: "text", text: "Checking" },
    ]);
  });

  it("preserves signed-thinking turns whose sibling tool calls still resolve", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "gateway",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual(makeSignedThinkingGatewayToolCall("tool-1"));
  });

  it("drops signed-thinking turns when the only matching tool result is embedded in user content", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          makeSignedThinkingGatewayToolCall("tool-1")[0],
          { type: "toolUse", id: "tool-1", name: "gateway", arguments: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "tool-1", content: [{ type: "text", text: "ok" }] },
          { type: "text", text: "Continue" },
        ],
      },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 3);
  });

  it("preserves signed-thinking turns when a trusted tool result carries both stale and current id aliases", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-current"),
      },
      {
        role: "toolResult",
        toolUseId: "tool-stale",
        toolCallId: "tool-current",
        toolName: "gateway",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(4);
    expect((result[1] as { content?: unknown[] }).content).toEqual(
      makeSignedThinkingGatewayToolCall("tool-current"),
    );
  });

  it("drops signed-thinking turns whose sibling tool calls are dangling", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 3);
  });

  it("does not trust future tool results with the right id but the wrong tool name", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: makeSignedThinkingGatewayToolCall("tool-1"),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "exec",
        content: [{ type: "text", text: "wrong tool" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expectAssistantToolCallsOmitted(result, 4);
  });

  it("drops redacted-thinking turns whose sibling tool calls are dangling", () => {
    const msgs = asMessages([
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "blob", thinkingSignature: "sig_1" },
          { type: "toolUse", id: "tool-1", name: "gateway", arguments: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const result = validateAnthropicTurns(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = (result[1] as { content?: unknown[] }).content;
    expect(assistantContent).toEqual([{ type: "text", text: "[tool calls omitted]" }]);
  });

  it("is replay-safe across repeated validation passes", () => {
    const msgs = makeDualToolAnthropicTurns([
      {
        type: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Result 1" }],
      },
    ]);

    const firstPass = validateAnthropicTurns(msgs);
    const secondPass = validateAnthropicTurns(firstPass);

    expect(secondPass).toEqual(firstPass);
  });

  it("keeps malformed non-array assistant content in the validated turn list", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "Use tool" }] },
      {
        role: "assistant",
        content: "legacy-content",
      },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ] as unknown as AgentMessage[];

    const result = validateAnthropicTurns(msgs);
    expect(result).toHaveLength(3);
  });
});
