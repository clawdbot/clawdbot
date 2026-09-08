// Full-entry coverage for replay-safe Codex app-server recovery retries.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
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

  it("passes native deadline ownership through dispatch and fences retained callbacks", async () => {
    useOpenAIPlatformAuthFixture();
    vi.useFakeTimers();
    const entered = createDeferred<EmbeddedRunAttemptParams>();
    const finish = createDeferred<EmbeddedRunAttemptResult>();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (value) => {
      const params = asAttemptParams(value);
      params.onAttemptDeadlineChanged?.({ kind: "unlimited" });
      entered.resolve(params);
      return await finish.promise;
    });
    try {
      run = runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        runId: "runtime-deadline-handoff",
        timeoutMs: 1,
      });
      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const params = await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error("Run completed before reaching the native attempt");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      expect(params.onAttemptTimeout).toBeTypeOf("function");
      params.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() + 120_000 });
      await vi.advanceTimersByTimeAsync(125_000);
      expect(settled).toBe(false);
      finish.resolve(successAttempt());
      await expect(run).resolves.toMatchObject({ meta: { aborted: false } });

      const timerCount = vi.getTimerCount();
      params.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() });
      params.onAttemptTimeout?.(new Error("late timeout"));
      params.onAttemptAbort?.();
      expect(vi.getTimerCount()).toBe(timerCount);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt());
      await expect(
        runEmbeddedAgent({
          ...createOverflowRunParams(state),
          provider: "openai",
          model: "gpt-5.6-luna",
          runId: "runtime-deadline-successor",
        }),
      ).resolves.toMatchObject({ meta: { aborted: false } });
    } finally {
      finish.resolve(successAttempt());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it.each([
    { deadline: "execution", delivery: "partial" },
    { deadline: "execution", delivery: "completed" },
    { deadline: "execution", delivery: "message-tool" },
    { deadline: "settlement", delivery: "partial" },
    { deadline: "settlement", delivery: "completed" },
    { deadline: "settlement", delivery: "message-tool" },
  ] as const)(
    "preserves $delivery output without hiding the $deadline timeout",
    async ({ deadline, delivery }) => {
      useOpenAIPlatformAuthFixture();
      const { buildEmbeddedRunPayloads } =
        await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
      const text = "Work completed so far.";
      const message = `The runtime's ${deadline} deadline expired; verify the work before continuing.`;
      const assistant = {
        role: "assistant" as const,
        api: "responses" as const,
        provider: "openai",
        model: "gpt-5.6-luna",
        content: [{ type: "text" as const, text }],
        stopReason: "stop" as const,
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          terminal: {
            kind: "timeout",
            phase: "prompt",
            source: "runtime",
            aborted: true,
            failure: { source: "prompt", error: new Error(message) },
          },
          assistantTexts: delivery === "message-tool" ? [] : [text],
          lastAssistant: delivery === "completed" ? assistant : undefined,
          currentAttemptAssistant: delivery === "completed" ? assistant : undefined,
          currentAttemptCompletedAssistant: delivery === "completed" ? assistant : undefined,
          didSendViaMessagingTool: delivery === "message-tool",
          messagingToolSentTexts: delivery === "message-tool" ? [text] : [],
          promptTimeoutOutcome: { message, replayInvalid: true, livenessState: "abandoned" },
          ...(deadline === "settlement"
            ? {
                codexAppServerFailure: {
                  kind: "turn_settlement_timeout" as const,
                  transport: "stdio" as const,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  replaySafe: false,
                },
              }
            : {}),
        }),
      );
      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        runId: `owned-${deadline}-${delivery}`,
      });
      expect(result.payloads).toContainEqual(
        expect.objectContaining({ text: message, isError: true }),
      );
      if (delivery !== "message-tool") {
        expect(result.payloads).toContainEqual(expect.objectContaining({ text }));
      }
      expect(result.meta).toMatchObject({
        replayInvalid: true,
        livenessState: "abandoned",
        error: { kind: "incomplete_turn", message, fallbackSafe: false },
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "closed", "replaced"] as const)(
    "retries without a durable writer only while its exact native admission is active (%s)",
    async (owner) => {
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { createReplyOperation } = await import("../../auto-reply/reply/reply-run-registry.js");
      const runId = `run-native-retry-${owner}`;
      const sessionKey = `agent:main:${runId}`;
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "native-retry-test");
      const replacement = prepareSystemAgentRunAdmission({}, runId, "main", "replacement-test");
      const replyOperation = createReplyOperation({
        sessionKey,
        sessionId: runId,
        resetTriggered: false,
      });
      const freezeAbort = vi.spyOn(replyOperation, "freezeAbort");
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          expect(freezeAbort).not.toHaveBeenCalled();
          if (owner === "closed") {
            admission.close();
          }
          if (owner === "replaced") {
            await replacement.admit("embedded");
          }
          return codexClientClosedAttempt({ sessionIdUsed: runId });
        })
        .mockImplementationOnce(async () => {
          expect(freezeAbort).not.toHaveBeenCalled();
          return { ...successAttempt(), sessionIdUsed: runId };
        });

      try {
        const run = runEmbeddedAgent({
          ...createOverflowRunParams(state),
          sessionId: runId,
          sessionKey,
          provider: "codex",
          model: "gpt-5.5",
          runId,
          preparedRunAdmission: admission,
          replyOperation,
        });
        if (owner === "active") {
          await run;
        } else {
          await expect(run).rejects.toThrow("admitted run authority is no longer active");
        }
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(owner === "active" ? 2 : 1);
        expect(freezeAbort).not.toHaveBeenCalled();
      } finally {
        admission.close();
        replacement.close();
        replyOperation.complete();
        freezeAbort.mockRestore();
      }
    },
  );

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

  it.each(["turn_completion_idle_timeout", "turn_settlement_timeout"] as const)(
    "does not hand Codex app-server %s failures to model fallback",
    async (kind) => {
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
            kind,
            turnWatchTimeoutKind:
              kind === "turn_completion_idle_timeout" ? "completion" : undefined,
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
        config: createModelFallbackConfig("openai/gpt-5.5", ["anthropic/claude-opus-4-6"]),
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
    },
  );
});
