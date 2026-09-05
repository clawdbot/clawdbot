// Cron model override forwarding tests cover passing overrides into agent runs.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { buildCliRunResult } from "../../agents/cli-runner/cli-run-settlement.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  clearFastTestEnv,
  classifyEmbeddedAgentRunResultForModelFallbackMock,
  getCliSessionBindingMock,
  ensureAgentWorkspaceMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  loadModelCatalogOwnerMock,
  mockRunCronFallbackPassthrough,
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
  runCliAgentMock,
  patchSessionEntryMock,
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

function makeJobWithoutModel(overrides?: Record<string, unknown>) {
  return makeJob({
    payload: { kind: "agentTurn", message: "summarize" },
    ...overrides,
  });
}

function captureModelFallbackRun(provider = "google", model = "gemini-2.0-flash") {
  const captured: {
    provider?: string;
    model?: string;
    fallbacksOverride?: string[];
  } = {};
  runWithModelFallbackMock.mockImplementation(
    async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
      captured.provider = params.provider;
      captured.model = params.model;
      captured.fallbacksOverride = params.fallbacksOverride;
      return makeSuccessfulRunResult(provider, model);
    },
  );
  return captured;
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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

  it("builds cron context from the published replacement owner", async () => {
    const callerConfig = { agents: { defaults: { model: "anthropic/caller" } } };
    const ownerConfig = {
      agents: {
        defaults: { model: "google/gemini-2.0-flash" },
        list: [{ id: "main", default: true, workspace: "/tmp/replacement-workspace" }],
      },
    };
    const ownerCatalog = [{ provider: "google", id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" }];
    loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/owner-agent",
      workspaceDir: "/tmp/replacement-workspace",
      config: ownerConfig,
      modelCatalog: { entries: ownerCatalog, routeVariants: [] },
    });
    ensureAgentWorkspaceMock.mockImplementationOnce(async ({ dir }: { dir: string }) => ({ dir }));
    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    const result = await runCronIsolatedAgentTurn(makeParams({ cfg: callerConfig }));

    expect(result.status).toBe("ok");
    expect(loadModelCatalogOwnerMock).toHaveBeenCalledWith({
      config: callerConfig,
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(ensureAgentWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/tmp/replacement-workspace" }),
    );
    expect(resolveCronSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: ownerConfig, agentId: "main" }),
    );
  });

  it("rejects a replacement owner that changes an explicitly requested agent", async () => {
    const callerConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
    };
    loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/main-workspace",
      config: callerConfig,
      modelCatalog: { entries: [], routeVariants: [] },
    });

    await expect(
      runCronIsolatedAgentTurn(makeParams({ cfg: callerConfig, agentId: "worker" })),
    ).rejects.toThrow("cron model catalog owner changed from worker to main");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("passes the cron payload model override to runWithModelFallback", async () => {
    const captured = captureModelFallbackRun();

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    // The cron payload specifies google/gemini-2.0-flash — that must be
    // what reaches runWithModelFallback, not the agent default (opus).
    expect(captured.provider).toBe("google");
    expect(captured.model).toBe("gemini-2.0-flash");
  });

  it("passes the cron payload model to the embedded agent runner", async () => {
    // Use passthrough so runEmbeddedAgentMock actually gets called
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockImplementation(async () => {
      return {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      };
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("google");
    expect(embeddedCall.model).toBe("gemini-2.0-flash");
    expect(embeddedCall).not.toHaveProperty("taskRunId");
  });

  it("forwards isolated cron execution phase updates from embedded runs", async () => {
    mockRunCronFallbackPassthrough();
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
    mockRunCronFallbackPassthrough();
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
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "claude-cli", model: "claude-opus-4-6" },
    });
    mockRunCronFallbackPassthrough();
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
    expect(cronSession.sessionEntry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(cronSession.sessionEntry.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "codex-session",
    });
  });

  it.each([
    "accepted",
    "rejected",
    "rejected-clear",
    "accepted-save-fails",
    "rejected-clear-save-fails",
  ])("settles %s CLI continuity before cron fallback", async (outcome) => {
    const accepted = outcome.startsWith("accepted");
    const clear = outcome.startsWith("rejected-clear");
    const saveFails = outcome.endsWith("save-fails");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "claude-cli", model: "claude-opus-4-6" },
    });
    classifyEmbeddedAgentRunResultForModelFallbackMock.mockImplementation(
      classifyEmbeddedAgentRunResultForModelFallback,
    );
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        cliSessionBindings: { "claude-cli": { sessionId: "previous-cli-session" } },
      }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const localSessionId = cronSession.sessionEntry.sessionId;
    const cliSessionBinding = {
      sessionId: "fresh-cli-session",
      reseedReceipt: {
        version: 1 as const,
        promptHash: "a".repeat(64),
        localSessionId: cronSession.sessionEntry.sessionId,
        userTurnDisposition: "persisted",
      },
    };
    const acceptedResult = {
      payloads: [{ text: "summary done" }],
      meta: {
        durationMs: 1,
        executionTrace: { runner: "cli" },
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-6",
          sessionId: "fresh-cli-session",
          cliSessionBinding,
          usage: { input: 10, output: 20 },
        },
      },
    };
    const candidateResult = accepted
      ? acceptedResult
      : buildCliRunResult({
          context: buildPreparedCliRunContext(),
          output: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, usage: { input: 10, output: 20 } },
          effectiveCliSessionId: "fresh-cli-session",
          bindingFlushOk: !clear,
          usedHistoryPrompt: false,
          userTurnHandled: true,
          sessionBindingDisabled: false,
          preparedContextAgentMeta: {},
        });
    runCliAgentMock.mockImplementationOnce(async () => {
      if (saveFails) {
        patchSessionEntryMock.mockRejectedValueOnce(new Error("synthetic continuity write failed"));
      }
      return candidateResult;
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async (
        params: TestModelFallbackRunnerParams & {
          classifyResult: typeof classifyEmbeddedAgentRunResultForModelFallback;
        },
      ) => {
        const first = await runInitialModelFallbackAttempt(params);
        if (saveFails) {
          expect(first).toMatchObject({
            payloads: expect.arrayContaining(candidateResult.payloads ?? []),
            meta: {
              replayInvalid: true,
              agentMeta: { usage: { input: 10, output: 20 } },
              error: {
                message: expect.stringContaining("CLI session continuity could not be saved"),
                fallbackSafe: false,
              },
            },
          });
          expect(
            params.classifyResult({
              result: first,
              provider: params.provider,
              model: params.model,
            }),
          ).toBeNull();
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        }
        if (accepted || saveFails) {
          return { result: first, provider: params.provider, model: params.model, attempts: [] };
        }
        expect(
          params.classifyResult({
            provider: params.provider,
            model: params.model,
            result: first,
          }),
        ).toMatchObject({ code: "generic_external_run_failure" });
        const result = await runFallbackModelAttempt(
          params,
          "google",
          "gemini-2.0-flash",
          "format",
        );
        return { result, provider: "google", model: "gemini-2.0-flash", attempts: [] };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe(saveFails ? "error" : "ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(cronSession.sessionEntry.sessionId).toBe(localSessionId);
    expect(cronSession.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual(
      saveFails
        ? { sessionId: "previous-cli-session" }
        : accepted
          ? cliSessionBinding
          : clear
            ? undefined
            : { sessionId: "previous-cli-session" },
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
    mockRunCronFallbackPassthrough();

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
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(makeParams());

    expect(resolveThinkingDefaultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-2.0-flash",
      }),
    );
    expect(firstMockArg(runEmbeddedAgentMock).thinkLevel).toBe("low");
  });

  it("rejects a rooted turn before a configured CLI runtime starts", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const params = makeParams({ executionRoot: "/tmp/workshop-skills" });
    const result = await runCronIsolatedAgentTurn(params);

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "/tmp/workshop-skills"])(
    "preserves containment with execution root %s",
    async (executionRoot) => {
      mockRunCronFallbackPassthrough();
      const result = await runCronIsolatedAgentTurn(
        makeParams({ executionRoot, cfg: { tools: { fs: { workspaceOnly: true } } } }),
      );
      expect(result.status).toBe("ok");
      expect(firstMockArg(runEmbeddedAgentMock)).toMatchObject({
        cwd: executionRoot,
        sessionRoot: executionRoot,
        requireWritableSandbox: executionRoot ? true : undefined,
        requireWorkspaceOnly: executionRoot ? true : undefined,
      });
    },
  );

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
    mockRunCronFallbackPassthrough();

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
      mockRunCronFallbackPassthrough();

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
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5.5", "unknown");
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
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5.6-sol", "unknown");
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
    const captured = captureModelFallbackRun();

    await runCronIsolatedAgentTurn(makeParams());

    // With the fix, the shared override helper resolves an explicit empty
    // list here: no configured fallback chain, and no silent agent-primary
    // append on retry.
    expect(captured.fallbacksOverride).toStrictEqual([]);
  });

  it("preserves default fallback chain for cron payload model overrides", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
    const captured = captureModelFallbackRun();

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

    expect(captured.fallbacksOverride).toEqual(["openai/gpt-5.4", "google/gemini-2.5-pro"]);
  });

  it("preserves agent fallbacks when no cron payload model is set", async () => {
    // Job without model override
    const jobWithoutModel = makeJobWithoutModel();

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
    const captured = captureModelFallbackRun("anthropic", "claude-opus-4-6");

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    // Without a payload model override, fallbacksOverride should remain
    // undefined so the agent primary model IS available as a last-resort
    // fallback (existing behavior preserved).
    expect(captured.fallbacksOverride).toBeUndefined();
  });

  it("inherits default fallbacks for matching string agent model cron runs", async () => {
    const jobWithoutModel = makeJobWithoutModel();
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    const captured = captureModelFallbackRun("deepseek", "deepseek-v4-pro");

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

    expect(captured.fallbacksOverride).toEqual([
      "deepseek/deepseek-v4-flash",
      "moonshot/kimi-k2.6",
    ]);
  });

  it("inherits default fallbacks for implicit default-agent cron runs", async () => {
    const jobWithoutModel = makeJobWithoutModel();
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    const captured = captureModelFallbackRun("deepseek", "deepseek-v4-pro");

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

    expect(captured.fallbacksOverride).toEqual([
      "deepseek/deepseek-v4-flash",
      "moonshot/kimi-k2.6",
    ]);
  });

  it("keeps different string agent model cron runs strict after defaults are rewritten", async () => {
    const jobWithoutModel = makeJobWithoutModel();
    resolveAgentConfigMock.mockReturnValue({
      model: "anthropic/claude-sonnet-4-6",
    });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue([]);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const captured = captureModelFallbackRun("anthropic", "claude-sonnet-4-6");

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

    expect(captured.fallbacksOverride).toStrictEqual([]);
  });

  it("keeps stored cron session model overrides strict for matching string agent models", async () => {
    const jobWithoutModel = makeJobWithoutModel({
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

    const captured = captureModelFallbackRun("openai", "gpt-5.4");

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

    expect(captured.provider).toBe("openai");
    expect(captured.model).toBe("gpt-5.4");
    expect(captured.fallbacksOverride).toStrictEqual([]);
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

    const captured = captureModelFallbackRun();

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithFallbacks }));

    expect(captured.fallbacksOverride).toEqual(["openai/gpt-4o"]);
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
