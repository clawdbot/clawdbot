import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function finalAnswerAttempt(
  text: string,
  overrides?: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
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
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
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

  it("does not retry finalize revisions after a timed-out attempt", async () => {
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
