import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import { resolveEmbeddedRunAttemptTerminalOutcome } from "./terminal-outcome.js";

type EmbeddedRunAttemptTerminalInput = Parameters<
  typeof resolveEmbeddedRunAttemptTerminalOutcome
>[0]["attempt"];

function makeAttempt(
  overrides: Partial<EmbeddedRunAttemptTerminalInput> = {},
): EmbeddedRunAttemptTerminalInput {
  return {
    aborted: false,
    idleTimedOut: false,
    promptError: null,
    promptTimeoutOutcome: undefined,
    timedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    ...overrides,
  };
}

function makeAssistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content: [],
    timestamp: 0,
    stopReason,
  };
}

describe("embedded run attempt terminal outcome", () => {
  it("keeps prompt timeout ownership ahead of generic abort metadata", () => {
    const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt({
        aborted: true,
        timedOut: true,
      }),
      assistant: makeAssistant("aborted"),
    });

    expect(outcome).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    expect(outcome).not.toHaveProperty("stopReason");
  });

  it("keeps restart cancellation ahead of generic abort metadata", () => {
    const restartError = createAgentRunRestartAbortError();
    const wrappedRestartError = new Error(restartError.message, { cause: restartError });
    wrappedRestartError.name = "AbortError";

    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          aborted: true,
          promptError: wrappedRestartError,
        }),
        assistant: makeAssistant("aborted"),
      }),
    ).toMatchObject({
      reason: "cancelled",
      status: "error",
      stopReason: "restart",
    });
  });

  it("keeps generic abort metadata ahead of a non-abort assistant stop reason", () => {
    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          aborted: true,
        }),
        assistant: makeAssistant("stop"),
      }),
    ).toMatchObject({
      reason: "aborted",
      status: "error",
      stopReason: "aborted",
    });
  });

  it("keeps an attributed prompt timeout ahead of restart cancellation", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          aborted: true,
          timedOut: true,
        }),
        assistant: undefined,
        abortSignal: controller.signal,
      }),
    ).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "provider",
    });
  });

  it("classifies caller timeout aborts before attempt timeout flags settle", () => {
    const controller = new AbortController();
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    controller.abort(timeoutError);

    const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt(),
      assistant: undefined,
      abortSignal: controller.signal,
    });

    expect(outcome).toMatchObject({
      reason: "timed_out",
      status: "timeout",
      stopReason: "timeout",
    });
    expect(outcome).not.toHaveProperty("timeoutPhase");
    expect(outcome).not.toHaveProperty("providerStarted");
  });

  it("ignores stale successful stop metadata when the current prompt failed", () => {
    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          promptError: new Error("prompt failed"),
        }),
        assistant: makeAssistant("stop"),
      }),
    ).toMatchObject({
      reason: "failed",
      status: "error",
    });
  });

  it.each([{ timedOutDuringCompaction: true }, { timedOutDuringToolExecution: true }])(
    "keeps non-provider timeouts ahead of their mechanical abort flag",
    (timeoutPhase) => {
      expect(
        resolveEmbeddedRunAttemptTerminalOutcome({
          attempt: makeAttempt({
            aborted: true,
            timedOut: true,
            ...timeoutPhase,
          }),
          assistant: undefined,
        }),
      ).toMatchObject({
        reason: "timed_out",
        status: "timeout",
      });
    },
  );
});
