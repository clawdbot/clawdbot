// Coverage for before_agent_finalize revision handling in embedded runs.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function finalAnswerAttempt(
  text: string,
  overrides?: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  // Finalize tests need a successful assistant turn with both surfaced text and
  // snapshot content so the runner can decide whether to request a revision.
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: {
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
    ],
    ...overrides,
  });
}

function attemptCall(index: number): {
  prompt?: string;
  disableTools?: boolean;
  operation?: string;
  skipPreparedUserTurnMessage?: boolean;
  suppressNextUserMessagePersistence?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected embedded attempt call ${index}`);
  }
  return call[0] as {
    prompt?: string;
    disableTools?: boolean;
    operation?: string;
    skipPreparedUserTurnMessage?: boolean;
    suppressNextUserMessagePersistence?: boolean;
  };
}

describe("runEmbeddedAgent before_agent_finalize", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    useOpenAIPlatformAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_finalize",
    );
  });

  it("passes the finalize revision budget to embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(finalAnswerAttempt("First answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-continue",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgentFinalizeRevisionAttempts: 0,
        maxBeforeAgentFinalizeRevisions: 3,
      }),
    );
  });

  it("turns a revise decision into one more hidden continuation", async () => {
    // Revision prompts are hidden continuations; they must not persist the
    // original user prompt a second time.
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        finalAnswerAttempt("First answer.", {
          beforeAgentFinalizeRevisionReason:
            "Tighten the final wording.\n\nMention the validated behavior.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("Revised answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-revise",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(1).prompt).toContain("Tighten the final wording.");
    expect(attemptCall(1).prompt).toContain("Mention the validated behavior.");
    expect(attemptCall(1).prompt).not.toContain("hello");
    expect(attemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("keeps finalizing when the attempt accepted a side-effecting revise decision", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Sent."],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Sent." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-side-effect",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("replaces an incomplete-turn continuation with a finalize revision", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: {
            role: "assistant",
            stopReason: "end_turn",
            provider: "openai",
            model: "gpt-5.5",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "rs_before_finalize", type: "reasoning" }),
              },
            ],
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(
        finalAnswerAttempt("Visible draft.", {
          beforeAgentFinalizeRevisionReason: "Tighten the recovered answer.",
        }),
      )
      .mockResolvedValueOnce(finalAnswerAttempt("Revised recovered answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-after-incomplete-turn",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(attemptCall(1).prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(attemptCall(2).prompt).toContain("Tighten the recovered answer.");
    expect(attemptCall(2).prompt).not.toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry finalize revisions after a timed-out attempt", async () => {
    // A timed-out attempt may have partial assistant text, but asking for a
    // finalize revision would replay an invalid or blocked provider turn.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      finalAnswerAttempt("Late answer.", {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        beforeAgentFinalizeRevisionReason: "Revise the late answer.",
        promptTimeoutOutcome: {
          message: "Request timed out.",
          replayInvalid: true,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("runs settled tool finalization through the full entrypoint", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      }),
    );
    const finalAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Write completed." }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Write completed."],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed." }]);

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-settled-finalization-entry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(1)).toMatchObject({
      disableTools: true,
      operation: "settled-tool-finalization",
      skipPreparedUserTurnMessage: true,
    });
    expect(result.payloads).toEqual([{ text: "Write completed." }]);
  });

  it("keeps terminal presentation selection in model-call order", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      const onToolOutcome = (
        params as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            toolCallOrdinal: number;
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
        terminalPresentation: "Fetched older result.",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }, { toolName: "exec" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-terminal-presentation-order-entry",
    });

    expect(result.payloads?.[0]?.text).not.toContain("Fetched older result.");
    expect(result.meta.error).toMatchObject({
      fallbackSafe: false,
      terminalPresentation: false,
    });
  });
});
