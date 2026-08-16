import { describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  hasCodexAppServerRecoveryRetryBudget,
  resolveCodexAppServerRecoveryRetry,
} from "./run/codex-app-server-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type Failure = NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>;

function makeCodexFailureAttempt(
  failureOverrides: Partial<Failure> = {},
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    codexAppServerFailure: {
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
      ...failureOverrides,
    },
    ...attemptOverrides,
  });
}

describe("Codex app-server recovery decision", () => {
  it("keeps the local recovery retry inside the outer run-loop budget", () => {
    expect(
      hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: false,
        runLoopIterations: 1,
        maxRunLoopIterations: 2,
      }),
    ).toBe(true);
    expect(
      hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: true,
        runLoopIterations: 1,
        maxRunLoopIterations: 2,
      }),
    ).toBe(false);
    expect(
      hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: false,
        runLoopIterations: 2,
        maxRunLoopIterations: 2,
      }),
    ).toBe(false);
  });

  it("retries a replay-safe stdio client close", () => {
    expect(
      resolveCodexAppServerRecoveryRetry({
        attempt: makeCodexFailureAttempt(),
        retryAvailable: true,
      }),
    ).toEqual({ retry: true });
  });

  it("retries only completion-watch idle timeouts", () => {
    expect(
      resolveCodexAppServerRecoveryRetry({
        attempt: makeCodexFailureAttempt({
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
        }),
        retryAvailable: true,
      }),
    ).toEqual({ retry: true });
    expect(
      resolveCodexAppServerRecoveryRetry({
        attempt: makeCodexFailureAttempt({
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "progress",
        }),
        retryAvailable: true,
      }),
    ).toEqual({ retry: false, reason: "progress" });
  });

  it.each([
    ["websocket transports", { transport: "websocket" }, {}, true, "non_stdio_transport"],
    ["an exhausted retry", {}, {}, false, "retry_exhausted"],
    ["provider-declared replay risk", { replaySafe: false }, {}, true, "replay_unsafe"],
    [
      "attempt replay risk",
      {},
      { replayMetadata: { replaySafe: false, replayBlockedReason: "tool_activity" } },
      true,
      "replay_unsafe",
    ],
    ["visible assistant output", {}, { assistantTexts: ["partial"] }, true, "assistant_output"],
    [
      "tool activity",
      {},
      {
        replayMetadata: { replaySafe: true },
        toolMetas: [{ toolName: "write", replaySafe: false }],
      },
      true,
      "tool_activity",
    ],
    [
      "active item lifecycle",
      {},
      { itemLifecycle: { startedCount: 1, activeCount: 1 } },
      true,
      "active_item",
    ],
  ] as const)(
    "does not retry %s",
    (_label, failureOverrides, attemptOverrides, retryAvailable, reason) => {
      expect(
        resolveCodexAppServerRecoveryRetry({
          attempt: makeCodexFailureAttempt(
            failureOverrides as Partial<Failure>,
            attemptOverrides as Partial<EmbeddedRunAttemptResult>,
          ),
          retryAvailable,
        }),
      ).toEqual({ retry: false, reason });
    },
  );
});
