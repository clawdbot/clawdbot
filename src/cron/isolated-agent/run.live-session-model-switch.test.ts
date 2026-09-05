// Live session model switch tests cover model changes during isolated cron runs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  patchSessionEntryMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "cron-model-switch-job",
    name: "Model Switch Test",
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "run task",
      // Cron requests sonnet; agent primary is opus
      model: "anthropic/claude-sonnet-4-6",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run task",
    sessionKey: "cron:model-switch",
    ...overrides,
  };
}

function makeSuccessfulRunResult(modelUsed = "claude-sonnet-4-6") {
  return {
    result: {
      payloads: [{ text: "task complete" }],
      meta: {
        agentMeta: {
          model: modelUsed,
          provider: "anthropic",
          usage: { input: 100, output: 50 },
        },
      },
    },
    provider: "anthropic",
    model: modelUsed,
    attempts: [],
  };
}

function requireEmbeddedAgentCall(index: number): {
  provider?: string;
  model?: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: string;
  suppressNextUserMessagePersistence?: boolean;
  userTurnTranscriptRecorder?: {
    markRuntimePersisted: (message: { role: "user"; content: string }) => void;
  };
} {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as
    | {
        provider?: string;
        model?: string;
        agentHarnessRuntimeOverride?: string;
        authProfileId?: string;
        authProfileIdSource?: string;
        suppressNextUserMessagePersistence?: boolean;
        userTurnTranscriptRecorder?: {
          markRuntimePersisted: (message: { role: "user"; content: string }) => void;
        };
      }
    | undefined;
  if (!call) {
    throw new Error(`Expected embedded OpenClaw agent call ${index}`);
  }
  return call;
}

describe("runCronIsolatedAgentTurn — LiveSessionModelSwitchError retry (#57206)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(async () => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: true,
      }),
    );
    logWarnMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (previousFastTestEnv !== undefined) {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    } else {
      delete process.env.OPENCLAW_TEST_FAST;
    }
  });

  it("retries with the requested model when runWithModelFallback throws LiveSessionModelSwitchError on the first attempt", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      callCount++;
      if (callCount === 1) {
        // First attempt: session started with opus, throw to request sonnet
        throw switchError;
      }
      // Second attempt: should now be called with sonnet
      expect(params.provider).toBe("anthropic");
      expect(params.model).toBe("claude-sonnet-4-6");
      return makeSuccessfulRunResult("claude-sonnet-4-6");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("persists switched provider/model before retrying", async () => {
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        model: undefined,
        modelProvider: undefined,
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    runWithModelFallbackMock.mockImplementation(async () => {
      throw switchError;
    });
    runWithModelFallbackMock
      .mockRejectedValueOnce(switchError)
      .mockRejectedValueOnce(new Error("transient network error"));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("transient network error");
    expect(patchSessionEntryMock).toHaveBeenCalled();
    expect(cronSession.sessionEntry.model).toBe("claude-sonnet-4-6");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });

  it("propagates a legacy source-less user auth profile into the run", async () => {
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-a",
      source: "user",
      routeRequirement: undefined,
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          authProfileOverride: "profile-a",
        }),
        isNewSession: false,
      }),
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(requireEmbeddedAgentCall(0)).toMatchObject({
      authProfileId: "profile-a",
      authProfileIdSource: "user",
    });
    expect(runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ userLockedAuthProfileId: "profile-a" }),
    );
  });

  it("keeps a resolved fallback profile automatic when it differs from the stored pin", async () => {
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-b",
      source: "auto",
      routeRequirement: undefined,
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          authProfileOverride: "profile-a",
        }),
        isNewSession: false,
      }),
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(requireEmbeddedAgentCall(0)).toMatchObject({
      authProfileId: "profile-b",
      authProfileIdSource: "auto",
    });
    expect(runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ userLockedAuthProfileId: undefined }),
    );
  });

  it("retries with switched auth profile state from LiveSessionModelSwitchError", async () => {
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-a",
      source: "auto",
      routeRequirement: undefined,
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        model: undefined,
        modelProvider: undefined,
        authProfileOverride: "profile-a",
        compactionCount: 7,
        authProfileOverrideCompactionCount: 7,
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    runEmbeddedAgentMock
      .mockImplementationOnce(async (request) => {
        request.userTurnTranscriptRecorder?.markRuntimePersisted({
          role: "user",
          content: "run task",
        });
        throw new LiveSessionModelSwitchError({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "task complete" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: { input: 100, output: 50 },
          },
        },
      });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    const retryParams = requireEmbeddedAgentCall(1);
    expect(retryParams.provider).toBe("anthropic");
    expect(retryParams.model).toBe("claude-sonnet-4-6");
    expect(retryParams.authProfileId).toBe("profile-b");
    expect(retryParams.authProfileIdSource).toBe("user");
    const firstParams = requireEmbeddedAgentCall(0);
    expect(firstParams.authProfileIdSource).toBe("auto");
    expect(runWithModelFallbackMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userLockedAuthProfileId: undefined }),
    );
    expect(runWithModelFallbackMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userLockedAuthProfileId: "profile-b" }),
    );
    expect(retryParams.userTurnTranscriptRecorder).toBe(firstParams.userTurnTranscriptRecorder);
    expect(firstParams.suppressNextUserMessagePersistence).toBe(false);
    expect(retryParams.suppressNextUserMessagePersistence).toBe(true);
    expect(cronSession.sessionEntry.authProfileOverride).toBe("profile-b");
    expect(cronSession.sessionEntry.authProfileOverrideSource).toBe("user");
  });

  it("retries a same-model switch with the runtime carried by the error", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        agentRuntimeOverride: "openclaw",
        contextTokens: 272_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: {} as NonNullable<
          ReturnType<typeof makeCronSessionEntry>["contextBudgetStatus"]
        >,
      }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    runEmbeddedAgentMock
      .mockRejectedValueOnce(
        new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        }),
      )
      .mockResolvedValueOnce({
        payloads: [{ text: "task complete" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.6-luna",
            usage: { input: 100, output: 50 },
          },
        },
      });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "run task",
            model: "openai/gpt-5.6-luna",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireEmbeddedAgentCall(0).agentHarnessRuntimeOverride).toBe("openclaw");
    expect(requireEmbeddedAgentCall(1).agentHarnessRuntimeOverride).toBe("codex");
    expect(cronSession.sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(cronSession.sessionEntry.contextTokens).toBe(128_000);
    expect(cronSession.sessionEntry.contextTokensSource).toBe("resolved");
    expect(cronSession.sessionEntry.contextBudgetStatus).toBeUndefined();
  });

  it("returns error (not infinite loop) when LiveSessionModelSwitchError is thrown repeatedly", async () => {
    // If the runner somehow keeps throwing the same error (e.g. broken catalog)
    // it should not loop forever. The inner runPrompt itself will eventually
    // surface an error from within the model fallback path, but we simulate
    // a different error on the second attempt to ensure the outer catch still works.
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        throw switchError;
      }
      // Second attempt throws a different error — should propagate up
      throw new Error("transient network error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("transient network error");
    // Switched once, then failed
    expect(callCount).toBe(2);
  });

  it("aborts after exceeding LiveSessionModelSwitchError retry limit (#58466)", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw switchError;
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    // Circuit breaker: max 2 retries → 3 total attempts (initial + 2 retries)
    expect(callCount).toBe(3);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[cron:cron-model-switch-job] LiveSessionModelSwitchError retry limit reached (2); aborting",
    );
  });

  it("does not retry when the thrown error is not a LiveSessionModelSwitchError", async () => {
    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw new Error("some other error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(callCount).toBe(1);
  });

  it("retains observed usage across LiveSessionModelSwitchError retries", async () => {
    // A candidate that reported spend before the model switch must carry its
    // usage into the retry candidate's budget tripwire. Without the carry,
    // candidate B starts fresh at 0 and 150 < 200 does not trip; with it,
    // 150 (A) + 150 (B) = 300 ≥ 200 trips the shared guard.
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const candidateSignals: Array<{ candidate: string; abortedAfterUsage: boolean }> = [];
    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(
      async ({ run }: { run: (p: string, m: string) => Promise<unknown> }) => {
        callCount++;
        if (callCount === 1) {
          // First attempt: candidate A reports usage then triggers a model switch.
          const result = await run("anthropic", "claude-opus-4-6");
          return result;
        }
        const result = await run("anthropic", "claude-sonnet-4-6");
        return { result, provider: "anthropic", model: "claude-sonnet-4-6", attempts: [] };
      },
    );
    runEmbeddedAgentMock.mockImplementation(
      async (call: {
        abortSignal?: AbortSignal;
        onRunUsageTotals?: (usage: { total: number }) => void;
      }) => {
        const signal = call.abortSignal;
        call.onRunUsageTotals?.({ total: 150 });
        candidateSignals.push({
          candidate: candidateSignals.length === 0 ? "opus" : "sonnet",
          abortedAfterUsage: signal?.aborted ?? false,
        });
        if (candidateSignals.length === 1) {
          // First candidate reports 150 then triggers a model switch.
          throw switchError;
        }
        return {
          payloads: [{ text: "switched result" }],
          meta: {
            agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6", usage: { total: 150 } },
          },
        };
      },
    );

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        ...makeJob(),
        payload: { kind: "agentTurn", message: "run task", tokenBudget: 200 },
      },
    });

    expect(candidateSignals).toHaveLength(2);
    // First candidate reported 150 (no trip yet) then switched.
    expect(candidateSignals[0]).toEqual({ candidate: "opus", abortedAfterUsage: false });
    // Second candidate inherited the 150 carry; its 150 report trips 150+150=300.
    expect(candidateSignals[1].candidate).toBe("sonnet");
    expect(candidateSignals[1].abortedAfterUsage).toBe(true);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Token budget exhausted");
  });
});
