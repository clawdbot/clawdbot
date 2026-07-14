// Cron model override forwarding tests cover passing overrides into agent runs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCliSessionMock,
  clearFastTestEnv,
  getCliSessionBindingMock,
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
  resolveEffectiveAgentRuntimeMock,
  resolveThinkingDefaultMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  setCliSessionBindingMock,
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
    // Use passthrough so runEmbeddedAgentMock actually gets called
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "summary done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("google");
    expect(embeddedCall.model).toBe("gemini-2.0-flash");
  });

  it("forwards isolated cron execution phase updates from embedded runs", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
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
    const releaseCliSessionLookup = createDeferred<
      | {
          sessionId: string;
          reseedReceipt: {
            version: 1;
            promptHash: string;
            localSessionId: string;
            userTurnDisposition: "persisted" | "omitted";
          };
        }
      | undefined
    >();
    getCliSessionBindingMock.mockImplementation(async () => {
      getCliSessionStarted.resolve();
      return await releaseCliSessionLookup.promise;
    });
    runCliAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
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
      }),
    ).toBe(false);

    const cliSessionBinding = {
      sessionId: "previous-cli-session",
      reseedReceipt: {
        version: 1 as const,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted" as const,
      },
    };
    releaseCliSessionLookup.resolve(cliSessionBinding);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    const cliCall = firstMockArg(runCliAgentMock);
    expect(cliCall.cliSessionId).toBe("previous-cli-session");
    expect(cliCall.cliSessionBinding).toEqual(cliSessionBinding);
    expect(typeof cliCall.onExecutionPhase).toBe("function");
    expect(
      hasPhaseWithFields(phases, {
        phase: "model_call_started",
      }),
    ).toBe(true);
  });

  it("clears stale CLI bindings when cron CLI replacement is unflushed", async () => {
    isCliProviderMock.mockReturnValue(true);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        cliSessionBindings: {
          "claude-cli": { sessionId: "stale-cli-session" },
          "codex-cli": { sessionId: "codex-session" },
        },
      }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "summary done" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-6",
          sessionId: "",
          clearCliSessionBinding: true,
          usage: { input: 10, output: 20 },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(clearCliSessionMock).toHaveBeenCalledWith(cronSession.sessionEntry, "claude-cli");
  });

  it("persists complete CLI bindings after cron runs", async () => {
    isCliProviderMock.mockReturnValue(true);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry(),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const cliSessionBinding = {
      sessionId: "fresh-cli-session",
      reseedReceipt: {
        version: 1 as const,
        promptHash: "a".repeat(64),
        localSessionId: cronSession.sessionEntry.sessionId,
        userTurnDisposition: "persisted",
      },
    };
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "summary done" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-6",
          sessionId: "fresh-cli-session",
          cliSessionBinding,
          usage: { input: 10, output: 20 },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(setCliSessionBindingMock).toHaveBeenCalledWith(
      cronSession.sessionEntry,
      "claude-cli",
      cliSessionBinding,
    );
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

    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("qwen3:0.6b");
    expect(embeddedCall.thinkLevel).toBe("medium");
  });

  it("passes the resolved default thinking level to the embedded agent runner", async () => {
    resolveThinkingDefaultMock.mockReturnValue("low");
    isThinkingLevelSupportedMock.mockReturnValue(true);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn(makeParams());

    expect(resolveThinkingDefaultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-2.0-flash",
      }),
    );
    expect(firstMockArg(runEmbeddedAgentMock).thinkLevel).toBe("low");
  });

  it("uses a stored cron-session thinking preference before configured defaults", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-5.6-luna" },
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("openclaw");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          modelOverride: "gpt-5.6-luna",
          providerOverride: "openai",
          modelOverrideSource: "user",
          agentRuntimeOverride: "openclaw",
          thinkingLevel: "ultra",
        }),
        isNewSession: true,
      }),
    );
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));

    await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-luna",
          },
        }),
      }),
    );

    expect(resolveThinkingDefaultMock).not.toHaveBeenCalled();
    expect(isThinkingLevelSupportedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        level: "ultra",
        agentRuntime: "openclaw",
      }),
    );
    expect(firstMockArg(runEmbeddedAgentMock).thinkLevel).toBe("ultra");
  });

  it.each([
    { model: "gpt-5.6-sol", requested: "ultra", supported: true, expected: "ultra" },
    { model: "gpt-5.6-terra", requested: "ultra", supported: true, expected: "ultra" },
    { model: "gpt-5.6-luna", requested: "ultra", supported: false, expected: "max" },
  ])(
    "applies Codex runtime thinking policy for $model",
    async ({ model: modelId, requested, supported, expected }) => {
      resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: modelId } });
      resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
      isThinkingLevelSupportedMock.mockImplementation(
        ({ agentRuntime, level }: { agentRuntime?: string; level?: string }) =>
          agentRuntime === "codex" && level === requested && supported,
      );
      resolveSupportedThinkingLevelMock.mockReturnValue(expected);
      runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
        result: await run(provider, model),
        provider,
        model,
        attempts: [],
      }));

      await runCronIsolatedAgentTurn(
        makeParams({
          job: makeJob({
            payload: {
              kind: "agentTurn",
              message: "summarize",
              model: `openai/${modelId}`,
              thinking: requested,
            },
          }),
        }),
      );

      expect(resolveEffectiveAgentRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", modelId }),
      );
      expect(isThinkingLevelSupportedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: modelId,
          level: requested,
          agentRuntime: "codex",
        }),
      );
      if (!supported) {
        expect(resolveSupportedThinkingLevelMock).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "openai",
            model: modelId,
            level: requested,
            agentRuntime: "codex",
          }),
        );
      }
      expect(firstMockArg(runEmbeddedAgentMock).thinkLevel).toBe(expected);
    },
  );

  it("revalidates thinking for each model fallback without persisting the remap", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-5.6-sol" },
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("openclaw");
    isThinkingLevelSupportedMock.mockImplementation(
      ({ model }: { model?: string }) => model !== "gpt-5.5",
    );
    resolveSupportedThinkingLevelMock.mockImplementation(
      ({ level, model }: { level?: string; model?: string }) =>
        model === "gpt-5.5" ? "high" : level,
    );
    loadModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
      { provider: "openai", id: "gpt-5.5", reasoning: true },
    ]);
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        thinkingLevel: "ultra",
        agentRuntimeOverride: "openclaw",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      const result = await run("openai", "gpt-5.5");
      return {
        result,
        provider: "openai",
        model: "gpt-5.5",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-sol",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
      "ultra",
      "high",
    ]);
    expect(resolveSupportedThinkingLevelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        level: "ultra",
        agentRuntime: "openclaw",
      }),
    );
    expect(cronSession.sessionEntry.thinkingLevel).toBe("ultra");
  });

  it("restores the requested thinking level when a later fallback supports it", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    isThinkingLevelSupportedMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-sol" || level !== "ultra",
    );
    resolveSupportedThinkingLevelMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-luna" && level === "ultra" ? "max" : level,
    );
    loadModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
      { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
    ]);
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        thinkingLevel: "ultra",
        agentRuntimeOverride: "codex",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      const result = await run("openai", "gpt-5.6-sol");
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-sol",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
                "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-luna",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
      "max",
      "ultra",
    ]);
    expect(cronSession.sessionEntry.thinkingLevel).toBe("ultra");
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

  it("inherits default fallbacks for matching string agent model cron runs", async () => {
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
    });
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("deepseek", "deepseek-v4-pro");
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        agentId: "main",
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [{ id: "main", model: "deepseek/deepseek-v4-pro" }],
          },
        },
        job: jobWithoutModel,
      }),
    );

    expect(capturedFallbacksOverride).toEqual(["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"]);
  });

  it("inherits default fallbacks for implicit default-agent cron runs", async () => {
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
    });
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("deepseek", "deepseek-v4-pro");
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [{ id: "default", model: "deepseek/deepseek-v4-pro" }],
          },
        },
        job: jobWithoutModel,
      }),
    );

    expect(capturedFallbacksOverride).toEqual(["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"]);
  });

  it("keeps different string agent model cron runs strict after defaults are rewritten", async () => {
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
    });
    resolveAgentConfigMock.mockReturnValue({
      model: "anthropic/claude-sonnet-4-6",
    });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue([]);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6");
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        agentId: "main",
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [{ id: "main", model: "anthropic/claude-sonnet-4-6" }],
          },
        },
        job: jobWithoutModel,
      }),
    );

    expect(capturedFallbacksOverride).toStrictEqual([]);
  });

  it("keeps stored cron session model overrides strict for matching string agent models", async () => {
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
      sessionTarget: "session:existing-cron-session",
    });
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue([]);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      if (raw === "openai/gpt-5.4") {
        return { ref: { provider: "openai", model: "gpt-5.4" } };
      }
      if (raw === "deepseek/deepseek-v4-pro") {
        return { ref: { provider: "deepseek", model: "deepseek-v4-pro" } };
      }
      return { ref: { provider: "anthropic", model: "claude-opus-4-6" } };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        }),
        isNewSession: false,
      }),
    );

    let capturedProvider: string | undefined;
    let capturedModel: string | undefined;
    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedProvider = params.provider;
        capturedModel = params.model;
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("openai", "gpt-5.4");
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        agentId: "main",
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [{ id: "main", model: "deepseek/deepseek-v4-pro" }],
          },
        },
        job: jobWithoutModel,
      }),
    );

    expect(capturedProvider).toBe("openai");
    expect(capturedModel).toBe("gpt-5.4");
    expect(capturedFallbacksOverride).toStrictEqual([]);
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

  it("rejects a pre-aborted cron turn before model fallback starts", async () => {
    const controller = new AbortController();

    controller.abort(new Error("cron: job execution timed out"));

    await expect(
      runCronIsolatedAgentTurn(makeParams({ abortSignal: controller.signal })),
    ).rejects.toThrow("cron: job execution timed out");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });
});
