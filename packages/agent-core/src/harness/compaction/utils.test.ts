import type { Message } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "./utils.js";

describe("serializeConversation", () => {
  it.each([
    {
      name: "Codex nested toolResult text",
      block: {
        type: "toolResult",
        id: "call-1",
        toolUseId: "call-1",
        content: "duplicate fallback",
        text: "codex nested output",
      },
      expected: "codex nested output",
    },
    {
      name: "snake-case nested tool_result content fallback",
      block: {
        type: "tool_result",
        content: "fallback output",
      },
      expected: "fallback output",
    },
  ])("serializes $name", ({ block, expected }) => {
    const messages = [
      {
        role: "toolResult",
        content: [block],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toBe(`[Tool result]: ${expected}`);
  });

  it("keeps truncated tool results UTF-16 safe and reports the exact omitted count", () => {
    const prefix = "a".repeat(1_999);
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "toolResult", content: `${prefix}🚀tail` }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toBe(
      `[Tool result]: ${prefix}\n\n[... 6 more characters truncated]`,
    );
  });

  it("preserves terminal failures when truncating long tool results", () => {
    const output = `command started\n${"progress ".repeat(450)}\nFATAL: missing deployment token`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized).toContain("command started");
    expect(serialized).toContain("FATAL: missing deployment token");
    expect(serialized).toMatch(/\[\.\.\. \d+ more characters truncated\]/);
    expect(serialized.length).toBeLessThan(2100);
  });

  it("keeps both diagnostic truncation boundaries UTF-16 safe", () => {
    const output = `${"h".repeat(1399)}🚀${"m".repeat(1600)}🚀\nERROR: failed safely`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    const serialized = serializeConversation(messages);

    expect(serialized).toContain("ERROR: failed safely");
    expect(serialized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(serialized).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("retains earlier diagnostics when they are outside the preserved tail", () => {
    const output = `${"h".repeat(1500)}ERROR: earlier failure${"m".repeat(1500)}`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toContain("ERROR: earlier failure");
  });

  it("does not let routine completion output evict an earlier failure", () => {
    const output = `${"h".repeat(1500)}ERROR: deployment failed${"m".repeat(1500)}\ndone`;
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: output }],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toContain("ERROR: deployment failed");
  });
});
