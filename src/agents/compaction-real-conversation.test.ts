import { describe, expect, it } from "vitest";
import { isRealConversationMessage } from "./compaction-real-conversation.js";
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

      expect(isRealConversationMessage(summary, messages, 0)).toBe(true);
      expect(isRealConversationMessage(toolResult, messages, 1)).toBe(true);
    },
  );

  it.each<SummaryRole>(["branchSummary", "compactionSummary"])(
    "rejects blank %s messages",
    (role) => {
      const summary = summaryMessage(role, "   ");

      expect(isRealConversationMessage(summary, [summary], 0)).toBe(false);
    },
  );

  it.each([
    { excludeFromContext: true, expected: false },
    { excludeFromContext: false, expected: true },
  ])(
    "classifies custom conversation according to context eligibility ($excludeFromContext)",
    ({ excludeFromContext, expected }) => {
      const custom = {
        role: "custom",
        customType: "display-note",
        content: "A visible administrative event.",
        display: true,
        excludeFromContext,
        timestamp: 1,
      } satisfies AgentMessage;
      const toolResult = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "audit output" }],
      } as AgentMessage;
      const messages = [custom, toolResult];

      expect(isRealConversationMessage(custom, messages, 0)).toBe(expected);
      expect(isRealConversationMessage(toolResult, messages, 1)).toBe(expected);
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

  it.each([
    ["thinking-only blocks", [{ type: "thinking", thinking: "checking" }]],
    ["reasoning-only blocks", [{ type: "reasoning", summary: [] }]],
    ["markup-wrapped heartbeat tokens", "<b>HEARTBEAT_OK</b>"],
  ])("rejects assistant %s as conversation", (_name, content) => {
    const message = { role: "assistant", content } as AgentMessage;

    expect(isRealConversationMessage(message, [message], 0)).toBe(false);
  });

  it.each([
    {
      name: "heartbeat-only user turn",
      preceding: [{ role: "user", content: "<b>HEARTBEAT_OK</b>" }],
      expected: false,
    },
    {
      name: "meaningful first user turn",
      preceding: [{ role: "user", content: "please inspect the repo" }],
      expected: true,
    },
    {
      name: "user turn after a silent reply",
      preceding: [
        { role: "assistant", content: "NO_REPLY" },
        { role: "user", content: "please inspect the failing PR" },
      ],
      expected: true,
    },
  ])("classifies tool output after a $name", ({ preceding, expected }) => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "checked" }],
    } as AgentMessage;
    const messages = [...preceding, toolResult] as AgentMessage[];

    expect(isRealConversationMessage(toolResult, messages, preceding.length)).toBe(expected);
  });

  it("counts visible custom prompts as anchors across assistant tool calls", () => {
    const custom = {
      role: "custom",
      customType: "cron-request",
      content: "prepare the daily report",
      display: true,
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "report source data" }],
    } as AgentMessage;
    const messages = [
      custom,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      toolResult,
    ] as AgentMessage[];

    expect(isRealConversationMessage(custom, messages, 0)).toBe(true);
    expect(isRealConversationMessage(toolResult, messages, 2)).toBe(true);
  });
});
