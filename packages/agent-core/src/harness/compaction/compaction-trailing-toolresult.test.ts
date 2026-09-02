import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";

const KEEP_RECENT_TOKENS = 20000;
const LARGE_TOOL_OUTPUT = "x".repeat(120000);

function userText(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function toolResultText(text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function nestedToolResult(
  block: { type: string; content?: unknown; text?: string },
  timestamp: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "codex_progress",
    content: [
      {
        id: "call-1",
        toolUseId: "call-1",
        ...block,
      },
    ],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

function messageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function buildTranscript(): SessionTreeEntry[] {
  return buildTranscriptWithToolResult(toolResultText(LARGE_TOOL_OUTPUT, 5));
}

function buildTranscriptWithToolResult(toolResult: AgentMessage): SessionTreeEntry[] {
  const messages: AgentMessage[] = [
    userText("start of the conversation", 1),
    assistantText("first reply", 2),
    userText("please run the command", 3),
    assistantText("running it now", 4),
    toolResult,
  ];
  return messages.map((message, index) => messageEntry(message, index));
}

describe("findCutPoint with a trailing oversized tool result", () => {
  it("counts the final tool result as larger than the keep budget", () => {
    const trailing = toolResultText(LARGE_TOOL_OUTPUT, 5);

    expect(estimateTokens(trailing)).toBeGreaterThanOrEqual(KEEP_RECENT_TOKENS);
  });

  it("trims the prefix instead of keeping the whole transcript", () => {
    const entries = buildTranscript();

    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(result.firstKeptEntryIndex).toBe(3);
  });

  it.each([
    {
      name: "Codex toolResult text",
      block: { type: "toolResult", content: "duplicate", text: LARGE_TOOL_OUTPUT },
    },
    {
      name: "snake-case tool_result content",
      block: { type: "tool_result", content: LARGE_TOOL_OUTPUT },
    },
  ])("counts and trims the prefix for $name", ({ block }) => {
    const trailing = nestedToolResult(block, 5);
    const entries = buildTranscriptWithToolResult(trailing);

    expect(estimateTokens(trailing)).toBeGreaterThanOrEqual(KEEP_RECENT_TOKENS);
    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(result.firstKeptEntryIndex).toBe(3);
  });
});
