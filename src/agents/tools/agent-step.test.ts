import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { readLatestAssistantReply } from "./agent-step.js";
import { hasAssistantToolCalls } from "./sessions-helpers.js";

describe("hasAssistantToolCalls", () => {
  it("detects content-array toolCall blocks", () => {
    expect(
      hasAssistantToolCalls({
        role: "assistant",
        content: [
          { type: "text", text: "progress" },
          { type: "toolCall", id: "call-1", name: "read" },
        ],
      }),
    ).toBe(true);
  });

  it.each(["tool_use", "toolUse", "functionCall", "function_call"])(
    "detects content-array %s blocks",
    (type) => {
      expect(
        hasAssistantToolCalls({
          role: "assistant",
          content: [{ type, name: "read" }],
        }),
      ).toBe(true);
    },
  );

  it("detects top-level toolCalls array", () => {
    expect(
      hasAssistantToolCalls({
        role: "assistant",
        content: "progress text",
        toolCalls: [{ name: "read" }],
      }),
    ).toBe(true);
  });

  it("detects top-level tool_calls array", () => {
    expect(
      hasAssistantToolCalls({
        role: "assistant",
        content: "progress text",
        tool_calls: [{ type: "function", function: { name: "read" } }],
      }),
    ).toBe(true);
  });

  it("returns false for text-only assistant messages", () => {
    expect(
      hasAssistantToolCalls({
        role: "assistant",
        content: [{ type: "text", text: "final output" }],
      }),
    ).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(hasAssistantToolCalls({ role: "assistant", content: [] })).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(hasAssistantToolCalls(null)).toBe(false);
    expect(hasAssistantToolCalls(undefined)).toBe(false);
    expect(hasAssistantToolCalls("string")).toBe(false);
  });
});

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed and changes were pushed." }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("skips tool-use turns when skipToolUseTurns is true", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "final completed output" }],
        },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Let me look into that." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", content: "file contents" },
      ],
    });

    const result = await readLatestAssistantReply({
      sessionKey: "agent:main:child",
      skipToolUseTurns: true,
    });

    expect(result).toBe("final completed output");
  });

  it("returns tool-use turn text when skipToolUseTurns is not set", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Let me look into that." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", content: "file contents" },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Let me look into that.");
  });

  it("returns undefined when only tool-use turns exist and skipToolUseTurns is true", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "progress commentary" },
            { type: "toolCall", id: "call-1", name: "exec", arguments: {} },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({
      sessionKey: "agent:main:child",
      skipToolUseTurns: true,
    });

    expect(result).toBeUndefined();
  });
});
