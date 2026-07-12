// Covers limiting persisted history by recent user turns.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./embedded-agent-runner/history.js";

describe("limitHistoryTurns", () => {
  const mockUsage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  } as const;

  const userMessage = (text: string): AgentMessage =>
    ({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    }) as AgentMessage;

  const assistantTextMessage = (text: string): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: mockUsage,
      timestamp: Date.now(),
    }) as AgentMessage;

  const assistantToolCallMessage = (id: string): AgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: mockUsage,
      timestamp: Date.now(),
    }) as AgentMessage;

  const firstText = (message: AgentMessage): string | undefined => {
    // Tests only inspect visible text; helper hides provider-specific content
    // block shapes.
    if (!("content" in message)) {
      return undefined;
    }
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    const first = content[0];
    return first?.type === "text" ? first.text : undefined;
  };

  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) =>
      role === "user" ? userMessage(`message ${i}`) : assistantTextMessage(`message ${i}`),
    );

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });

  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });

  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });

  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toStrictEqual([]);
  });

  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });

  it("limits to last N user turns", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(4);
    expect(firstText(expectDefined(limited[0], "limited[0] test invariant"))).toBe("message 2");
  });

  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(firstText(expectDefined(limited[0], "limited[0] test invariant"))).toBe("message 4");
    expect(firstText(expectDefined(limited[1], "limited[1] test invariant"))).toBe("message 5");
  });

  it("handles messages with multiple assistant responses per user turn", () => {
    // The limit is counted by user turns, so only the assistant tail attached to
    // the kept user turn should remain.
    const messages = makeMessages(["user", "assistant", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(expectDefined(limited[0], "limited[0] test invariant").role).toBe("user");
    expect(expectDefined(limited[1], "limited[1] test invariant").role).toBe("assistant");
  });

  it("preserves leading compactionSummary when limiting", () => {
    const compactionSummary: AgentMessage = {
      role: "compactionSummary",
      summary: "Previous conversation about topic X",
      tokensBefore: 5000,
      tokensAfter: 2000,
      timestamp: Date.now(),
    } as AgentMessage;
    const messages = [
      compactionSummary,
      ...makeMessages(["user", "assistant", "user", "assistant"]),
    ];
    const limited = limitHistoryTurns(messages, 1);
    // compactionSummary is preserved, last 1 user turn + assistant kept
    expect(limited.length).toBe(3);
    expect(expectDefined(limited[0], "limited[0] test invariant").role).toBe("compactionSummary");
    expect(firstText(expectDefined(limited[1], "limited[1] test invariant"))).toBe("message 2");
  });

  it("preserves leading branchSummary when limiting", () => {
    const branchSummary: AgentMessage = {
      role: "branchSummary",
      summary: "Branch context",
      fromId: "abc",
      timestamp: Date.now(),
    } as AgentMessage;
    const messages = [branchSummary, ...makeMessages(["user", "assistant", "user", "assistant"])];
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(3);
    expect(expectDefined(limited[0], "limited[0] test invariant").role).toBe("branchSummary");
  });

  it("returns all when only non-conversation messages exist", () => {
    const compactionSummary: AgentMessage = {
      role: "compactionSummary",
      summary: "Summary only",
      tokensBefore: 1000,
      timestamp: Date.now(),
    } as AgentMessage;
    const limited = limitHistoryTurns([compactionSummary], 2);
    expect(limited).toHaveLength(1);
    expect(expectDefined(limited[0], "limited[0] test invariant").role).toBe("compactionSummary");
  });

  it("preserves message content integrity", () => {
    // Limiting should slice whole turns, not mutate tool calls or message bodies.
    const messages: AgentMessage[] = [
      userMessage("first"),
      assistantToolCallMessage("1"),
      userMessage("second"),
      assistantTextMessage("response"),
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(firstText(expectDefined(limited[0], "limited[0] test invariant"))).toBe("second");
    expect(firstText(expectDefined(limited[1], "limited[1] test invariant"))).toBe("response");
  });
});
