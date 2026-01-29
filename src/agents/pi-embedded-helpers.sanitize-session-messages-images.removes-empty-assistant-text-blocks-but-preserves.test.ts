import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeSessionMessagesImages } from "./pi-embedded-helpers.js";

describe("sanitizeSessionMessagesImages", () => {
  it("removes empty assistant text blocks but preserves tool calls", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect((content as Array<{ type?: string }>)[0]?.type).toBe("toolCall");
  });

  it("sanitizes tool ids in strict mode (alphanumeric only)", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_abc|item:123", name: "test", input: {} },
          {
            type: "toolCall",
            id: "call_abc|item:456",
            name: "exec",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "call_abc|item:123",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    const assistant = out[0] as { content?: Array<{ id?: string }> };
    expect(assistant.content?.[0]?.id).toBe("callabcitem123");
    expect(assistant.content?.[1]?.id).toBe("callabcitem456");

    const toolResult = out[1] as { toolUseId?: string };
    expect(toolResult.toolUseId).toBe("callabcitem123");
  });
  it("filters whitespace-only assistant text blocks", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "ok" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect((content as Array<{ text?: string }>)[0]?.text).toBe("ok");
  });
  it("drops assistant messages that only contain empty text", async () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
  it("keeps empty assistant error messages", async () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", stopReason: "error", content: [] },
      { role: "assistant", stopReason: "error" },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect(out[2]?.role).toBe("assistant");
  });
  it("leaves non-assistant messages unchanged", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "result" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("toolResult");
  });

  it("adds missing arguments field to tool calls", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "session_status" }, // Missing arguments!
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content as Array<{
      type?: string;
      arguments?: unknown;
    }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("toolCall");
    expect(content[0]?.arguments).toEqual({});
  });

  it("adds missing input field to toolUse blocks", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_1", name: "session_status" }, // Missing input!
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content as Array<{
      type?: string;
      input?: unknown;
    }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("toolUse");
    expect(content[0]?.input).toEqual({});
  });
});
