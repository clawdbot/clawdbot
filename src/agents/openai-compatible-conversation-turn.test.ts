// Verifies OpenAI-compatible payloads contain at least one sendable conversation turn.
import { describe, expect, it } from "vitest";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";

describe("hasOpenAICompatibleConversationTurn", () => {
  it("rejects missing, system-only, and tool-only payloads", () => {
    expect(hasOpenAICompatibleConversationTurn(undefined)).toBe(false);
    expect(hasOpenAICompatibleConversationTurn([{ role: "system", content: "policy" }])).toBe(
      false,
    );
    expect(
      hasOpenAICompatibleConversationTurn([
        { role: "system", content: "policy" },
        { role: "tool", content: "tool output", tool_call_id: "call_1" },
      ]),
    ).toBe(false);
  });

  it("rejects empty user and assistant placeholders", () => {
    expect(hasOpenAICompatibleConversationTurn([{ role: "user", content: "" }])).toBe(false);
    expect(hasOpenAICompatibleConversationTurn([{ role: "user", content: "   " }])).toBe(false);
    expect(hasOpenAICompatibleConversationTurn([{ role: "assistant", content: null }])).toBe(false);
    expect(hasOpenAICompatibleConversationTurn([{ role: "assistant", content: [] }])).toBe(false);
  });

  it("accepts non-empty user and assistant content", () => {
    expect(hasOpenAICompatibleConversationTurn([{ role: "user", content: "hello" }])).toBe(true);
    expect(
      hasOpenAICompatibleConversationTurn([
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]),
    ).toBe(true);
    expect(
      hasOpenAICompatibleConversationTurn([
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png" } }] },
      ]),
    ).toBe(true);
    expect(hasOpenAICompatibleConversationTurn([{ role: "assistant", content: "answer" }])).toBe(
      true,
    );
  });

  it("accepts assistant tool calls even when assistant content is empty", () => {
    // Tool-call turns are sendable even when visible assistant text is absent.
    expect(
      hasOpenAICompatibleConversationTurn([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "status" } }],
        },
      ]),
    ).toBe(true);
  });
});
