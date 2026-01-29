import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

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
});

import { sanitizeToolUseArgs } from "./session-transcript-repair.js";

describe("sanitizeToolUseArgs", () => {
  it("preserves valid objects in input/arguments", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "1", name: "tool", input: { key: "value" } }],
      },
    ] as any;
    const out = sanitizeToolUseArgs(input);
    expect((out[0].content[0] as any).input).toEqual({ key: "value" });
    expect(out).toBe(input); // No change, referentially equal
  });

  it("parses valid JSON strings in input", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "1", name: "tool", input: '{"key": "value"}' }],
      },
    ] as any;
    const out = sanitizeToolUseArgs(input);
    expect((out[0].content[0] as any).input).toEqual({ key: "value" });
    expect(out).not.toBe(input); // Changed
  });

  it("sanitizes invalid JSON strings in input", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "1", name: "tool", input: "{ bad json }" }],
      },
    ] as any;
    const out = sanitizeToolUseArgs(input);
    const block = out[0].content[0] as any;
    expect(block.input).toEqual({});
    expect(block._sanitized).toBe(true);
    expect(block._originalInput).toBe("{ bad json }");
  });

  it("handles 'arguments' alias", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "tool", arguments: '{"key": "val"}' }],
      },
    ] as any;
    const out = sanitizeToolUseArgs(input);
    const block = out[0].content[0] as any;
    expect(block.arguments).toEqual({ key: "val" });
  });

  it("sanitizes invalid JSON in 'arguments' alias", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "tool", arguments: "bad" }],
      },
    ] as any;
    const out = sanitizeToolUseArgs(input);
    const block = out[0].content[0] as any;
    expect(block.arguments).toEqual({});
    expect(block._sanitized).toBe(true);
  });
});
