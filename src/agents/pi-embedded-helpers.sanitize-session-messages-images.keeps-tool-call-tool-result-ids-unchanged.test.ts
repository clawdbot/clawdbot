import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeSessionMessagesImages } from "./pi-embedded-helpers.js";

describe("sanitizeSessionMessagesImages", () => {
  it("keeps tool call + tool result IDs unchanged by default", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123|fc_456",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    const assistant = out[0] as unknown as { role?: string; content?: unknown };
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const toolCall = (assistant.content as Array<{ type?: string; id?: string }>).find(
      (b) => b.type === "toolCall",
    );
    expect(toolCall?.id).toBe("call_123|fc_456");

    const toolResult = out[1] as unknown as {
      role?: string;
      toolCallId?: string;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_123|fc_456");
  });

  it("sanitizes tool call + tool result IDs in standard mode (preserves underscores)", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123|fc_456",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
    });

    const assistant = out[0] as unknown as { role?: string; content?: unknown };
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const toolCall = (assistant.content as Array<{ type?: string; id?: string }>).find(
      (b) => b.type === "toolCall",
    );
    // Standard mode preserves underscores for readability, replaces invalid chars
    expect(toolCall?.id).toBe("call_123_fc_456");

    const toolResult = out[1] as unknown as {
      role?: string;
      toolCallId?: string;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_123_fc_456");
  });

  it("sanitizes tool call + tool result IDs in strict mode (alphanumeric only)", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123|fc_456",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    const assistant = out[0] as unknown as { role?: string; content?: unknown };
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const toolCall = (assistant.content as Array<{ type?: string; id?: string }>).find(
      (b) => b.type === "toolCall",
    );
    // Strict mode strips all non-alphanumeric characters
    expect(toolCall?.id).toBe("call123fc456");

    const toolResult = out[1] as unknown as {
      role?: string;
      toolCallId?: string;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call123fc456");
  });
  it("drops assistant blocks after a tool call when enforceToolCallLast is enabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "thinking", thinking: "after", thinkingSignature: "sig" },
          { type: "text", text: "after text" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      enforceToolCallLast: true,
    });
    const assistant = out[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((b) => b.type)).toEqual(["text", "toolCall"]);
  });
  it("keeps assistant blocks after a tool call when enforceToolCallLast is disabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "thinking", thinking: "after", thinkingSignature: "sig" },
          { type: "text", text: "after text" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((b) => b.type)).toEqual(["text", "toolCall", "thinking", "text"]);
  });

  it("does not synthesize tool call input when missing", async () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Array<Record<string, unknown>> };
    const toolCall = assistant.content?.find((b) => b.type === "toolCall");
    expect(toolCall).toBeTruthy();
    expect("input" in (toolCall ?? {})).toBe(false);
    expect("arguments" in (toolCall ?? {})).toBe(false);
  });
});
