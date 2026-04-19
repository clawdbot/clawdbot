import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import "./test-helpers/pi-coding-agent-token-mock.js";

let estimateMessagesTokens: typeof import("./compaction.js").estimateMessagesTokens;
let pruneHistoryForContextShare: typeof import("./compaction.js").pruneHistoryForContextShare;
let splitMessagesByTokenShare: typeof import("./compaction.js").splitMessagesByTokenShare;

beforeAll(async () => {
  vi.resetModules();
  ({ estimateMessagesTokens, pruneHistoryForContextShare, splitMessagesByTokenShare } =
    await import("./compaction.js"));
});

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

function makeMessages(count: number, size: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => makeMessage(index + 1, size));
}

function compareTimestampIds(left: AgentMessage["timestamp"], right: AgentMessage["timestamp"]) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeAssistantToolCall(
  timestamp: number,
  toolCallId: string,
  text = "x".repeat(4000),
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "gpt-5.4",
    stopReason,
    timestamp,
  });
}

function makeToolResult(timestamp: number, toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function pruneLargeSimpleHistory() {
  const messages = makeMessages(4, 4000);
  const maxContextTokens = 2000; // budget is 1000 tokens (50%)
  const pruned = pruneHistoryForContextShare({
    messages,
    maxContextTokens,
    maxHistoryShare: 0.5,
    parts: 2,
  });
  return { messages, pruned, maxContextTokens };
}

describe("splitMessagesByTokenShare", () => {
  it("splits messages into two non-empty parts", () => {
    const messages = makeMessages(4, 4000);

    const parts = splitMessagesByTokenShare(messages, 2);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("preserves message order across parts", () => {
    const messages = makeMessages(6, 4000);

    const parts = splitMessagesByTokenShare(messages, 3);
    expect(parts.flat().map((msg) => msg.timestamp)).toEqual(messages.map((msg) => msg.timestamp));
  });

  it("keeps tool_use and matching toolResult in the same chunk", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeToolResult(3, "call_split", "r".repeat(800)),
      makeMessage(4, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    );
    const chunkWithToolResult = parts.find((chunk) =>
      chunk.some((m) => m.role === "toolResult" && m.timestamp === 3),
    );
    expect(chunkWithToolUse).toBeDefined();
    expect(chunkWithToolResult).toBeDefined();
    expect(chunkWithToolUse).toBe(chunkWithToolResult);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps multiple toolResults with their assistant in the same chunk", () => {
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "text", text: "x".repeat(4000) },
        { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
        { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
      ],
      model: "gpt-5.2",
      stopReason: "stop",
      timestamp: 2,
    });

    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      assistant,
      makeToolResult(3, "call_a", "result_a".repeat(200)),
      makeToolResult(4, "call_b", "result_b".repeat(200)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithAssistant = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    )!;
    const resultTimestamps = chunkWithAssistant
      .filter((m) => m.role === "toolResult")
      .map((m) => m.timestamp);
    expect(resultTimestamps).toContain(3);
    expect(resultTimestamps).toContain(4);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps displaced toolResults with their assistant chunk", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeMessage(3, 800),
      makeToolResult(4, "call_split", "r".repeat(800)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    );
    const chunkWithToolResult = parts.find((chunk) =>
      chunk.some((m) => m.role === "toolResult" && m.timestamp === 4),
    );

    expect(chunkWithToolUse).toBeDefined();
    expect(chunkWithToolUse).toBe(chunkWithToolResult);
  });

  it("splits after a completed tool_call/result pair when over budget", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_x", "y".repeat(4000)),
      makeToolResult(2, "call_x", "r".repeat(4000)),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    const chunk1Roles = parts[0].map((m) => m.role);
    expect(chunk1Roles).toContain("assistant");
    expect(chunk1Roles).toContain("toolResult");
    expect(parts.flat().length).toBe(messages.length);
  });

  it("splits before a trailing completed tool-call pair", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_tail", "y".repeat(200)),
      makeToolResult(3, "call_tail", "r".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });

  it("does not block splits after aborted tool-call assistants", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_abort", "y".repeat(4000), "aborted"),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("splits before unfinished tool-call turns that never get a result", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_missing"),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });
});

describe("pruneHistoryForContextShare", () => {
  it("drops older chunks until the history budget is met", () => {
    const { pruned, maxContextTokens } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.keptTokens).toBeLessThanOrEqual(Math.floor(maxContextTokens * 0.5));
    expect(pruned.messages.length).toBeGreaterThan(0);
  });

  it("keeps the newest messages when pruning", () => {
    const messages = makeMessages(6, 4000);
    const totalTokens = estimateMessagesTokens(messages);
    const maxContextTokens = Math.max(1, Math.floor(totalTokens * 0.5)); // budget = 25%
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptIds = pruned.messages.map((msg) => msg.timestamp);
    const expectedSuffix = messages.slice(-keptIds.length).map((msg) => msg.timestamp);
    expect(keptIds).toEqual(expectedSuffix);
  });

  it("keeps history when already within budget", () => {
    const messages: AgentMessage[] = [makeMessage(1, 1000)];
    const maxContextTokens = 2000;
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.messages.length).toBe(messages.length);
    expect(pruned.keptTokens).toBe(estimateMessagesTokens(messages));
    expect(pruned.droppedMessagesList).toEqual([]);
  });

  it("returns droppedMessagesList containing dropped messages", () => {
    const { messages, pruned } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.droppedMessagesList.length).toBe(pruned.droppedMessages);

    const allIds = [
      ...pruned.droppedMessagesList.map((m) => m.timestamp),
      ...pruned.messages.map((m) => m.timestamp),
    ].toSorted(compareTimestampIds);
    const originalIds = messages.map((m) => m.timestamp).toSorted(compareTimestampIds);
    expect(allIds).toEqual(originalIds);
  });

  it("returns empty droppedMessagesList when no pruning needed", () => {
    const messages: AgentMessage[] = [makeMessage(1, 100)];
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.droppedMessagesList).toEqual([]);
    expect(pruned.messages.length).toBe(1);
  });

  it("removes orphaned tool_result messages when tool_use is dropped", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_123"),
      makeToolResult(2, "call_123", "result".repeat(500)),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 3,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).not.toContain("toolResult");
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });

  it("keeps tool_result when its tool_use is also kept", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      makeAssistantToolCall(2, "call_456", "y".repeat(500)),
      makeToolResult(3, "call_456", "result"),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).toContain("assistant");
    expect(keptRoles).toContain("toolResult");
  });

  it("removes multiple orphaned tool_results from the same dropped tool_use", () => {
    const messages: AgentMessage[] = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
        ],
        model: "gpt-5.4",
        stopReason: "stop",
        timestamp: 1,
      }),
      makeToolResult(2, "call_a", "result_a"),
      makeToolResult(3, "call_b", "result_b"),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 4,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });
});
