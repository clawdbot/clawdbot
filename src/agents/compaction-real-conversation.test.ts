import { describe, expect, it } from "vitest";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "./compaction-real-conversation.js";
import type { AgentMessage } from "./runtime/index.js";

type SummaryRole = "branchSummary" | "compactionSummary";

function summaryMessage(role: SummaryRole, summary: string): AgentMessage {
  return { role, summary, timestamp: 1 } as AgentMessage;
}

describe("compaction real conversation classification", () => {
  it.each<SummaryRole>(["branchSummary", "compactionSummary"])(
    "treats non-empty %s messages as conversation anchors",
    (role) => {
      const summary = summaryMessage(role, "The user asked for a repository audit.");
      const toolResult = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "audit output" }],
      } as AgentMessage;
      const messages = [summary, toolResult];

      expect(hasMeaningfulConversationContent(summary)).toBe(true);
      expect(isRealConversationMessage(summary, messages, 0)).toBe(true);
      expect(isRealConversationMessage(toolResult, messages, 1)).toBe(true);
    },
  );

  it.each<SummaryRole>(["branchSummary", "compactionSummary"])(
    "rejects blank %s messages",
    (role) => {
      const summary = summaryMessage(role, "   ");

      expect(hasMeaningfulConversationContent(summary)).toBe(false);
      expect(isRealConversationMessage(summary, [summary], 0)).toBe(false);
    },
  );

  it("rejects tool-call-only messages and orphan tool results", () => {
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
    } as AgentMessage;
    const orphanToolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "audit output" }],
    } as AgentMessage;

    expect(isRealConversationMessage(toolCall, [toolCall], 0)).toBe(false);
    expect(isRealConversationMessage(orphanToolResult, [orphanToolResult], 0)).toBe(false);
  });
});
