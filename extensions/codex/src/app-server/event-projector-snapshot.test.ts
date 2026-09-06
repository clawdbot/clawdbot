import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import {
  buildEmptyToolTelemetry,
  createCodexTestModel,
  createProjector,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
} from "./event-projector.test-harness.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

registerCodexEventProjectorTestLifecycle();

function buildSnapshot(trigger: EmbeddedRunAttemptParams["trigger"]): AgentMessage[] {
  const model = createCodexTestModel();
  return buildCodexMessagesSnapshot({
    runParams: {
      prompt: "Pre-compaction memory flush",
      sessionId: "session-1",
      provider: model.provider,
      modelId: model.id,
      model,
      trigger,
    } as EmbeddedRunAttemptParams,
    turnId: "turn-1",
    upstreamUserText: undefined,
    reasoningText: "checking memory",
    asyncMessages: [],
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

  it("retains distinct completed item identities across steers without replaying the terminal answer", async () => {
    const projector = await createProjector();
    for (const id of ["answer-a", "answer-b"]) {
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { type: "agentMessage", id, phase: "final_answer", text: "Same answer." },
        }),
      );
    }
    const sleep = { type: "sleep", id: "sleep", durationMs: 250 };
    await projector.handleNotification(forCurrentTurn("item/started", { item: sleep }));
    const pending = { type: "agentMessage", id: "pending", phase: "final_answer", text: "" };
    await projector.handleNotification(forCurrentTurn("item/started", { item: pending }));
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: pending.id,
        delta: "Still writing.",
      }),
    );

    const prefix = projector.buildSteeringTranscriptPrefix();
    expect(prefix.map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
    ]);
    expect(prefix).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
    ]);
    projector.markSteeringTranscriptPersisted();
    expect(projector.buildSteeringTranscriptPrefix()).toEqual(prefix);

    // A late completion for the same handoff must not invalidate the later answer.
    await projector.handleNotification(forCurrentTurn("item/completed", { item: sleep }));
    const completed = { ...pending, text: "Still writing." };
    await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
    expect(projector.buildSteeringTranscriptPrefix().map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
      "turn-1:assistant:pending",
    ]);
    projector.markSteeringTranscriptPersisted();
    await projector.handleNotification(turnCompleted([completed]));
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([]);
  });
});
