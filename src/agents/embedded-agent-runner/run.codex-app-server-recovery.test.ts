// Coverage for replay-safe Codex app-server recovery retries.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { hasCodexAppServerRecoveryRetryBudget } from "./run/codex-app-server-recovery.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

const CODEX_MISSING_TERMINAL_MESSAGE =
  "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";

function codexClientClosedAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  // Stdio client-close failures can be replay-safe when Codex reports that the
  // turn ended before completion and no user-visible side effect escaped.
  return makeAttemptResult({
    assistantTexts: [],
    promptError: new Error("codex app-server client closed before turn completed"),
    promptErrorSource: "prompt",
    codexAppServerFailure: {
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
    },
    ...overrides,
  });
}

function codexTurnCompletionIdleTimeoutAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  // Completion-watch idle timeouts are retried separately from progress timeouts
  // because only the former indicates Codex may have lost the final event.
  return makeAttemptResult({
    assistantTexts: [],
    aborted: true,
    timedOut: true,
    promptError: new Error("codex app-server turn idle timed out waiting for turn/completed"),
    promptErrorSource: "prompt",
    promptTimeoutOutcome: {
      message: CODEX_MISSING_TERMINAL_MESSAGE,
    },
    codexAppServerFailure: {
      kind: "turn_completion_idle_timeout",
      turnWatchTimeoutKind: "completion",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
    },
    ...overrides,
  });
}

function successAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    promptError: null,
    assistantTexts: ["Done."],
  });
}

function ordinaryPromptFailureAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    promptError: new Error("codex exploded"),
    promptErrorSource: "prompt",
  });
}

function asAttemptParams(value: unknown): EmbeddedRunAttemptParams {
  return value as EmbeddedRunAttemptParams;
}

describe("runEmbeddedAgent Codex app-server recovery", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("does not advertise recovery after the outer run-loop budget is exhausted", () => {
    expect(
      hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: false,
        runLoopIterations: 32,
        maxRunLoopIterations: 32,
      }),
    ).toBe(false);
    expect(
      hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: false,
        runLoopIterations: 31,
        maxRunLoopIterations: 32,
      }),
    ).toBe(true);
  });

  it("retries a replay-safe stdio client close once", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexClientClosedAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("keeps shared abort ownership open through a replay-safe retry", async () => {
    const freezeAbort = vi.fn();
    const replyOperation = {
      freezeAbort,
      markDeferredMaintenanceWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof runEmbeddedAgent>[0]["replyOperation"]>;
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async () => {
        expect(freezeAbort).not.toHaveBeenCalled();
        return codexClientClosedAttempt();
      })
      .mockImplementationOnce(async () => {
        expect(freezeAbort).not.toHaveBeenCalled();
        return successAttempt();
      });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-freeze-after-retry",
      replyOperation,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it("does not replay after cancellation during replay-safe finalization", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return codexClientClosedAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-cancel-before-retry",
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "agent run aborted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("stops ordinary failure handling after cancellation during finalization", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return ordinaryPromptFailureAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-cancel-ordinary-failure",
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "agent run aborted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not expose a cancelled replay-safe failure to outer model fallback", async () => {
    const abortByUser = vi.fn(() => true);
    const replyOperation = {
      abortByUser,
      markDeferredMaintenanceWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof runEmbeddedAgent>[0]["replyOperation"]>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return codexClientClosedAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-cancel-before-model-fallback",
        isFinalFallbackAttempt: false,
        replyOperation,
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "agent run aborted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(abortByUser).toHaveBeenCalledTimes(1);
  });

  it("preserves upstream abort ownership during replay-safe finalization", async () => {
    const controller = new AbortController();
    const upstreamAbort = new Error("upstream cancelled");
    const abortByUser = vi.fn(() => true);
    const replyOperation = {
      abortByUser,
      markDeferredMaintenanceWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof runEmbeddedAgent>[0]["replyOperation"]>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      controller.abort(upstreamAbort);
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return codexClientClosedAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-upstream-cancel-before-model-fallback",
        isFinalFallbackAttempt: false,
        abortSignal: controller.signal,
        replyOperation,
      }),
    ).rejects.toBe(upstreamAbort);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(abortByUser).not.toHaveBeenCalled();
  });

  it("suppresses duplicate Codex prompt mirroring on retry", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexClientClosedAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry-mirror",
    });

    expect(
      (
        mockedRunEmbeddedAttempt.mock.calls[1][0] as {
          suppressNextUserMessagePersistence?: boolean;
        }
      ).suppressNextUserMessagePersistence,
    ).toBe(true);
  });

  it("suppresses duplicate user persistence when retrying after the inbound message was persisted", async () => {
    // If the first attempt already persisted the inbound message, the retry must
    // not mirror it again into the transcript.
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.({ role: "user", content: overflowBaseRunParams.prompt });
        return codexClientClosedAttempt();
      })
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry-persisted",
      currentMessageId: "msg-1",
    });

    expect(
      (
        mockedRunEmbeddedAttempt.mock.calls[1][0] as {
          suppressNextUserMessagePersistence?: boolean;
        }
      ).suppressNextUserMessagePersistence,
    ).toBe(true);
  });

  it("does not retry websocket client closes", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexClientClosedAttempt({
        codexAppServerFailure: {
          kind: "client_closed_before_turn_completed",
          transport: "websocket",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
        promptTimeoutOutcome: undefined,
      }),
    );

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-client-close-websocket",
      }),
    ).rejects.toThrow("codex app-server client closed before turn completed");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries a replay-safe stdio turn/completed idle timeout once", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-completion Codex turn watch timeouts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "progress",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
        promptTimeoutOutcome: undefined,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-progress-idle-timeout",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("returns a timeout payload after a replay-safe turn/completed idle timeout retry is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt());

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-retry-exhausted",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: CODEX_MISSING_TERMINAL_MESSAGE,
    });
    expect(result.meta.timeoutPhase).toBe("provider");
    expect(result.meta.providerStarted).toBe(true);
    expect(result.meta.error).toEqual({
      kind: "incomplete_turn",
      message: CODEX_MISSING_TERMINAL_MESSAGE,
      fallbackSafe: false,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("keeps retry ownership open for an outer fallback after local recovery is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-outer-fallback",
      isFinalFallbackAttempt: false,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("surfaces non-stdio turn/completed idle timeouts instead of throwing", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
          transport: "websocket",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-websocket",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: CODEX_MISSING_TERMINAL_MESSAGE,
    });
    expect(result.meta.error).toEqual({
      kind: "incomplete_turn",
      message: CODEX_MISSING_TERMINAL_MESSAGE,
      fallbackSafe: false,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("does not hand Codex app-server idle timeouts to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        timedOut: true,
        didSendViaMessagingTool: true,
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        promptTimeoutOutcome: {
          message:
            "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: false,
          replayBlockedReason: "potential_side_effect",
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
    });
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("abandoned");
    expect(result.meta.error).toEqual({
      kind: "incomplete_turn",
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      fallbackSafe: false,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("does not retry after visible assistant output", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexClientClosedAttempt({
        assistantTexts: ["partial answer"],
        codexAppServerFailure: {
          kind: "client_closed_before_turn_completed",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: false,
          replayBlockedReason: "assistant_output",
        },
      }),
    );

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-client-close-visible-output",
      }),
    ).rejects.toThrow("codex app-server client closed before turn completed");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
