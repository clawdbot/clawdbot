// Covers the chat.history final byte-budget fallback, including the sentinel
// that prevents an empty (blank) transcript from being returned to the dashboard.
import { describe, expect, it } from "vitest";
import { enforceChatHistoryFinalBudget } from "./chat-history-budget.js";

type DisplayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function firstText(messages: unknown[]): string {
  const msg = messages[0] as DisplayMessage | undefined;
  return msg?.content?.[0]?.text ?? "";
}

describe("enforceChatHistoryFinalBudget", () => {
  it("passes through history that already fits the budget", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = enforceChatHistoryFinalBudget({ messages, maxBytes: 1_000_000 });
    expect(result.messages).toEqual(messages);
  });

  it("returns the empty array unchanged for empty input", () => {
    const result = enforceChatHistoryFinalBudget({ messages: [], maxBytes: 10 });
    expect(result.messages).toEqual([]);
  });

  it("keeps just the last message when the full set is over budget but the last fits", () => {
    const big = { role: "user", content: [{ type: "text", text: "x".repeat(4000) }] };
    const last = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result = enforceChatHistoryFinalBudget({ messages: [big, last], maxBytes: 2_000 });
    // The same last-message reference survives so callers can detect which
    // originals were omitted by identity.
    expect(result.messages).toEqual([last]);
    expect(result.messages[0]).toBe(last);
  });

  it("falls back to a small placeholder when even the last message is too large", () => {
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7, turnBoundary: true },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [last], maxBytes: 2_000 });
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history omitted: message too large");
    expect(
      (result.messages[0] as { __openclaw?: { turnBoundary?: boolean } })["__openclaw"]
        ?.turnBoundary,
    ).toBe(true);
    // The placeholder is a new object, not the oversized original.
    expect(result.messages[0]).not.toBe(last);
  });

  it("returns a metadata-free sentinel (never an empty transcript) when even the placeholder is over budget", () => {
    // A pathological message whose oversized-placeholder copy is itself too
    // large because it carries very large transcript metadata.
    const hugeId = "z".repeat(4000);
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      __openclaw: { id: hugeId, seq: 1 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [message], maxBytes: 1_000 });

    // The critical guarantee: the dashboard never receives an empty history.
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history unavailable");
    // The sentinel does not carry the oversized source metadata.
    expect((result.messages[0] as Record<string, unknown>)["__openclaw"]).toBeUndefined();
  });
});
