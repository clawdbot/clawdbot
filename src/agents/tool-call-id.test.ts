import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
  isValidCloudCodeAssistToolId,
  normalizeToolCallArguments,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "./tool-call-id.js";

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  describe("strict mode (default)", () => {
    it("is a no-op for already-valid non-colliding IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).toBe(input);
    });

    it("strips non-alphanumeric characters from tool call IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call|item:123", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call|item:123",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input);
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      // Strict mode strips all non-alphanumeric characters
      expect(toolCall.id).toBe("callitem123");
      expect(isValidCloudCodeAssistToolId(toolCall.id as string, "strict")).toBe(true);

      const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(result.toolCallId).toBe(toolCall.id);
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
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);

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
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
    });
  });

  describe("strict mode (alphanumeric only)", () => {
    it("strips underscores and hyphens from tool call IDs", () => {
      const input = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "whatsapp_login_1768799841527_1",
              name: "login",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "whatsapp_login_1768799841527_1",
          toolName: "login",
          content: [{ type: "text", text: "ok" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCall = assistant.content?.[0] as { id?: string };
      // Strict mode strips all non-alphanumeric characters
      expect(toolCall.id).toBe("whatsapplogin17687998415271");
      expect(isValidCloudCodeAssistToolId(toolCall.id as string, "strict")).toBe(true);

      const result = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(result.toolCallId).toBe(toolCall.id);
    });

    it("avoids collisions with alphanumeric-only suffixes", () => {
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

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };
      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      // Both should be strictly alphanumeric
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict")).toBe(true);
      // Should not contain underscores or hyphens
      expect(a.id).not.toMatch(/[_-]/);
      expect(b.id).not.toMatch(/[_-]/);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
    });
  });

  describe("strict9 mode (Mistral tool call IDs)", () => {
    it("enforces alphanumeric IDs with length 9", () => {
      const input = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_abc|item:123", name: "read", arguments: {} },
            { type: "toolCall", id: "call_abc|item:456", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc|item:123",
          toolName: "read",
          content: [{ type: "text", text: "one" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc|item:456",
          toolName: "read",
          content: [{ type: "text", text: "two" }],
        },
      ] satisfies AgentMessage[];

      const out = sanitizeToolCallIdsForCloudCodeAssist(input, "strict9");
      expect(out).not.toBe(input);

      const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
      const a = assistant.content?.[0] as { id?: string };
      const b = assistant.content?.[1] as { id?: string };

      expect(typeof a.id).toBe("string");
      expect(typeof b.id).toBe("string");
      expect(a.id).not.toBe(b.id);
      expect(a.id?.length).toBe(9);
      expect(b.id?.length).toBe(9);
      expect(isValidCloudCodeAssistToolId(a.id as string, "strict9")).toBe(true);
      expect(isValidCloudCodeAssistToolId(b.id as string, "strict9")).toBe(true);

      const r1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const r2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;
      expect(r1.toolCallId).toBe(a.id);
      expect(r2.toolCallId).toBe(b.id);
    });
  });
});

describe("normalizeToolCallArguments", () => {
  it("is a no-op when arguments are already present", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "/tmp" } }],
      },
    ] satisfies AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).toBe(input);
  });

  it("normalizes undefined arguments to empty object", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "memory_status" }],
      },
    ] as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { arguments?: unknown };
    expect(toolCall.arguments).toEqual({});
  });

  it("normalizes null arguments to empty object", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "memory_status", arguments: null }],
      },
    ] as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { arguments?: unknown };
    expect(toolCall.arguments).toEqual({});
  });

  it("handles multiple toolCalls in single message", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call1", name: "memory_status" },
          { type: "toolCall", id: "call2", name: "read", arguments: { path: "/tmp" } },
          { type: "toolCall", id: "call3", name: "load_memory" },
        ],
      },
    ] as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const call1 = assistant.content?.[0] as { arguments?: unknown };
    const call2 = assistant.content?.[1] as { arguments?: unknown };
    const call3 = assistant.content?.[2] as { arguments?: unknown };
    expect(call1.arguments).toEqual({});
    expect(call2.arguments).toEqual({ path: "/tmp" });
    expect(call3.arguments).toEqual({});
  });

  it("handles toolUse and functionCall types", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call1", name: "status" },
          { type: "functionCall", id: "call2", name: "ping" },
        ],
      },
    ] as AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).not.toBe(input);

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const call1 = assistant.content?.[0] as { arguments?: unknown };
    const call2 = assistant.content?.[1] as { arguments?: unknown };
    expect(call1.arguments).toEqual({});
    expect(call2.arguments).toEqual({});
  });

  it("does not modify user or toolResult messages", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = normalizeToolCallArguments(input);
    expect(out).toBe(input);
  });
});
