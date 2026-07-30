import { describe, expect, it, vi } from "vitest";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt trajectory capture", () => {
  it("records bounded model.completed metadata without re-inlining conversation state", () => {
    const recordEvent = vi.fn();
    const usage = { input: 384_954, output: 5_624, total: 390_578 };
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: ["done"],
      finalPromptText: "inspect",
      attemptUsage: usage,
      toolMetas: [],
      didSendViaMessagingTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      acceptedSessionSpawns: [],
      clientToolCalls: [],
      messagesSnapshot: [{ role: "user", content: "inspect" }],
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent } as never,
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
    });

    const modelCompleted = recordEvent.mock.calls.find(
      ([type]) => type === "model.completed",
    )?.[1] as Record<string, unknown> | undefined;
    expect(modelCompleted).toBeDefined();
    expect(modelCompleted).toMatchObject({
      usage,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
    });
    // context.compiled owns the conversation-state record; a completion snapshot here
    // regresses trajectory size and re-triggers whole-event truncation (#96804 class).
    expect(modelCompleted).not.toHaveProperty("messagesSnapshot");
  });
});
