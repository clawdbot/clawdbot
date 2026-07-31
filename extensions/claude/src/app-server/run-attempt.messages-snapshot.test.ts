import { describe, expect, it } from "vitest";
import { buildMessagesSnapshot } from "./run-attempt.js";

describe("buildMessagesSnapshot", () => {
  it("stamps assistant messages with the actual provider/model, not a hardcoded anthropic default", () => {
    const acc = {
      assistantTexts: ["hi there"],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map(),
      usage: { input: 10, output: 5, total: 15 },
    };
    const messages = buildMessagesSnapshot(acc, { provider: "zai", model: "glm-5.2" });
    expect(messages).toHaveLength(1);
    const assistant = messages[0] as unknown as { provider: string; model: string };
    expect(assistant.provider).toBe("zai");
    expect(assistant.model).toBe("glm-5.2");
  });

  it("stamps tool-call/tool-result assistant messages with the actual provider/model", () => {
    const acc = {
      assistantTexts: [],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map([
        ["item-1", { name: "Read", args: { path: "/tmp/x" }, result: "contents", isError: false }],
      ]),
      usage: { input: 0, output: 0, total: 0 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(messages).toHaveLength(2);
    const toolCallAssistant = messages[0] as unknown as { provider: string; model: string };
    expect(toolCallAssistant.provider).toBe("anthropic");
    expect(toolCallAssistant.model).toBe("claude-sonnet-5");
  });

  it("assigns strictly increasing timestamps so the final reply sorts after its tool calls (C2)", () => {
    const acc = {
      assistantTexts: ["final answer"],
      toolMetas: [],
      reasoning: "",
      itemCount: 3,
      toolCalls: new Map([
        ["item-1", { name: "Read", args: {}, result: "a", isError: false }],
        ["item-2", { name: "Bash", args: {}, result: "b", isError: false }],
      ]),
      usage: { input: 0, output: 0, total: 0 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    // 2 tool calls → 2 (assistant + toolResult) pairs = 4 messages, + 1 final = 5.
    expect(messages).toHaveLength(5);
    const stamps = messages.map((m) => (m as unknown as { timestamp: number }).timestamp);
    for (let i = 1; i < stamps.length; i += 1) {
      // `?? Infinity` keeps a missing element failing the assertion rather than
      // silently passing, now that index access is checked.
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1] ?? Number.POSITIVE_INFINITY);
    }
    // The final assistant message must carry the largest timestamp — the bug
    // was it carrying the smallest (`now`) while tool messages carried `now+n`.
    const finalTimestamp = stamps[stamps.length - 1];
    expect(Math.max(...stamps)).toBe(finalTimestamp);
  });

  it("stamps the final assistant message with the captured stop reason (C3)", () => {
    const acc = {
      assistantTexts: ["interrupted mid-thought"],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map(),
      usage: { input: 0, output: 0, total: 0 },
      stopReason: "aborted" as const,
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(messages).toHaveLength(1);
    expect((messages[0] as unknown as { stopReason: string }).stopReason).toBe("aborted");
  });

  it("falls back to 'stop' for the final message when no stop reason was captured (C3)", () => {
    const acc = {
      assistantTexts: ["done"],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map(),
      usage: { input: 0, output: 0, total: 0 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect((messages[0] as unknown as { stopReason: string }).stopReason).toBe("stop");
  });

  it("keeps 'toolUse' on tool-call assistant messages regardless of the turn stop reason (C3)", () => {
    const acc = {
      assistantTexts: ["wrapped up"],
      toolMetas: [],
      reasoning: "",
      itemCount: 2,
      toolCalls: new Map([["item-1", { name: "Read", args: {}, result: "x", isError: false }]]),
      usage: { input: 0, output: 0, total: 0 },
      stopReason: "stop" as const,
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect((messages[0] as unknown as { stopReason: string }).stopReason).toBe("toolUse");
    const finalMessage = messages[messages.length - 1] as unknown as { stopReason: string };
    expect(finalMessage.stopReason).toBe("stop");
  });
});

describe("buildMessagesSnapshot thinking blocks", () => {
  it("attaches accumulated reasoning as a thinking block on the LAST assistant message", () => {
    const acc = {
      assistantTexts: ["part one", "final answer"],
      toolMetas: [],
      reasoning: "let me reason about this",
      itemCount: 2,
      toolCalls: new Map(),
      usage: { input: 10, output: 5, total: 15 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(messages).toHaveLength(2);
    const first = messages[0] as unknown as { content: Array<{ type: string }> };
    const last = messages[1] as unknown as {
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };
    // lastAssistant is what extractAssistantThinking reads for /reasoning on,
    // so the thinking block must ride the final message, not an earlier one.
    expect(first.content.map((b) => b.type)).toEqual(["text"]);
    expect(last.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(last.content[0]?.thinking).toBe("let me reason about this");
    expect(last.content[1]?.text).toBe("final answer");
  });

  it("emits text-only content when the turn carried no reasoning", () => {
    const acc = {
      assistantTexts: ["plain reply"],
      toolMetas: [],
      reasoning: "   ",
      itemCount: 1,
      toolCalls: new Map(),
      usage: { input: 0, output: 0, total: 0 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-opus-5",
    });
    const assistant = messages[0] as unknown as { content: Array<{ type: string }> };
    expect(assistant.content.map((b) => b.type)).toEqual(["text"]);
  });
});
