import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";

const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeToolResultMessage(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeUserMessage(): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "continue" }],
    timestamp: Date.now(),
  };
}

function makeYieldInterruptMessage(): AgentMessage {
  return {
    role: "custom",
    customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: Date.now(),
  };
}

function buildSession(messages: AgentMessage[], sessionManager = SessionManager.inMemory()) {
  return {
    messages,
    agent: { state: { messages: [...messages] } },
    sessionManager,
  };
}

describe("stripSessionsYieldArtifacts", () => {
  it("removes the full non-continuable yield suffix", () => {
    const toolResult = makeToolResultMessage();
    const session = buildSession([
      toolResult,
      makeAssistantMessage({ content: [{ type: "text", text: "work 1" }] }),
      makeAssistantMessage({ content: [{ type: "text", text: "work 2" }] }),
      makeAssistantMessage({ stopReason: "aborted" }),
      makeYieldInterruptMessage(),
    ]);

    stripSessionsYieldArtifacts(session);

    expect(session.agent.state.messages).toEqual([toolResult]);
  });

  it("leaves a continuable suffix unchanged", () => {
    const messages = [makeToolResultMessage(), makeUserMessage()];
    const session = buildSession(messages);

    stripSessionsYieldArtifacts(session);

    expect(session.agent.state.messages).toEqual(messages);
  });

  it("strips an assistant tail after synthetic artifacts have already settled", () => {
    const toolResult = makeToolResultMessage();
    const session = buildSession([toolResult, makeAssistantMessage()]);

    stripSessionsYieldArtifacts(session);

    expect(session.agent.state.messages).toEqual([toolResult]);
  });

  it("caps persisted assistant cleanup when persistence lacks the interrupt marker", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeToolResultMessage());
    for (let index = 0; index < 4; index += 1) {
      sessionManager.appendMessage(
        makeAssistantMessage({ content: [{ type: "text", text: `persisted ${index}` }] }),
      );
    }
    const session = buildSession(
      [
        makeToolResultMessage(),
        makeAssistantMessage(),
        makeAssistantMessage({ stopReason: "aborted" }),
        makeYieldInterruptMessage(),
      ],
      sessionManager,
    );

    stripSessionsYieldArtifacts(session);

    const branch = sessionManager.getBranch();
    expect(
      branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ).toHaveLength(2);
    expect(
      branch.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
      ),
    ).toBe(false);
  });

  it("removes a persisted interrupt marker without consuming the assistant budget", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeToolResultMessage());
    for (let index = 0; index < 3; index += 1) {
      sessionManager.appendMessage(
        makeAssistantMessage({ content: [{ type: "text", text: `persisted ${index}` }] }),
      );
    }
    sessionManager.appendCustomMessageEntry(
      SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
      "[sessions_yield interrupt]",
      false,
    );

    const session = buildSession(
      [makeToolResultMessage(), makeAssistantMessage(), makeAssistantMessage()],
      sessionManager,
    );

    stripSessionsYieldArtifacts(session);

    const branch = sessionManager.getBranch();
    expect(
      branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ).toHaveLength(1);
    expect(
      branch.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
      ),
    ).toBe(false);
  });

  it("preserves trailing transcript metadata", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeToolResultMessage());
    sessionManager.appendMessage(makeAssistantMessage({ stopReason: "aborted" }));
    sessionManager.appendCustomMessageEntry(
      SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
      "[sessions_yield interrupt]",
      false,
    );
    sessionManager.appendCustomEntry("plugin-state", { enabled: true });

    const session = buildSession(
      [
        makeToolResultMessage(),
        makeAssistantMessage({ stopReason: "aborted" }),
        makeYieldInterruptMessage(),
      ],
      sessionManager,
    );

    stripSessionsYieldArtifacts(session);

    const entries = sessionManager.getEntries();
    expect(
      entries.some((entry) => entry.type === "custom" && entry.customType === "plugin-state"),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          (entry.type === "message" && entry.message.role === "assistant") ||
          (entry.type === "custom_message" &&
            entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE),
      ),
    ).toBe(false);
  });
});
