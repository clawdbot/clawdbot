import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";

function buildSnapshot(trigger: EmbeddedRunAttemptParams["trigger"]): AgentMessage[] {
  return buildCodexMessagesSnapshot({
    runParams: {
      prompt: "Pre-compaction memory flush",
      sessionId: "session-1",
      trigger,
    } as EmbeddedRunAttemptParams,
    turnId: "turn-1",
    upstreamUserText: undefined,
    reasoningText: "checking memory",
    planText: undefined,
    commentaryMessages: [],
    toolMessages: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "saved" }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    ],
    lastAssistant: {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now() + 1,
    } as AssistantMessage,
    createAssistantMirrorMessage: (title, text) =>
      ({
        role: "assistant",
        content: [{ type: "text", text: `[${title}] ${text}` }],
        timestamp: Date.now(),
      }) as AssistantMessage,
  });
}

describe("buildCodexMessagesSnapshot", () => {
  it("marks every current memory-maintenance message as hidden for durable replay", () => {
    const messages = buildSnapshot("memory");

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => (message as { display?: boolean }).display === false)).toBe(
      true,
    );
  });

  it("leaves ordinary current-turn messages visible", () => {
    const messages = buildSnapshot("user");

    expect(messages.every((message) => (message as { display?: boolean }).display !== false)).toBe(
      true,
    );
  });
});
