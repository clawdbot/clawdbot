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
  it("synthesizes tool call arguments when missing (API requires it)", async () => {
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
    // API requires arguments field to be present (even if empty)
    expect("arguments" in (toolCall ?? {})).toBe(true);
    expect(toolCall?.arguments).toEqual({});
  });
});
