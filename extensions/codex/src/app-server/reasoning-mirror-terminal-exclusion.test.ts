import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import { createCodexTestModel } from "./test-support.js";
import { selectTerminalMirrorMessage } from "./transcript-mirror.js";
import {
  attachCodexMirrorIdentity,
  isCodexReasoningMirrorMessage,
  readMirrorIdentity,
} from "./upstream-prompt-provenance.js";

// Bug B (beast-telegram-delivery-w0-sep7-1427): the per-turn Codex reasoning
// mirror is projected as an untagged assistant message. Last-assistant/terminal
// re-selectors that pick the trailing assistant message could re-adopt it and
// leak private reasoning into chat history. The terminal re-selector now excludes
// `${turnId}:reasoning` mirror-identity messages.

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AssistantMessage;
}

function buildReasoningSnapshot(params: {
  reasoningText: string | undefined;
  lastAssistant: AssistantMessage | undefined;
}): AgentMessage[] {
  // A valid model/provider is required: the reasoning-mirror projection resolves
  // local-runtime attribution from runParams.model, so an empty cast would crash
  // before the terminal-selection behavior under test could run. Reuse the shared
  // Codex test model exactly as the sibling snapshot test does.
  const model = createCodexTestModel();
  return buildCodexMessagesSnapshot({
    runParams: {
      prompt: "hi",
      sessionId: "s-1",
      provider: model.provider,
      modelId: model.id,
      model,
      trigger: "user",
    } as EmbeddedRunAttemptParams,
    turnId: "turn-1",
    upstreamUserText: "hi",
    reasoningText: params.reasoningText,
    asyncMessages: [],
    commentaryMessages: [],
    toolMessages: [],
    lastAssistant: params.lastAssistant,
    createAssistantMirrorMessage: (title, text) => assistant(`${title}:\n${text}`),
  });
}

// Exercises the exact production terminal (last-assistant) re-selector used in
// transcript-mirror.ts, so this test guards the real code path.
function selectTerminalMirrorIdentity(messages: AgentMessage[]): string | undefined {
  const terminal = selectTerminalMirrorMessage(messages);
  return terminal ? readMirrorIdentity(terminal) : undefined;
}

describe("codex reasoning mirror terminal exclusion", () => {
  it("identifies the :reasoning mirror and not other assistant messages", () => {
    const reasoningMirror = attachCodexMirrorIdentity(assistant("Codex reasoning:\nx"), "turn-1:reasoning");
    const answerMirror = attachCodexMirrorIdentity(assistant("the answer"), "turn-1:assistant");
    expect(isCodexReasoningMirrorMessage(reasoningMirror)).toBe(true);
    expect(isCodexReasoningMirrorMessage(answerMirror)).toBe(false);
    expect(isCodexReasoningMirrorMessage(assistant("untagged"))).toBe(false);
  });

  it("does not re-adopt reasoning as the terminal answer on a reasoning-only turn", () => {
    // Reasoning-only turn: the reasoning mirror is the trailing assistant message.
    // Without the exclusion it would be re-selected as the terminal answer and leak.
    const messages = buildReasoningSnapshot({
      reasoningText: "private chain of thought",
      lastAssistant: undefined,
    });
    const reasoningPresent = messages.some(isCodexReasoningMirrorMessage);
    expect(reasoningPresent).toBe(true);
    // The reasoning mirror must never be chosen as the terminal answer.
    expect(selectTerminalMirrorIdentity(messages)).not.toBe("turn-1:reasoning");
  });

  it("still selects a genuine final assistant answer as the terminal message", () => {
    const messages = buildReasoningSnapshot({
      reasoningText: "private chain of thought",
      lastAssistant: assistant("the real final answer"),
    });
    expect(selectTerminalMirrorIdentity(messages)).toBe("turn-1:assistant");
  });
});
