import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  getCliSessionIdMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  resolveAgentConfigMock,
  resolveAgentModelFallbacksOverrideMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSupportedThinkingLevelMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
  runCliAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "model-fwd-job",
    name: "Model Forward Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "summarize",
      model: "google/gemini-2.0-flash",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "summarize",
    sessionKey: "cron:model-fwd",
    ...overrides,
  };
}

function makeSuccessfulRunResult(provider = "google", model = "gemini-2.0-flash") {
  return {
    result: {
      payloads: [{ text: "summary done" }],
      meta: {
        agentMeta: {
          model,
          provider,
          usage: { input: 100, output: 50 },
        },
      },
    },
    provider,
    model,
    attempts: [],
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return requireRecord(mock.mock.calls[0]?.[0]);
}

function hasPhaseWithFields(phases: unknown[], fields: Record<string, unknown>): boolean {
  return phases.some((phase) => {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
      return false;
    }
    const record = phase as Record<string, unknown>;
    return Object.entries(fields).every(([key, value]) => record[key] === value);
  });
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — cron model override forwarding (#58065)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    // Agent default model is Opus (anthropic)
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    // Cron payload model override resolves to gemini
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      if (raw.includes("gemini")) {
        return { ref: { provider: "google", model: "gemini-2.0-flash" } };
      }
      return { ref: { provider: "anthropic", model: "claude-opus-4-6" } };
    });

    resolveAgentConfigMock.mockReturnValue(undefined);
    updateSessionStoreMock.mockResolvedValue(undefined);

    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: true,
      }),
    );
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes the cron payload model override to runWithModelFallback", async () => {
    // Track the provider/model passed to runWithModelFallback
    let capturedProvider: string | undefined;
    let capturedModel: string | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string }) => {
        capturedProvider = params.provider;
        capturedModel = params.model;
        return makeSuccessfulRunResult();
      },
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    // The cron payload specifies google/gemini-2.0-flash — that must be
    // what reaches runWithModelFallback, not the agent default (opus).
    expect(capturedProvider).toBe("google");
    expect(capturedModel).toBe("gemini-2.0-flash");
  });

  it("passes the cron payload model to the embedded agent runner", async () => {
    // Use passthrough so runEmbeddedPiAgentMock actually gets called
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "summary done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    const embeddedCall = firstMockArg(runEmbeddedPiAgentMock);
    expect(embeddedCall.provider).toBe("google");
    expect(embeddedCall.model).toBe("gemini-2.0-flash");
  });

  it("forwards isolated cron execution phase updates from embedded runs", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedPiAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
        firstModelCallStarted: true,
      });
      return {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      };
    });
    const phases: unknown[] = [];

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        onExecutionPhase: (info: unknown) => phases.push(info),
      }),
    );

    expect(result.status).toBe("ok");
    expect(
      hasPhaseWithFields(phases, {
        jobId: "model-fwd-job",
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
        firstModelCallStarted: true,
      }),
    ).toBe(true);
  });

  it("does not mark CLI cron runs as model-started before CLI session resolution", async () => {
    isCliProviderMock.mockReturnValue(true);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: false,
      }),
    );
    const getCliSessionStarted = createDeferred();
    const releaseCliSessionLookup = createDeferred<string | undefined>();
    getCliSessionIdMock.mockImplementation(async () => {
      getCliSessionStarted.resolve();
      return await releaseCliSessionLookup.promise;
    });
    runCliAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
        firstModelCallStarted: true,
      });
      return {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      };
    });
    const phases: unknown[] = [];

    const runPromise = runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
        onExecutionPhase: (info: unknown) => phases.push(info),
      }),
    );

    await getCliSessionStarted.promise;
    expect(
      hasPhaseWithFields(phases, {
        phase: "model_call_started",
        firstModelCallStarted: true,
      }),
    ).toBe(false);

    releaseCliSessionLookup.resolve("previous-cli-session");
    const result = await runPromise;

    expect(result.status).toBe("ok");
    const cliCall = firstMockArg(runCliAgentMock);
    expect(cliCall.cliSessionId).toBe("previous-cli-session");
    expect(typeof cliCall.onExecutionPhase).toBe("function");
    expect(
      hasPhaseWithFields(phases, {
        phase: "model_call_started",
        firstModelCallStarted: true,
      }),
    ).toBe(true);
  });

  it("validates cron thinking with catalog reasoning metadata", async () => {
    resolveAllowedModelRefMock.mockImplementation(() => ({
      ref: { provider: "ollama", model: "qwen3:0.6b" },
    }));
    loadModelCatalogMock.mockResolvedValue([
      {
        provider: "ollama",
        id: "qwen3:0.6b",
        name: "qwen3:0.6b",
        reasoning: true,
      },
    ]);
    isThinkingLevelSupportedMock.mockImplementation(
      ({ catalog, level }: { catalog?: Array<{ reasoning?: boolean }>; level?: string }) =>
        level === "medium" && catalog?.[0]?.reasoning === true,
    );
    resolveSupportedThinkingLevelMock.mockReturnValue("off");
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });

    await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "ollama/qwen3:0.6b",
            thinking: "medium",
          },
        }),
      }),
    );

    const thinkingCall = firstMockArg(isThinkingLevelSupportedMock);
    expect(thinkingCall.provider).toBe("ollama");
    expect(thinkingCall.model).toBe("qwen3:0.6b");
    expect(thinkingCall.level).toBe("medium");
    const catalog = Array.isArray(thinkingCall.catalog) ? thinkingCall.catalog : [];
    const catalogEntry = requireRecord(catalog[0]);
    expect(catalogEntry.provider).toBe("ollama");
    expect(catalogEntry.id).toBe("qwen3:0.6b");
    expect(catalogEntry.reasoning).toBe(true);

    const embeddedCall = firstMockArg(runEmbeddedPiAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("qwen3:0.6b");
    expect(embeddedCall.thinkLevel).toBe("medium");
  });

  it("does not add agent primary model as fallback when cron payload model is set", async () => {
    // No per-agent fallbacks configured — resolveAgentModelFallbacksOverride
    // returns undefined in that case. Before the fix, this caused
    // runWithModelFallback to receive fallbacksOverride=undefined, which
    // made it append the agent primary model as a last-resort candidate.
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(makeParams());

    // With the fix, the shared override helper resolves an explicit empty
    // list here: no configured fallback chain, and no silent agent-primary
    // append on retry.
    expect(capturedFallbacksOverride).toStrictEqual([]);
  });

  it("preserves default fallback chain for cron payload model overrides", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                provider: "anthropic",
                model: "claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
              },
            },
          },
        },
      }),
    );

    expect(capturedFallbacksOverride).toEqual(["openai/gpt-5.4", "google/gemini-2.5-pro"]);
  });

  it("preserves agent fallbacks when no cron payload model is set", async () => {
    // Job without model override
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
    });

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("anthropic", "claude-opus-4-6");
      },
    );

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    // Without a payload model override, fallbacksOverride should remain
    // undefined so the agent primary model IS available as a last-resort
    // fallback (existing behavior preserved).
    expect(capturedFallbacksOverride).toBeUndefined();
  });

  it("uses explicit payload fallbacks when both model and fallbacks are set", async () => {
    const jobWithFallbacks = makeJob({
      payload: {
        kind: "agentTurn",
        message: "summarize",
        model: "google/gemini-2.0-flash",
        fallbacks: ["openai/gpt-4o"],
      },
    });

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithFallbacks }));

    expect(capturedFallbacksOverride).toEqual(["openai/gpt-4o"]);
  });
});
