import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
  isValidCloudCodeAssistToolId,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  it("is a no-op for already-valid non-colliding IDs", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolCallIdsForCloudCodeAssist(input);
    expect(out).toBe(input);
  });

  it("avoids collisions when sanitization would produce duplicate IDs", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a|b", name: "read", arguments: {} },
          { type: "toolCall", id: "call_a:b", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_a|b",
        toolName: "read",
        content: [{ type: "text", text: "one" }],
      },
      {
        role: "toolResult",
        toolCallId: "call_a:b",
        toolName: "read",
        content: [{ type: "text", text: "two" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolCallIdsForCloudCodeAssist(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const a = assistant.content?.[0] as { id?: string };
    const b = assistant.content?.[1] as { id?: string };
    expect(typeof a.id).toBe("string");
    expect(typeof b.id).toBe("string");
    expect(a.id).not.toBe(b.id);
    expect(isValidCloudCodeAssistToolId(a.id as string)).toBe(true);
    expect(isValidCloudCodeAssistToolId(b.id as string)).toBe(true);

    const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
    const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(r1.toolCallId).toBe(a.id);
    expect(r2.toolCallId).toBe(b.id);
  });

  it("caps tool call IDs at 40 chars while preserving uniqueness", () => {
    const longA = `call_${"a".repeat(60)}`;
    const longB = `call_${"a".repeat(59)}b`;
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: longA, name: "read", arguments: {} },
          { type: "toolCall", id: longB, name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: longA,
        toolName: "read",
        content: [{ type: "text", text: "one" }],
      },
      {
        role: "toolResult",
        toolCallId: longB,
        toolName: "read",
        content: [{ type: "text", text: "two" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolCallIdsForCloudCodeAssist(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const a = assistant.content?.[0] as { id?: string };
    const b = assistant.content?.[1] as { id?: string };

    expect(typeof a.id).toBe("string");
    expect(typeof b.id).toBe("string");
    expect(a.id).not.toBe(b.id);
    expect(a.id?.length).toBeLessThanOrEqual(40);
    expect(b.id?.length).toBeLessThanOrEqual(40);
    expect(isValidCloudCodeAssistToolId(a.id as string)).toBe(true);
    expect(isValidCloudCodeAssistToolId(b.id as string)).toBe(true);

    const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
    const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(r1.toolCallId).toBe(a.id);
    expect(r2.toolCallId).toBe(b.id);
  });
});
