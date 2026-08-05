import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { AgentHarness } from "../harness/types.js";
import type { AgentInternalEvent } from "../internal-events.js";
import {
  expectMockCallFields,
  expectRecordFields,
  expectRuntimePlanFields,
  makeForwardedRuntimePlan,
  makeForwardingCase,
} from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedEnsureAuthProfileStore,
  mockedEvaluateContextWindowGuard,
  mockedGlobalHookRunner,
  mockedResolveAuthProfileOrder,
  mockedResolveContextWindowInfo,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent continuation model routing", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("reports hook-selected models as normal selected models, not fallbacks", async () => {
    useOpenAIPlatformAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_model_resolve",
    );
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValueOnce({
      providerOverride: "openai",
      modelOverride: "hook-selected-model",
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "initial-model",
      runId: "run-before-model-resolve-runtime-settings",
    });

    expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledTimes(1);
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      provider: "openai",
      modelId: "hook-selected-model",
      requestedModelId: "hook-selected-model",
      fallbackActive: false,
      fallbackReason: null,
    });
  });

  it("revalidates Ultra after a model hook replaces the selected model", async () => {
    useOpenAIPlatformAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_model_resolve",
    );
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValueOnce({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-responses",
        reasoning: true,
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: "ultra",
      agentHarnessRuntimeOverride: "openclaw",
      runId: "run-before-model-resolve-thinking-revalidation",
    });

    expectMockCallFields(mockedRunEmbeddedAttempt, {
      provider: "openai",
      modelId: "gpt-5.5",
      thinkLevel: "xhigh",
    });
  });

  it("passes resolved auth profile into run attempts for context-engine afterTurn propagation", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-auth-profile-passthrough",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "test-profile",
      authProfileIdSource: "auto",
    });
  });

  it("forwards optional attempt params and the runtime plan into one attempt call", async () => {
    const internalEvents: AgentInternalEvent[] = [];
    const forwardingCase = makeForwardingCase(internalEvents);
    const runtimePlan = makeForwardedRuntimePlan();
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      ...forwardingCase.params,
      runId: forwardingCase.runId,
    });

    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const forwardedAttempt = expectMockCallFields(
      mockedRunEmbeddedAttempt,
      forwardingCase.expected,
    );
    expectRuntimePlanFields(forwardedAttempt.runtimePlan, {
      resolvedRef: {
        provider: "anthropic",
        modelId: "test-model",
      },
    });
    const forwardedPlan = expectRecordFields(forwardedAttempt.runtimePlan, {});
    const forwardedTools = expectRecordFields(forwardedPlan.tools, {});
    expect(typeof forwardedTools.normalize).toBe("function");
    const forwardedTransport = expectRecordFields(forwardedPlan.transport, {});
    expect(typeof forwardedTransport.resolveExtraParams).toBe("function");
    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as EmbeddedRunAttemptParams;
    expect(attemptParams.runtimePlan).toBe(runtimePlan);
    expect(attemptParams.internalEvents).toBe(internalEvents);
    expect(attemptParams.agentHarnessId).toBe("openclaw");
    expect(attemptParams.agentHarnessRuntimeOverride).toBe("openclaw");
  });

  it("routes non-empty request stream params through OpenClaw before auth preparation", async () => {
    useOpenAIPlatformAuthFixture();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      streamParams: { maxTokens: 64 },
      runId: "request-stream-params-use-openclaw",
    });

    expectMockCallFields(mockedRunEmbeddedAttempt, { agentHarnessId: "openclaw" });
    const runtimePlanInput = expectMockCallFields(mockedBuildAgentRuntimePlan, {
      harnessId: "openclaw",
    });
    const preparedAuthPlan = expectRecordFields(runtimePlanInput.preparedAuthPlan, {});
    expectRecordFields(preparedAuthPlan.modelRoute, {
      requestTransportOverrides: "present",
    });
  });

  it("keeps an empty request stream param record on the implicit Codex route", async () => {
    useOpenAIPlatformAuthFixture();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      streamParams: {},
      runId: "empty-request-stream-params-keep-codex",
    });

    expectMockCallFields(mockedRunEmbeddedAttempt, { agentHarnessId: "codex" });
    const runtimePlanInput = expectMockCallFields(mockedBuildAgentRuntimePlan, {
      harnessId: "codex",
    });
    const preparedAuthPlan = expectRecordFields(runtimePlanInput.preparedAuthPlan, {});
    expectRecordFields(preparedAuthPlan.modelRoute, {
      requestTransportOverrides: "none",
    });
  });

  it("keeps Ultra logical for the attempt and maps the runtime plan to max", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "ultra-runtime-plan-boundary",
      thinkLevel: "ultra",
    });

    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "max" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: "ultra" }),
    );
  });

  it("keeps a session-pinned native model out of prepared-route materialization", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["native ok"], promptError: null }),
    );
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:work": {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-work",
        },
      },
    };
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: { provider: "openai", modelId: "gpt-native", harnessId: "codex" },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
        forwardedAuthProfileCandidateIds: ["openai:work"],
        selectedAuthMode: "api_key",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-native",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValue(authStore);
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:work"]);
    mockedBuildAgentRuntimePlan.mockReturnValue(runtimePlan);

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        sessionKey: undefined,
        provider: "openai",
        model: "gpt-native",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        config: {
          agents: { defaults: { agentRuntime: { id: "codex" } } },
        },
        runId: "native-model-skips-route-materialization",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedResolveModelAsync).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    const attempt = expectMockCallFields(pluginRunAttempt, {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      authProfileId: "openai:work",
    });
    expectRecordFields(attempt.model, {
      id: "gpt-native",
      api: "openai-responses",
      baseUrl: "",
    });
    expectMockCallFields(mockedBuildAgentRuntimePlan, {
      preparedAuthPlan: expect.objectContaining({
        modelRoute: expect.objectContaining({
          provider: "openai",
          modelId: "gpt-native",
        }),
      }),
    });
  });

  it("blocks undersized models before dispatching a provider attempt", async () => {
    mockedResolveContextWindowInfo.mockReturnValue({
      tokens: 800,
      source: "model",
    });
    mockedEvaluateContextWindowGuard.mockReturnValue({
      shouldWarn: true,
      shouldBlock: true,
      tokens: 800,
      source: "model",
      hardMinTokens: 1000,
      warnBelowTokens: 5000,
    });

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "run-small-context",
      }),
    ).rejects.toThrow(
      "Model context window too small (800 tokens; source=model). Minimum is 1000.",
    );

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });
});
