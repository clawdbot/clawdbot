import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

function getPersistedMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

describe("session tool-result persistence controls", () => {
  it("suppresses assistant error stubs when requested", () => {
    const sessionManager = SessionManager.inMemory();
    installSessionToolResultGuard(sessionManager, {
      suppressAssistantErrorPersistence: true,
    });

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        stopReason: "error",
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "next user message",
        timestamp: Date.now() + 1,
      }),
    );

    const persisted = getPersistedMessages(sessionManager);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
  });

  it("notifies after assistant error stubs persist", () => {
    const sessionManager = SessionManager.inMemory();
    const persistedErrors: Array<Extract<AgentMessage, { role: "assistant" }>> = [];
    installSessionToolResultGuard(sessionManager, {
      onAssistantErrorMessagePersisted: (message) => {
        persistedErrors.push(message);
      },
    });

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        stopReason: "error",
        timestamp: Date.now(),
      }),
    );

    expect(persistedErrors).toHaveLength(1);
    expect(persistedErrors[0]?.stopReason).toBe("error");
  });

  it("reports the exact persisted user entry id", () => {
    const sessionManager = SessionManager.inMemory();
    const persisted: Array<{ entryId: string; message: AgentMessage }> = [];
    installSessionToolResultGuard(sessionManager, {
      onUserMessagePersisted: (message, context) => {
        persisted.push({ entryId: context.entryId, message });
      },
    });

    const entryId = sessionManager.appendMessage(
      asAppendMessage({ role: "user", content: "exact admission", timestamp: 1 }),
    );

    expect(persisted).toEqual([
      {
        entryId,
        message: expect.objectContaining({ role: "user", content: "exact admission" }),
      },
    ]);
  });

  it("models a four-candidate followup fallback cascade producing exactly one user and one assistant-error entry", () => {
    const sessionManager = SessionManager.inMemory();
    const fallbackCandidates = 4;
    let userPersisted = false;
    let assistantErrorPersisted = false;

    for (let attempt = 0; attempt < fallbackCandidates; attempt += 1) {
      installSessionToolResultGuard(sessionManager, {
        suppressNextUserMessagePersistence: userPersisted,
        suppressAssistantErrorPersistence: assistantErrorPersisted,
        onUserMessagePersisted: () => {
          userPersisted = true;
        },
        onAssistantErrorMessagePersisted: () => {
          assistantErrorPersisted = true;
        },
      });
      sessionManager.appendMessage(
        asAppendMessage({
          role: "user",
          content: "queued user message",
          timestamp: Date.now() + attempt,
        }),
      );
      sessionManager.appendMessage(
        asAppendMessage({
          role: "assistant",
          content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
          stopReason: "error",
          timestamp: Date.now() + attempt,
        }),
      );
    }

    const roles = getPersistedMessages(sessionManager).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
    const consecutiveSameRole = roles.reduce(
      (count, role, index) => count + (index > 0 && role === roles[index - 1] ? 1 : 0),
      0,
    );
    expect(consecutiveSameRole).toBe(0);
  });

  it("still persists successful assistant messages when error suppression is on", () => {
    const sessionManager = SessionManager.inMemory();
    installSessionToolResultGuard(sessionManager, {
      suppressAssistantErrorPersistence: true,
    });

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: "ok response",
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    );

    const persisted = getPersistedMessages(sessionManager);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.role).toBe("assistant");
  });

  it("suppresses transcript-only assistant messages when requested", () => {
    const sessionManager = SessionManager.inMemory();
    installSessionToolResultGuard(sessionManager, {
      suppressTranscriptOnlyAssistantPersistence: true,
    });

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: "private room-event note",
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "message", arguments: {} }],
        timestamp: Date.now() + 1,
      }),
    );

    const persisted = getPersistedMessages(sessionManager);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.role).toBe("assistant");
    expect(JSON.stringify(persisted[0])).toContain("call_1");
  });

  it("does not create synthetic tool results for aborted assistant calls", () => {
    const sessionManager = SessionManager.inMemory();
    installSessionToolResultGuard(sessionManager);

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "read", arguments: {} }],
        stopReason: "aborted",
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "are you stuck?",
        timestamp: Date.now(),
      }),
    );

    const roles = getPersistedMessages(sessionManager).map((message) => message.role);
    expect(roles).toEqual(["assistant", "user"]);
    expect(roles).not.toContain("toolResult");
  });

  it("does not create synthetic tool results for errored assistant calls", () => {
    const sessionManager = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sessionManager);

    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      }),
    );
    guard.flushPendingToolResults();

    const syntheticForError = getPersistedMessages(sessionManager)
      .filter((message) => message.role === "toolResult")
      .filter((message) => (message as { toolCallId?: string }).toolCallId === "call_error");
    expect(syntheticForError).toHaveLength(0);
  });
});
