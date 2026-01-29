import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { isIncompleteToolCall, sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

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

  it("skips incomplete tool calls (partialJson, no arguments) and drops their synthetic results", () => {
    // Simulates a terminated streaming response: the assistant message has a
    // tool call with partialJson but no arguments, followed by a synthetic
    // error toolResult inserted by session persistence.  The repair must skip
    // the incomplete tool call entirely so no synthetic result is emitted, and
    // the orphaned synthetic result is dropped.
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me write that file:" },
          {
            type: "toolCall",
            id: "toolu_terminated",
            name: "write",
            partialJson: '{"path": "/tmp/test.md", "content": "# Hello',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_terminated",
        toolName: "write",
        content: [
          {
            type: "text",
            text: "[moltbot] missing tool result in session history; inserted synthetic error result for transcript repair.",
          },
        ],
        isError: true,
      },
      { role: "user", content: "what happened?" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    // The incomplete tool call should be treated as having zero tool calls,
    // so no toolResult should appear in the output.
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("keeps complete tool calls even when partialJson is present", () => {
    // A tool call that completed successfully may still carry partialJson
    // from the streaming buffer.  It must be treated normally.
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_ok",
            name: "read",
            arguments: { path: "/tmp/test.md" },
            partialJson: '{"path": "/tmp/test.md"}',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_ok",
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

  it("handles mixed complete and incomplete tool calls in one assistant message", () => {
    // The assistant issued two parallel tool calls but was terminated during
    // the second.  The first call completed and has a real result; the second
    // is incomplete.  Only the first should be paired.
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_done", name: "read", arguments: { path: "/a" } },
          {
            type: "toolCall",
            id: "call_partial",
            name: "write",
            partialJson: '{"path": "/b", "content": "half...',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_done",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_partial",
        toolName: "write",
        content: [{ type: "text", text: "[moltbot] synthetic" }],
        isError: true,
      },
      { role: "user", content: "continue" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult");
    // Only the completed tool call should have a result
    expect(results).toHaveLength(1);
    expect((results[0] as { toolCallId?: string }).toolCallId).toBe("call_done");
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
  });

  it("handles incomplete tool call with empty arguments object", () => {
    // Some providers set arguments to {} when the stream was interrupted
    // before any argument parsing completed.
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_empty_args",
            name: "exec",
            arguments: {},
            partialJson: '{"command": "ls',
          },
        ],
      },
      { role: "user", content: "?" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });
});

describe("isIncompleteToolCall", () => {
  it("returns true for partialJson with no arguments", () => {
    expect(
      isIncompleteToolCall({
        type: "toolCall",
        id: "x",
        name: "write",
        partialJson: '{"path": "/tmp',
      }),
    ).toBe(true);
  });

  it("returns true for partialJson with empty arguments", () => {
    expect(
      isIncompleteToolCall({
        type: "toolCall",
        id: "x",
        name: "exec",
        arguments: {},
        partialJson: '{"command": "ls',
      }),
    ).toBe(true);
  });

  it("returns false for complete tool call with partialJson", () => {
    expect(
      isIncompleteToolCall({
        type: "toolCall",
        id: "x",
        name: "read",
        arguments: { path: "/tmp/test" },
        partialJson: '{"path": "/tmp/test"}',
      }),
    ).toBe(false);
  });

  it("returns false for tool call without partialJson", () => {
    expect(
      isIncompleteToolCall({
        type: "toolCall",
        id: "x",
        name: "read",
        arguments: { path: "/tmp/test" },
      }),
    ).toBe(false);
  });

  it("returns false when partialJson is empty string", () => {
    expect(
      isIncompleteToolCall({
        type: "toolCall",
        id: "x",
        name: "read",
        partialJson: "",
      }),
    ).toBe(false);
  });
});
