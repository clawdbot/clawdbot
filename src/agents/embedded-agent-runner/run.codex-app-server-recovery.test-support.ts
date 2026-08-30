// Full-entry coverage for replay-safe Codex app-server recovery retries.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

const CODEX_MISSING_TERMINAL_MESSAGE =
  "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";

function codexClientClosedAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  // Stdio client-close failures can be replay-safe when Codex reports that the
  // turn ended before completion and no user-visible side effect escaped.
  return makeAttemptResult({
    assistantTexts: [],
    terminal: {
      kind: "failed",
      source: "prompt",
      error: new Error("codex app-server client closed before turn completed"),
    },
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
    terminal: {
      kind: "timeout",
      phase: "prompt",
      source: "runtime",
      aborted: true,
      failure: {
        source: "prompt",
        error: new Error("codex app-server turn idle timed out waiting for turn/completed"),
      },
    },
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
    assistantTexts: ["Done."],
  });
}

function ordinaryPromptFailureAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    terminal: { kind: "failed", source: "prompt", error: new Error("codex exploded") },
  });
}

function asAttemptParams(value: unknown): EmbeddedRunAttemptParams {
  return value as EmbeddedRunAttemptParams;
}

describe("runEmbeddedAgent Codex app-server recovery", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.codex-app-server-recovery" });
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("keeps shared abort ownership open through a replay-safe retry", async () => {
    const freezeAbort = vi.fn();
    const replyOperation = {
      freezeAbort,
      markDeferredMaintenanceWaitEnded: vi.fn(),
      markGlobalLaneWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
      markWaitingForGlobalLane: vi.fn(),
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
      ...createOverflowRunParams(state),
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
        ...createOverflowRunParams(state),
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
        ...createOverflowRunParams(state),
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
      markGlobalLaneWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
      markWaitingForGlobalLane: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof runEmbeddedAgent>[0]["replyOperation"]>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return codexClientClosedAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
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
      markGlobalLaneWaitEnded: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
      markWaitingForGlobalLane: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof runEmbeddedAgent>[0]["replyOperation"]>;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      controller.abort(upstreamAbort);
      asAttemptParams(attemptParams).onAttemptAbort?.();
      return codexClientClosedAttempt();
    });

    await expect(
      runEmbeddedAgent({
        ...createOverflowRunParams(state),
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
      ...createOverflowRunParams(state),
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry-mirror",
    });

    expect(
      (
        expectDefined(
          mockedRunEmbeddedAttempt.mock.calls[1],
          "mockedRunEmbeddedAttempt.mock.calls[1] test invariant",
        )[0] as {
          suppressNextUserMessagePersistence?: boolean;
        }
      ).suppressNextUserMessagePersistence,
    ).toBe(true);
  });

  it("returns a timeout payload after a replay-safe turn/completed idle timeout retry is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt());

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
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
      ...createOverflowRunParams(state),
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-outer-fallback",
      isFinalFallbackAttempt: false,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not hand Codex app-server idle timeouts to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
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
      ...createOverflowRunParams(state),
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
});
