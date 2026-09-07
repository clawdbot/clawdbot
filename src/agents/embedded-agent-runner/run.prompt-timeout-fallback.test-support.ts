// Full-entry coverage for handing replay-safe prompt timeouts to model fallback.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedGetApiKeyForModel,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.prompt-timeout-fallback" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("throws FailoverError for persistent replay-safe prompt timeouts after transient retries", async () => {
    // The transient retry owner continues the same model first; a timeout that
    // persists past the retry budget hands off to the configured fallback.
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("LLM request timed out."),
        },
      }),
    );

    const promise = runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config: createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    // Initial attempt plus the full same-model transient retry budget.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(9);
  });

  it("finalizes a settled write after an idle timeout without replaying the prompt", async () => {
    const toolUseAssistant = {
      role: "assistant" as const,
      stopReason: "toolUse" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [
        {
          type: "toolCall",
          id: "tool_write",
          name: "write",
          arguments: { path: "note.txt", content: "done" },
        },
      ],
    };
    const abortedAssistant = {
      role: "assistant" as const,
      stopReason: "aborted" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [],
    };
    const finalAssistant = {
      role: "assistant" as const,
      stopReason: "stop" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [{ type: "text", text: "The note was written once." }],
    };
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          terminal: { kind: "timeout", phase: "prompt", source: "idle" },
          toolMetas: [{ toolName: "write", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            { role: "user", content: [{ type: "text", text: "Write note.txt" }] },
            toolUseAssistant,
            {
              role: "toolResult",
              toolCallId: "tool_write",
              toolName: "write",
              isError: false,
            },
            abortedAssistant,
          ] as never,
          lastAssistant: abortedAssistant as never,
          currentAttemptAssistant: abortedAssistant as never,
          currentAttemptReplayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["The note was written once."],
          lastAssistant: finalAssistant as never,
          currentAttemptAssistant: finalAssistant as never,
          currentAttemptCompletedAssistant: finalAssistant as never,
        }),
      );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "The note was written once." }]);

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-post-tool-idle-finalization",
      config: createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]),
    });

    expect(result.payloads).toEqual([{ text: "The note was written once." }]);
    expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      operation: "settled-tool-finalization",
      disableTools: true,
      skipPreparedUserTurnMessage: true,
      prompt:
        "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.",
    });
    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
  });

  it("reports the idle timeout when settled-write finalization produces no answer", async () => {
    const toolUseAssistant = {
      role: "assistant" as const,
      stopReason: "toolUse" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [
        {
          type: "toolCall",
          id: "tool_write",
          name: "write",
          arguments: { path: "note.txt", content: "done" },
        },
      ],
    };
    const abortedAssistant = {
      role: "assistant" as const,
      stopReason: "aborted" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [],
    };
    const emptyAssistant = {
      role: "assistant" as const,
      stopReason: "stop" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [],
    };
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          terminal: { kind: "timeout", phase: "prompt", source: "idle" },
          toolMetas: [{ toolName: "write", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            { role: "user", content: [{ type: "text", text: "Write note.txt" }] },
            toolUseAssistant,
            {
              role: "toolResult",
              toolCallId: "tool_write",
              toolName: "write",
              isError: false,
            },
            abortedAssistant,
          ] as never,
          lastAssistant: abortedAssistant as never,
          currentAttemptAssistant: abortedAssistant as never,
          currentAttemptReplayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
      )
      .mockResolvedValue(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: emptyAssistant as never,
          currentAttemptAssistant: emptyAssistant as never,
          currentAttemptCompletedAssistant: emptyAssistant as never,
        }),
      );

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-post-tool-idle-finalization-empty",
      config: createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]),
    });

    // Initial attempt plus both tool-free finalization attempts; no replay, no fallback model.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.executionTrace?.fallbackUsed).not.toBe(true);
    expect(result.meta.error).toMatchObject({ kind: "incomplete_turn" });
    expect(result.payloads).toEqual([
      { text: expect.stringContaining("model idle timeout"), isError: true },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("no final summary was produced");
  });
});
