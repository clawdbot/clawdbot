import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolUseResultPairing,
  sanitizePartialToolCalls,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
      },
      { role: "user", content: "ok" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("removes incomplete tool calls with partialJson and drops their orphaned results", () => {
    // This simulates a terminated request where tool call was incomplete
    // Note: arguments is undefined/missing when truly incomplete
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me write that file:" },
          {
            type: "toolCall",
            id: "call_incomplete",
            name: "write",
            // arguments is missing - only partialJson exists
            partialJson: '{"path": "/tmp/test.md", "content": "# Hello',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_incomplete",
        toolName: "write",
        content: [{ type: "text", text: "[clawdbot] synthetic error result" }],
        isError: true,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    // The incomplete tool call should be removed from content
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toEqual({ type: "text", text: "Let me write that file:" });
    // The orphaned tool result should also be dropped
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(0);
  });

  it("keeps complete tool calls even if partialJson was captured", () => {
    // If arguments is complete, the tool call should be kept
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_complete",
            name: "read",
            arguments: { path: "/tmp/test.md" },
            partialJson: '{"path": "/tmp/test.md"}', // partialJson exists but args complete
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_complete",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
  });
});

describe("sanitizePartialToolCalls", () => {
  it("removes tool calls with partialJson but no arguments", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it" },
          {
            type: "toolCall",
            id: "call_1",
            name: "write",
            partialJson: '{"path": "/tmp/file.md", "content": "partial...',
          },
        ],
      },
    ] satisfies AgentMessage[];

    const out = sanitizePartialToolCalls(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(1);
    expect((assistant.content[0] as { type: string }).type).toBe("text");
  });

  it("removes tool calls with partialJson and empty arguments", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "write",
            arguments: {},
            partialJson: '{"path": "/tmp',
          },
        ],
      },
    ] satisfies AgentMessage[];

    const out = sanitizePartialToolCalls(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(0);
  });

  it("preserves complete tool calls without partialJson", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "/tmp/file.md" },
          },
        ],
      },
    ] satisfies AgentMessage[];

    const out = sanitizePartialToolCalls(input);
    expect(out).toBe(input); // Should return same reference if unchanged
  });
});
