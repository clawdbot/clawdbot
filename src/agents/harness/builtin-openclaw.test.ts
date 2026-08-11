// Built-in OpenClaw harness tests cover logical thinking-mode boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());
const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());

vi.mock("../embedded-agent-runner/run/attempt.js", () => ({ runEmbeddedAttempt }));
vi.mock("../simple-completion-runtime.js", () => ({ completeWithPreparedSimpleCompletionModel }));

import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";

describe("createOpenClawAgentHarness", () => {
  beforeEach(() => {
    runEmbeddedAttempt.mockReset();
    runEmbeddedAttempt.mockResolvedValue({
      terminal: { kind: "ok" },
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
    completeWithPreparedSimpleCompletionModel.mockReset();
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    });
  });

  it("brands only host-created instances as the built-in runtime", () => {
    expect(isBuiltInOpenClawAgentHarness(createOpenClawAgentHarness())).toBe(true);
    expect(
      isBuiltInOpenClawAgentHarness({
        id: "openclaw",
        label: "forged",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("must not run");
        },
      }),
    ).toBe(false);
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

  it("runs isolated completion through the prepared zero-tool transport", async () => {
    const params = {
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      auth: { apiKey: "secret", source: "profile:test", mode: "api-key" },
      config: {},
      systemPrompt: "system",
      prompt: "user",
      timeoutMs: 1_000,
      provider: "openai",
      modelId: "gpt-test",
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof createOpenClawAgentHarness>["runIsolatedCompletion"]>
    >[0];

    await expect(createOpenClawAgentHarness().runIsolatedCompletion?.(params)).resolves.toEqual({
      assistant: expect.objectContaining({ stopReason: "stop" }),
    });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: params.model,
        auth: params.auth,
        context: {
          systemPrompt: "system",
          messages: [expect.objectContaining({ role: "user", content: "user" })],
          tools: [],
        },
      }),
    );
    expect(runEmbeddedAttempt).not.toHaveBeenCalled();
  });
});
