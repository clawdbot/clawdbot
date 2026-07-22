// Built-in OpenClaw harness tests cover logical thinking-mode boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());

vi.mock("../embedded-agent-runner/run/attempt.js", () => ({ runEmbeddedAttempt }));

import { createOpenClawAgentHarness } from "./builtin-openclaw.js";

describe("createOpenClawAgentHarness", () => {
  beforeEach(() => {
    runEmbeddedAttempt.mockReset();
    runEmbeddedAttempt.mockResolvedValue({
      aborted: false,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      promptError: null,
      promptErrorSource: null,
      sessionIdUsed: "session-1",
      messagesSnapshot: [],
      assistantTexts: ["done"],
      toolMetas: [],
      lastAssistant: undefined,
      currentAttemptCompletedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      cloudCodeAssistFormatError: false,
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });
  });

  it("preserves logical Ultra for the embedded attempt", async () => {
    const params = { thinkLevel: "ultra" } as never;

    await createOpenClawAgentHarness().runAttempt(params);

    expect(runEmbeddedAttempt).toHaveBeenCalledWith(params);
  });

  it("enforces a tool-free settled-turn finalization", async () => {
    const attempt = {
      prompt: "finalize",
      disableTools: false,
      extraSystemPrompt: "ambient system context",
      skillsSnapshot: { prompt: "ambient skills" },
      currentInboundContext: { text: "ambient inbound context" },
      internalEvents: [{ type: "ambient-event" }],
      trigger: "heartbeat",
      onPartialReply: vi.fn(),
    } as never;
    const harness = createOpenClawAgentHarness();

    await harness.finalizeSettledTurn?.({ attempt, settledAttempt: {} as never });

    expect(runEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "finalize",
        disableTools: true,
        disableTrajectory: true,
        skipPreparedUserTurnMessage: true,
        initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
        operation: "settled-tool-finalization",
      }),
    );
    const finalizationAttempt = runEmbeddedAttempt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(finalizationAttempt).not.toHaveProperty("extraSystemPrompt");
    expect(finalizationAttempt).not.toHaveProperty("skillsSnapshot");
    expect(finalizationAttempt).not.toHaveProperty("currentInboundContext");
    expect(finalizationAttempt).not.toHaveProperty("internalEvents");
    expect(finalizationAttempt).not.toHaveProperty("trigger");
    expect(finalizationAttempt).not.toHaveProperty("onPartialReply");
  });
});
