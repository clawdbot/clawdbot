import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalInterrupted,
  isEmbeddedRunTerminalTimeout,
  resolveEmbeddedRunAttemptTerminalOutcome,
  resolveEmbeddedRunAttemptTerminalState,
} from "./terminal-outcome.js";

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
  it.each([
    {
      name: "run-budget prompt timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "run_budget" },
      reason: "hard_timeout",
      aborted: false,
      timedOut: true,
    },
    {
      name: "idle prompt timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "idle" },
      reason: "hard_timeout",
      aborted: false,
      timedOut: true,
    },
    {
      name: "recovered compaction observation",
      terminal: { kind: "timeout", phase: "compaction", source: "observation" },
      reason: "completed",
      aborted: false,
      timedOut: false,
    },
    {
      name: "yield-only cleanup",
      terminal: { kind: "aborted", source: "yield_cleanup" },
      reason: "completed",
      aborted: false,
      timedOut: false,
    },
    {
      name: "external attempt cancellation",
      terminal: { kind: "aborted", source: "external" },
      reason: "aborted",
      aborted: true,
      timedOut: false,
    },
  ] as const)("carries $name through canonical interruption predicates", (testCase) => {
    const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt({ terminal: testCase.terminal }),
      assistant: makeAssistant("stop"),
    });

    expect(outcome.reason).toBe(testCase.reason);
    expect(isEmbeddedRunTerminalAbort(outcome)).toBe(testCase.aborted);
    expect(isEmbeddedRunTerminalTimeout(outcome)).toBe(testCase.timedOut);
    expect(isEmbeddedRunTerminalInterrupted(outcome)).toBe(testCase.aborted || testCase.timedOut);
  });

  it("keeps user-signal cancellation authoritative before assistant completion", () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt(),
      assistant: undefined,
      abortSignal: controller.signal,
    });

    expect(outcome).toMatchObject({
      reason: "aborted",
      status: "error",
      stopReason: "aborted",
    });
    expect(isEmbeddedRunTerminalAbort(outcome)).toBe(true);
    expect(isEmbeddedRunTerminalTimeout(outcome)).toBe(false);
    expect(isEmbeddedRunTerminalInterrupted(outcome)).toBe(true);
  });

  it("captures signal ownership before a later cancellation can reclassify completion", () => {
    const controller = new AbortController();
    const terminal = resolveEmbeddedRunAttemptTerminalState({
      attempt: makeAttempt(),
      assistant: makeAssistant("stop"),
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(terminal).toEqual({
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
      signalOwnedInterruption: false,
    });
  });

  it("captures user cancellation with the same terminal that owns the interruption", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      resolveEmbeddedRunAttemptTerminalState({
        attempt: makeAttempt(),
        assistant: undefined,
        abortSignal: controller.signal,
      }),
    ).toMatchObject({
      outcome: { reason: "aborted", status: "error", stopReason: "aborted" },
      signalOwnedInterruption: true,
    });
  });

  it("starts successful settled finalization without inheriting the original abort signal", () => {
    const controller = new AbortController();
    controller.abort();
    const originalTerminal = resolveEmbeddedRunAttemptTerminalState({
      attempt: makeAttempt(),
      assistant: undefined,
      abortSignal: controller.signal,
    });

    expect(originalTerminal.signalOwnedInterruption).toBe(true);
    expect(
      resolveEmbeddedRunAttemptTerminalState({
        attempt: makeAttempt(),
        assistant: makeAssistant("stop"),
      }),
    ).toEqual({
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
      signalOwnedInterruption: false,
    });
  });

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
