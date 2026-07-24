// Covers limiting persisted history by recent user turns.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  isWithinRetainedCompactionRange,
  rebindCompactionBoundaryMessages,
  resolveCompactionBoundary,
} from "./compaction-boundary.js";
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

  it("does not classify a fresh response as retained after history limiting", () => {
    const retainedBoundary = Symbol.for("openclaw.compactionRetainedBoundary");
    const boundaryId = "compaction-1";
    const markRetained = (message: AgentMessage): AgentMessage => {
      const marked = { ...message } as AgentMessage & { [retainedBoundary]?: string };
      Object.defineProperty(marked, retainedBoundary, {
        enumerable: true,
        value: boundaryId,
      });
      return marked;
    };
    const compactionSummary = markRetained({
      role: "compactionSummary",
      summary: "Previous conversation",
      tokensBefore: 5000,
      retainedMessageCount: 4,
    } as AgentMessage);
    const retained = makeMessages(["user", "assistant", "user", "assistant"]).map(markRetained);
    const currentTurn = makeMessages(["user", "assistant"]);

    const limited = limitHistoryTurns([compactionSummary, ...retained, ...currentTurn], 1).map(
      (message) => Object.assign({}, message) as AgentMessage,
    );
    const freshPrompt = userMessage("fresh prompt");
    const freshAssistant = assistantTextMessage("fresh response");
    const runtimeMessages = [...limited, freshPrompt, freshAssistant];
    const boundary = expectDefined(
      resolveCompactionBoundary(runtimeMessages),
      "compaction boundary test invariant",
    );

    expect(limited.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
    ]);
    expect(boundary.retainedStartIndex).toBe(1);
    expect(boundary.retainedEndIndex).toBe(1);
    expect(isWithinRetainedCompactionRange(boundary, runtimeMessages.indexOf(freshAssistant))).toBe(
      false,
    );
  });

  it("rebinds retained identity after a structured context-engine clone", () => {
    const retainedBoundary = Symbol.for("openclaw.compactionRetainedBoundary");
    const boundaryId = "compaction-structured-clone";
    let sourceEntryCounter = 0;
    const markRetained = (message: AgentMessage): AgentMessage => {
      const marked = { ...message } as AgentMessage & { [retainedBoundary]?: string };
      Object.defineProperty(marked, retainedBoundary, {
        enumerable: true,
        value: boundaryId,
      });
      Object.defineProperty(marked, "__openclawCompactionSourceEntryId", {
        enumerable: true,
        value: `entry-${sourceEntryCounter++}`,
      });
      return marked;
    };
    const summary = markRetained({
      role: "compactionSummary",
      summary: "Previous conversation",
      tokensBefore: 5000,
      retainedMessageCount: 4,
    } as AgentMessage);
    const retained = makeMessages(["user", "assistant", "user", "assistant"]).map(markRetained);
    const currentTurn = makeMessages(["user", "assistant"]);
    const limited = limitHistoryTurns([summary, ...retained, ...currentTurn], 1);
    const cloned = structuredClone(limited) as AgentMessage[];
    const rebound = rebindCompactionBoundaryMessages(limited, cloned);
    const freshAssistant = assistantTextMessage("fresh response");
    const runtimeMessages = [...rebound, userMessage("fresh prompt"), freshAssistant];
    const boundary = expectDefined(
      resolveCompactionBoundary(runtimeMessages),
      "structured clone compaction boundary test invariant",
    );

    expect(boundary.retainedStartIndex).toBe(1);
    expect(boundary.retainedEndIndex).toBe(1);
    expect(isWithinRetainedCompactionRange(boundary, runtimeMessages.indexOf(freshAssistant))).toBe(
      false,
    );
  });

  it("does not bind a post-compaction duplicate to a retained source message", () => {
    const retainedBoundary = Symbol.for("openclaw.compactionRetainedBoundary");
    const boundaryId = "compaction-duplicate-source";
    const sourceId = "__openclawCompactionSourceEntryId";
    const mark = (message: AgentMessage, id: string): AgentMessage => {
      const marked = { ...message } as AgentMessage & { [retainedBoundary]?: string };
      Object.defineProperty(marked, sourceId, { enumerable: true, value: id });
      if (id === "summary" || id === "retained-a") {
        Object.defineProperty(marked, retainedBoundary, {
          enumerable: true,
          value: boundaryId,
        });
      }
      return marked;
    };
    const duplicate = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 2_000,
    } as AgentMessage;
    const source = [
      mark(
        {
          role: "compactionSummary",
          summary: "Previous conversation",
          tokensBefore: 5000,
          retainedMessageCount: 1,
        } as AgentMessage,
        "summary",
      ),
      mark({ ...duplicate, timestamp: 1_000 }, "retained-a"),
      mark(duplicate, "post-b"),
    ];
    const transformed = structuredClone([source[0], source[2]]) as AgentMessage[];

    const rebound = rebindCompactionBoundaryMessages(source, transformed);

    expect((rebound[1] as unknown as Record<string, unknown>)[sourceId]).toBe("post-b");
    expect(
      (rebound[1] as unknown as Record<PropertyKey, unknown>)[retainedBoundary],
    ).toBeUndefined();
    expect((rebound[0] as { retainedMessageCount?: number }).retainedMessageCount).toBe(0);
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

  it("preserves the reset kept-tail prelude while limiting post-boundary turns", () => {
    const prelude = makeMessages(["user", "assistant"]);
    for (const message of prelude) {
      Object.defineProperty(message, Symbol.for("openclaw.sessionHistoryPrelude"), {
        enumerable: false,
        value: true,
      });
    }
    const messages = [...prelude, ...makeMessages(["user", "assistant", "user", "assistant"])];

    const limited = limitHistoryTurns(messages, 1);

    expect(limited).toHaveLength(4);
    expect(firstText(expectDefined(limited[0], "limited[0] test invariant"))).toBe("message 0");
    expect(firstText(expectDefined(limited[2], "limited[2] test invariant"))).toBe("message 2");
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
