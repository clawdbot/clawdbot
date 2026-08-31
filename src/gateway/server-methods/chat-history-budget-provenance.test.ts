import { describe, expect, it } from "vitest";
import { replaceOversizedChatHistoryMessages } from "./chat-history-budget.js";

describe("replaceOversizedChatHistoryMessages provenance preservation", () => {
  it("preserves minimal provenance for internal_system placeholder", () => {
    const internal = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "x".repeat(4000) }],
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      __openclaw: { id: "abc", seq: 7, turnBoundary: true },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [internal],
      maxSingleMessageBytes: 2_000,
    });
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as Record<string, unknown>).provenance).toEqual({
      kind: "internal_system",
      sourceTool: "main_session_restart_recovery",
    });
    // placeholder should still have truncated marker
    expect((result.messages[0] as { __openclaw?: { truncated?: boolean } })["__openclaw"]?.truncated).toBe(true);
  });

  it("preserves provenance without sourceTool", () => {
    const internal = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      provenance: { kind: "internal_system" },
      __openclaw: { id: "def", seq: 8 },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [internal],
      maxSingleMessageBytes: 2_000,
    });
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as Record<string, unknown>).provenance).toEqual({
      kind: "internal_system",
    });
  });

  it("does not preserve provenance for non-internal_system", () => {
    const user = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "z".repeat(4000) }],
      provenance: { kind: "user" },
      __openclaw: { id: "ghi", seq: 9 },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [user],
      maxSingleMessageBytes: 2_000,
    });
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as Record<string, unknown>).provenance).toBeUndefined();
  });

  it("sentinel remains provenance-free even for internal_system when placeholder too large", () => {
    const hugeId = "z".repeat(4000);
    const internal = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      __openclaw: { id: hugeId, seq: 1 },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [internal],
      maxSingleMessageBytes: 1_000,
    });
    expect(result.messages).toHaveLength(1);
    expect(((result.messages[0] as Record<string, unknown>)["__openclaw"] as unknown)).toBeUndefined();
    expect((result.messages[0] as Record<string, unknown>).provenance).toBeUndefined();
    // sentinel text
    expect(((result.messages[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text) ?? "").toContain("chat.history unavailable");
  });

  it("pending flow uses same placeholder logic (oversized pending input)", () => {
    // Simulate pending input message oversized
    const pendingMsg = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "a".repeat(5000) }],
      provenance: { kind: "internal_system", sourceTool: "cli_harness_context" },
      __openclaw: { id: "pending:xyz", seq: 10 },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [pendingMsg],
      maxSingleMessageBytes: 2_000,
    });
    expect((result.messages[0] as Record<string, unknown>).provenance).toEqual({
      kind: "internal_system",
      sourceTool: "cli_harness_context",
    });
  });
});
