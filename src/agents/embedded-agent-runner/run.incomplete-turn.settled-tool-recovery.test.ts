// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it } from "vitest";
import {
  REASONING_ONLY_RETRY_INSTRUCTION,
  SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  runEmbeddedAgent,
  makeLastAssistant,
  makeRunParams,
  expectWarnMessageWith,
  runAttemptCall,
  markUserMessagePersisted,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  mockedSleepWithAbort,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  it("keeps model-call order when parallel tool outcomes finish out of order", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            toolCallOrdinal?: number;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome;
      onToolOutcome?.({
        toolName: "exec",
        argsHash: "exec-args",
        resultHash: "exec-result",
        toolCallOrdinal: 1,
      });
      onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "fetch-args",
        resultHash: "fetch-result",
        toolCallOrdinal: 0,
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }, { toolName: "exec" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-stale-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("does not surface a read-only presentation after a sibling side effect", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome;
      onToolOutcome?.({
        toolName: "exec",
        argsHash: "exec-args",
        resultHash: "exec-result",
      });
      onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "fetch-args",
        resultHash: "fetch-result",
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }, { toolName: "web_fetch" }],
        lastAssistant: makeLastAssistant({
          stopReason: "toolUse",
          model: "gpt-5.4",
        }),
      });
    });

    const result = await runEmbeddedAgent(
      makeRunParams("run-side-effect-terminal-presentation", { model: "gpt-5.4" }),
    );

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("promotes successful final assistant text when a prompt timeout races completion", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText =
      "1. Verdict: the answer completed cleanly. 2. Evidence: the runner captured final text.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-prompt-timeout-final-assistant-recovered"),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
    expect(result.meta.finalAssistantRawText).toBe(finalText);
    expect(result.meta.livenessState).toBe("working");
    expect(result.meta.completion).toEqual({
      stopReason: "stop",
      finishReason: "stop",
    });
    expect(result.meta.executionTrace?.attempts?.at(-1)).toMatchObject({
      result: "success",
      stage: "assistant",
    });
  });

  it("does not recover a stale prior assistant after the current prompt times out", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const staleAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Stale answer from the prior attempt." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-stale-assistant"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.some((payload) => payload.text?.includes("timed out"))).toBe(true);
    expect(result.payloads?.some((payload) => payload.text?.includes("Stale answer"))).toBe(false);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
  });

  it("does not resolve a successful run from a stale transcript assistant", async () => {
    const staleAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Prior transcript reply." }],
    });
    const completedAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Current run reply." }],
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Current run reply." }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Current run reply."],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: staleAssistant,
        currentAttemptCompletedAssistant: completedAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-success-stale-transcript-assistant"));

    expect(result.payloads).toEqual([{ text: "Current run reply." }]);
    expect(result.meta.finalAssistantVisibleText).toBe("Current run reply.");
    expect(result.meta.finalAssistantRawText).toBe("Current run reply.");
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAssistant: completedAssistant,
        lastAssistant: completedAssistant,
      }),
    );
  });

  it("retains the yielded attempt assistant for paused-turn payload classification", async () => {
    const completedAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Earlier completed cycle." }],
    });
    const yieldedAssistant = makeLastAssistant({
      stopReason: "aborted",
      content: [{ type: "toolCall", name: "sessions_yield", arguments: {} }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: yieldedAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: completedAssistant,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-yielded-assistant-classification"));

    expect(result.meta).toMatchObject({ livenessState: "paused", yielded: true });
    expect(mockedBuildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ currentAssistant: null, lastAssistant: yieldedAssistant }),
    );
  });

  it("recovers a completed prompt-timeout assistant without collected assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "Completed answer after the timeout race.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: undefined as unknown as string[],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-no-assistant-texts"));

    expect(result.payloads).toEqual([{ text: finalText }]);
  });

  it("preserves tool media when prompt-timeout recovery replaces partial assistant text", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const partialText = "Partial answer before the timeout race.";
    const finalText = "Complete answer after the timeout race.";
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        toolMediaUrls: ["https://example.test/recovered-output.png"],
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-prompt-timeout-final-assistant-media"),
    );

    expect(result.payloads).toEqual([
      {
        mediaUrl: "https://example.test/recovered-output.png",
        mediaUrls: ["https://example.test/recovered-output.png"],
        audioAsVoice: undefined,
        trustedLocalMedia: undefined,
      },
      { text: finalText },
    ]);
  });

  it("replaces the latest partial assistant payload after prompt-timeout recovery", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const completedText = "Completed answer block before the final response.";
    const partialText = "Partial final response before the timeout race.";
    const finalText = "Complete final response after the timeout race.";
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([
      { text: completedText },
      { text: partialText },
    ]);
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: finalText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [completedText, partialText],
        timedOut: true,
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-prompt-timeout-latest-partial"));

    expect(result.payloads).toEqual([{ text: completedText }, { text: finalText }]);
  });

  it("records same-model rate-limit retries without a profile-rotation trace", async () => {
    const rateLimitMessage =
      "429 rate_limit_exceeded: requests per minute exceeded; Retry-After: 30";
    const rateLimitAssistant = makeLastAssistant({
      stopReason: "error",
      errorMessage: rateLimitMessage,
    });
    mockedClassifyFailoverReason.mockImplementation((raw) =>
      raw.includes("429") ? "rate_limit" : null,
    );
    mockedIsFailoverAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedIsRateLimitAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: rateLimitAssistant,
        currentAttemptAssistant: rateLimitAssistant,
      }),
    );
    const recoveredAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Recovered after a short rate-limit wait." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered after a short rate-limit wait."],
        lastAssistant: recoveredAssistant,
        currentAttemptAssistant: recoveredAssistant,
      }),
    );

    const result = await runEmbeddedAgent(makeRunParams("run-same-model-rate-limit-trace"));

    expect(mockedSleepWithAbort).toHaveBeenCalledWith(30_000, undefined);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
    expect(result.meta.executionTrace?.attempts).toMatchObject([
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "same_model_rate_limit",
        reason: "rate_limit",
        stage: "assistant",
      },
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "success",
        stage: "assistant",
      },
    ]);
  });

  it("retries reasoning-only GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        }),
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        }),
      }),
    );

    await runEmbeddedAgent(makeRunParams("run-reasoning-only-continuation", { model: "gpt-5.4" }));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("continues once after settled side-effecting tools finish without a final answer", async () => {
    const acceptedSessionSpawns = [
      { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
    ];
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_write", name: "write", arguments: { path: "note.txt" } },
        { type: "toolCall", id: "tool_cron", name: "cron", arguments: { action: "add" } },
        {
          type: "toolCall",
          id: "tool_spawn",
          name: "sessions_spawn",
          arguments: { task: "follow up" },
        },
      ],
    });
    const settledToolResults = [
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_write", toolName: "write", isError: false },
      { role: "toolResult", toolCallId: "tool_cron", toolName: "cron", isError: false },
      {
        role: "toolResult",
        toolCallId: "tool_spawn",
        toolName: "sessions_spawn",
        isError: false,
      },
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        latestMcpAppChannelView: { viewId: "view-after-tools" },
        toolMetas: [
          { toolName: "write", meta: "path=note.txt" },
          { toolName: "cron" },
          { toolName: "sessions_spawn" },
        ],
        successfulNestedToolNames: ["read"],
        acceptedSessionSpawns,
        successfulCronAdds: 1,
        itemLifecycle: { startedCount: 3, completedCount: 3, activeCount: 0 },
        messagesSnapshot: settledToolResults,
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        codeModeEngaged: true,
        assistantTurns: 1,
        bridgeCalls: { search: 1, describe: 2, call: 3 },
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: "Write completed. Here is the final answer." }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Write completed. Here is the final answer."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed. Here is the final answer." }]);

    const result = await runEmbeddedAgent(makeRunParams("run-tool-use-terminal-continuation"));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    expect(result.latestMcpAppChannelView).toEqual({ viewId: "view-after-tools" });
    expect(result.successfulCronAdds).toBe(1);
    expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
    expect(result.meta.toolSummary).toEqual({
      calls: 3,
      tools: ["write", "cron", "sessions_spawn"],
      failures: 0,
    });
    expect(result.meta.agentMeta).toMatchObject({
      codeModeEngaged: true,
      assistantTurns: 2,
      bridgeCalls: { search: 1, describe: 2, call: 3 },
      terminalReceipt: {
        successfulToolNames: ["read"],
      },
    });
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(secondCall.disableTools).toBe(true);
    expect(secondCall.operation).toBe("settled-tool-finalization");
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("settled post-tool turn lacked a final answer");
  });

  it.each([
    { label: "interactive user", trigger: "user" as const },
    {
      label: "required isolated cron",
      trigger: "cron" as const,
      terminalReplyExpectation: "required" as const,
    },
  ])("finalizes a settled failed tool once for a $label turn (#118274)", async (runPolicy) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const failureText = "The exec tool failed: post-processing error.";
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          { toolName: "read", isError: true, replaySafe: true },
          { toolName: "exec", isError: true, replaySafe: false },
        ],
        itemLifecycle: { startedCount: 3, completedCount: 3, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          {
            role: "toolResult",
            toolCallId: "tool_1",
            toolName: "exec",
            isError: true,
            content: [{ type: "text", text: "post-processing error" }],
          },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_search_code:tool_1:read:1",
                name: "read",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tool_search_code:tool_1:read:1",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "post-processing error" }],
          },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: {
          toolName: "exec",
          error: "post-processing error",
          errorCode: "SYSTEM_RUN_DENIED",
        },
      });
    });
    const finalAssistant = makeLastAssistant({
      content: [{ type: "text", text: failureText }],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [failureText],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([{ text: "⚠️ 🛠️ Exec failed", isError: true }])
      .mockReturnValueOnce([{ text: failureText }]);

    const result = await runEmbeddedAgent(
      makeRunParams(`run-settled-failed-tool-${runPolicy.trigger}`, runPolicy),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe(failureText);
    const finalizationCall = runAttemptCall(1);
    expect(finalizationCall.operation).toBe("settled-tool-finalization");
    expect(finalizationCall.disableTools).toBe(true);
    expect(finalizationCall.prompt).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(finalizationCall.prompt).toContain(
      "If any tool failed, state that failure plainly and do not claim it succeeded.",
    );
    expect(result.meta.failureSignal).toEqual(
      runPolicy.trigger === "cron"
        ? {
            kind: "execution_denied",
            source: "tool",
            toolName: "exec",
            code: "SYSTEM_RUN_DENIED",
            message: "post-processing error",
            fatalForCron: true,
          }
        : undefined,
    );
  });
});
