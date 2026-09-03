import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "./test-helpers/agent-message-fixtures.js";

const call = makeAgentAssistantMessage({
  content: [{ type: "toolCall", id: "call_order", name: "read", arguments: {} }],
  stopReason: "toolUse",
});
const result = {
  role: "toolResult",
  toolCallId: "call_order",
  toolName: "read",
  content: [{ type: "text", text: "success" }],
  isError: false,
  timestamp: 1,
} satisfies Extract<AgentMessage, { role: "toolResult" }>;

describe("tool-result persistence ordering", () => {
  it.each(["result", "throw"])(
    "tracks a committed assistant call before its callback performs %s",
    (action) => {
      const manager = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(manager, {
        onMessagePersisted(message) {
          if (message.role !== "assistant") {
            return;
          }
          if (action === "throw") {
            throw new Error("assistant callback failed after commit");
          }
          manager.appendMessage(result);
        },
      });
      if (action === "throw") {
        expect(() => manager.appendMessage(call)).toThrow("assistant callback failed after commit");
        expect(guard.getPendingIds()).toEqual(["call_order"]);
      } else {
        manager.appendMessage(call);
      }
      guard.flushPendingToolResults();
      expect(manager.getEntries().filter((entry) => entry.type === "message")).toMatchObject([
        { message: call },
        { message: { role: "toolResult", toolCallId: "call_order", isError: action === "throw" } },
      ]);
    },
  );

  it.each(["user", "assistant", "throw"])(
    "does not repair a committed result when its callback performs %s",
    (action) => {
      const manager = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(manager, {
        onMessagePersisted(message) {
          if (message.role !== "toolResult" || message.isError) {
            return;
          }
          if (action === "throw") {
            throw new Error("callback failed after commit");
          }
          const content = [{ type: "text" as const, text: "next message" }];
          manager.appendMessage(
            action === "user"
              ? makeAgentUserMessage({ content })
              : makeAgentAssistantMessage({ content }),
          );
        },
      });
      manager.appendMessage(call);
      if (action === "throw") {
        expect(() => manager.appendMessage(result)).toThrow("callback failed after commit");
      } else {
        manager.appendMessage(result);
      }
      guard.flushPendingToolResults();

      expect(guard.getPendingIds()).toEqual([]);
      expect(
        manager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
          ),
      ).toEqual([result]);
    },
  );

  it("keeps an uncommitted result pending when the raw append fails", () => {
    const manager = SessionManager.inMemory();
    const append = manager.appendMessageWithTranscriptAnchor.bind(manager);
    const spy = vi
      .spyOn(manager, "appendMessageWithTranscriptAnchor")
      .mockImplementation((message, options) => {
        if (message.role === "toolResult" && !message.isError) {
          throw new Error("append failed before commit");
        }
        return append(message, options);
      });
    try {
      const guard = installSessionToolResultGuard(manager);
      manager.appendMessage(call);
      expect(() => manager.appendMessage(result)).toThrow("append failed before commit");
      expect(guard.getPendingIds()).toEqual(["call_order"]);
      guard.flushPendingToolResults();
      expect(manager.getEntries().filter((entry) => entry.type === "message")).toMatchObject([
        { message: call },
        { message: { role: "toolResult", toolCallId: "call_order", isError: true } },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
