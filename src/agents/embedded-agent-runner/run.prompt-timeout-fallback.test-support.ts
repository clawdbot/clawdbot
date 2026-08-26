// Full-entry coverage for handing replay-safe prompt timeouts to model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedGetApiKeyForModel,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("throws FailoverError for replay-safe harness-owned prompt timeouts when model fallbacks are configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
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
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
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
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-post-tool-idle-finalization",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
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
});
