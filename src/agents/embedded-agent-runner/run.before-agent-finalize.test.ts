// Coverage for before_agent_finalize revision handling in embedded runs.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { REASONING_ONLY_RETRY_INSTRUCTION } from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

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
  suppressNextUserMessagePersistence?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected embedded attempt call ${index}`);
  }
  return call[0] as { prompt?: string; suppressNextUserMessagePersistence?: boolean };
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
        timedOut: true,
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
});
