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
    promptTimeoutOutcome: undefined,
    terminal: { kind: "ok" },
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
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
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
          terminal: {
            kind: "aborted",
            source: "runtime",
            failure: { error: wrappedRestartError, source: "prompt" },
          },
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
          terminal: { kind: "aborted", source: "runtime" },
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
          terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
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
          terminal: { kind: "failed", source: "prompt", error: new Error("prompt failed") },
        }),
        assistant: makeAssistant("stop"),
      }),
    ).toMatchObject({
      reason: "failed",
      status: "error",
    });
    const nullFailure = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt({
        terminal: { kind: "failed", source: "prompt", error: null },
      }),
      assistant: { ...makeAssistant("error"), errorMessage: "stale assistant error" },
    });
    expect(nullFailure).toMatchObject({ reason: "failed", status: "error" });
    expect(nullFailure).not.toHaveProperty("error");
  });

  it.each(["compaction", "tool_execution"] as const)(
    "keeps %s timeouts ahead of their mechanical abort flag",
    (phase) => {
      expect(
        resolveEmbeddedRunAttemptTerminalOutcome({
          attempt: makeAttempt({
            terminal: { kind: "timeout", phase, source: "runtime" },
          }),
          assistant: undefined,
        }),
      ).toMatchObject({
        reason: "timed_out",
        status: "timeout",
      });
    },
  );

  it("keeps a recovered compaction timeout observation non-terminal", () => {
    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          terminal: { kind: "timeout", phase: "compaction", source: "observation" },
        }),
        assistant: makeAssistant("stop"),
      }),
    ).toEqual({ reason: "completed", status: "ok", stopReason: "stop" });
  });

  it("keeps failure detail terminal on a non-terminal timeout observation", () => {
    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt({
          terminal: {
            kind: "timeout",
            phase: "compaction",
            source: "observation",
            failure: { source: "compaction", error: new Error("settlement failed") },
          },
        }),
        assistant: makeAssistant("stop"),
      }),
    ).toMatchObject({ reason: "failed", status: "error" });
  });
});
