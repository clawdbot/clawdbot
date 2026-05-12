import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import type { AgentInternalEvent } from "../internal-events.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedCoerceToFailoverError,
  mockedCompactDirect,
  mockedContextEngine,
  mockedDescribeFailoverError,
  mockedEvaluateContextWindowGuard,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedGlobalHookRunner,
  mockedGetApiKeyForModel,
  mockedMarkAuthProfileSuccess,
  mockedPickFallbackThinkingLevel,
  mockedResolveAuthProfileOrder,
  mockedResolveContextWindowInfo,
  mockedResolveFailoverStatus,
  mockedRunContextEngineMaintenance,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
type RuntimePlanOverrides = Partial<Omit<AgentRuntimePlan, "auth" | "resolvedRef">> & {
  auth?: Partial<AgentRuntimePlan["auth"]>;
  resolvedRef?: Partial<AgentRuntimePlan["resolvedRef"]>;
};
function makeForwardingCase(internalEvents: AgentInternalEvent[]) {
  return {
    runId: "forward-attempt-params",
    params: {
      toolsAllow: ["exec", "read"],
      ownerOnlyToolAllowlist: ["cron"],
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
      disableMessageTool: true,
      forceMessageTool: true,
      requireExplicitMessageTarget: true,
      internalEvents,
    },
    expected: {
      toolsAllow: ["exec", "read"],
      ownerOnlyToolAllowlist: ["cron"],
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
      disableMessageTool: true,
      forceMessageTool: true,
      requireExplicitMessageTarget: true,
    },
  } satisfies {
    runId: string;
    params: Partial<RunEmbeddedPiAgentParams>;
    expected: Record<string, unknown>;
  };
}

function makeForwardedRuntimePlan(overrides: RuntimePlanOverrides = {}): AgentRuntimePlan {
  const transcriptPolicy = {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    preserveNativeAnthropicToolUseIds: false,
    repairToolUseResultPairing: true,
    preserveSignatures: false,
    sanitizeThinkingSignatures: true,
    dropThinkingBlocks: false,
    applyGoogleTurnOrdering: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: false,
  } satisfies AgentRuntimePlan["transcript"]["policy"];
  const basePlan: AgentRuntimePlan = {
    auth: {
      authProfileProviderForAuth: "anthropic",
      providerForAuth: "anthropic",
    },
    delivery: {
      isSilentPayload: vi.fn(() => false),
      resolveFollowupRoute: vi.fn(),
    },
    observability: {
      provider: "anthropic",
      resolvedRef: "anthropic/test-model",
      modelId: "test-model",
    },
    outcome: {
      classifyRunResult: vi.fn(() => undefined),
    },
    prompt: {
      provider: "anthropic",
      modelId: "test-model",
      resolveSystemPromptContribution: vi.fn(),
      transformSystemPrompt: vi.fn((context) => context.systemPrompt),
    },
    transcript: {
      policy: transcriptPolicy,
      resolvePolicy: vi.fn((params): AgentRuntimePlan["transcript"]["policy"] => ({
        ...transcriptPolicy,
        sanitizeMode: params?.modelApi === "anthropic-messages" ? "full" : "images-only",
      })),
    },
    transport: {
      extraParams: {},
      resolveExtraParams: vi.fn(() => ({})),
    },
    resolvedRef: {
      provider: "anthropic",
      modelId: "test-model",
      harnessId: "pi",
    },
    tools: {
      normalize: vi.fn((tools) => tools),
      logDiagnostics: vi.fn(),
    },
  };
  return {
    ...basePlan,
    ...overrides,
    auth: {
      ...basePlan.auth,
      ...overrides.auth,
    },
    resolvedRef: {
      ...basePlan.resolvedRef,
      ...overrides.resolvedRef,
    },
  };
}

type MockWithCalls = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

function mockCall(mock: MockWithCalls, callIndex = 0): ReadonlyArray<unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call;
}

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mockCall(mock, callIndex);
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function expectMockCallFields(
  mock: MockWithCalls,
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

function expectRuntimePlanFields(
  runtimePlan: unknown,
  expected: {
    auth?: Record<string, unknown>;
    resolvedRef?: Record<string, unknown>;
  },
): void {
  const plan = expectRecordFields(runtimePlan, {});
  if (expected.resolvedRef) {
    expectRecordFields(plan.resolvedRef, expected.resolvedRef);
  }
  if (expected.auth) {
    expectRecordFields(plan.auth, expected.auth);
  }
}

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("passes precomputed legacy before_agent_start result into the attempt", async () => {
    const legacyResult = {
      modelOverride: "legacy-model",
      prependContext: "legacy context",
    };
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_agent_start",
    );
    mockedGlobalHookRunner.runBeforeAgentStart.mockResolvedValueOnce(legacyResult);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-legacy-pass-through",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      legacyBeforeAgentStartResult: legacyResult,
    });
  });

  it("passes resolved auth profile into run attempts for context-engine afterTurn propagation", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-auth-profile-passthrough",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "test-profile",
      authProfileIdSource: "auto",
    });
  });

  it("uses the lightweight auth profile store during reply startup", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-lightweight-auth-store",
    });

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    const [agentDir, authStoreOptions] = mockCall(
      mockedEnsureAuthProfileStoreWithoutExternalProfiles,
    ) as [string | undefined, { allowKeychainPrompt?: boolean } | undefined];
    expect(typeof agentDir).toBe("string");
    expect(String(agentDir).replaceAll("\\", "/").endsWith("/.openclaw/agents/main/agent")).toBe(
      true,
    );
    expect(authStoreOptions).toEqual({ allowKeychainPrompt: false });
  });

  it("forwards optional attempt params and the runtime plan into one attempt call", async () => {
    const internalEvents: AgentInternalEvent[] = [];
    const forwardingCase = makeForwardingCase(internalEvents);
    const runtimePlan = makeForwardedRuntimePlan();
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
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
    const attemptParams = mockCallArg(mockedRunEmbeddedAttempt) as EmbeddedRunAttemptParams;
    expect(attemptParams?.runtimePlan).toBe(runtimePlan);
    expect(attemptParams?.internalEvents).toBe(internalEvents);
  });

  it("forwards explicit OpenAI Codex auth profiles to codex plugin harnesses", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "codex",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:work",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    const codexAuthStore = {
      version: 1,
      profiles: {
        "openai-codex:work": {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai-codex:other": {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "other-access",
          refresh: "other-refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:work": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        authProfileId: "openai-codex:work",
        authProfileIdSource: "user",
        runId: "plugin-harness-forwards-openai-codex-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "codex",
      authProfileId: "openai-codex:work",
      authProfileIdSource: "user",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "codex",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
    };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
    const authProfileStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(authProfileStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai-codex:work"]);
    expectRecordFields(authProfiles["openai-codex:work"], {
      provider: "openai-codex",
    });
  });

  it("forwards OpenAI Codex auth profiles when openai/* is forced through codex", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:work",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: false }),
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        authProfileId: "openai-codex:work",
        authProfileIdSource: "user",
        runId: "forced-codex-harness-forwards-openai-codex-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai-codex:work",
      authProfileIdSource: "user",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as { runtimePlan?: unknown };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledTimes(1);
    const [[successParams]] = mockedMarkAuthProfileSuccess.mock.calls as unknown as Array<
      [{ provider?: string; profileId?: string }]
    >;
    expect(successParams.provider).toBe("openai-codex");
    expect(successParams.profileId).toBe("openai-codex:work");
  });

  it("keeps auto-selected OpenAI Codex auth profiles for forced codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:default",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: false }),
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        authProfileId: "openai-codex:default",
        authProfileIdSource: "auto",
        runId: "forced-codex-harness-keeps-auto-openai-codex-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai-codex:default",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as { runtimePlan?: unknown };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
  });

  it("auto-selects OpenAI Codex auth profiles for forced codex harness channel runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:default",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: false }),
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai-codex:default"]);

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        runId: "forced-codex-harness-auto-selects-openai-codex-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai-codex",
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai-codex:default",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as { runtimePlan?: unknown };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
  });

  it("auto-selects friendly OpenAI-named Codex auth profiles for forced codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai:personal",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: false }),
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:personal"]);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openai:personal": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        runId: "forced-codex-harness-auto-selects-friendly-openai-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai-codex",
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:personal",
      authProfileIdSource: "auto",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai:personal",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
    };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
    const authProfileStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(authProfileStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:personal"]);
    expectRecordFields(authProfiles["openai:personal"], {
      provider: "openai-codex",
    });
  });

  it("rotates Codex harness auth profiles after a prompt-level subscription limit", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const subscriptionLimit = new Error(
      "You've reached your Codex subscription usage limit. Next reset in 20 hours.",
    );
    const normalizedLimit = Object.assign(new Error(subscriptionLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    let attemptCount = 0;
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      return attemptCount === 1
        ? makeAttemptResult({ promptError: subscriptionLimit })
        : makeAttemptResult({ assistantTexts: ["backup ok"], promptError: null });
    });
    const firstRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai-codex:sub",
        forwardedAuthProfileCandidateIds: ["openai-codex:sub", "openai:backup"],
      },
    });
    const secondRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai-codex",
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai-codex:sub", "openai:backup"],
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: false }),
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(firstRuntimePlan)
      .mockReturnValueOnce(secondRuntimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai-codex:sub", "openai:backup"]);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:sub": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
    });
    mockedCoerceToFailoverError.mockReturnValueOnce(normalizedLimit);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalizedLimit ? "rate_limit" : undefined,
      status: err === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
        },
        runId: "forced-codex-harness-rotates-subscription-limit-auth",
        authProfileId: "openai-codex:sub",
        authProfileIdSource: "auto",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    const firstAttempt = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai-codex:sub",
      authProfileIdSource: "auto",
    });
    const secondAttempt = expectMockCallFields(
      pluginRunAttempt,
      {
        provider: "openai",
        authProfileId: "openai:backup",
        authProfileIdSource: "auto",
      },
      1,
    );
    expectRuntimePlanFields(firstAttempt.runtimePlan, {
      auth: {
        forwardedAuthProfileId: "openai-codex:sub",
        forwardedAuthProfileCandidateIds: ["openai-codex:sub", "openai:backup"],
      },
    });
    expectRuntimePlanFields(secondAttempt.runtimePlan, {
      auth: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai-codex:sub", "openai:backup"],
      },
    });
    const firstAuthProfileStore = expectRecordFields(firstAttempt.authProfileStore, {});
    const firstAuthProfiles = expectRecordFields(firstAuthProfileStore.profiles, {});
    expect(Object.keys(firstAuthProfiles)).toEqual(["openai-codex:sub", "openai:backup"]);
    expect(secondAttempt.authProfileStore).toBe(firstAttempt.authProfileStore);
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
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-small-context",
      }),
    ).rejects.toThrow(
      "Model context window too small (800 tokens; source=model). Minimum is 1000.",
    );

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactParams = expectMockCallFields(mockedCompactDirect, {
      sessionId: "test-session",
      sessionFile: "/tmp/session.json",
    });
    expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
      authProfileId: "test-profile",
    });
  });

  it("threads prompt-cache runtime context into overflow compaction", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          promptCache: {
            retention: "short",
            lastCallUsage: {
              input: 150000,
              cacheRead: 32000,
              total: 182000,
            },
            observation: {
              broke: false,
              cacheRead: 32000,
            },
            lastCacheTouchAt: 1_700_000_000_000,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        tokensBefore: 150000,
        tokensAfter: 80000,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    const compactParams = expectMockCallFields(mockedCompactDirect, {});
    const runtimeContext = expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
    });
    const promptCache = expectRecordFields(runtimeContext.promptCache, {
      retention: "short",
      lastCacheTouchAt: 1_700_000_000_000,
    });
    expectRecordFields(promptCache.lastCallUsage, {
      input: 150000,
      cacheRead: 32000,
    });
    expectRecordFields(promptCache.observation, {
      broke: false,
      cacheRead: 32000,
    });
    expect(result.meta.agentMeta?.compactionTokensAfter).toBe(80_000);
  });

  it("passes observed overflow token counts into compaction when providers report them", async () => {
    const overflowError = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 277403 tokens > 200000 maximum"}}',
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-8",
        tokensBefore: 277403,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expectMockCallFields(mockedCompactDirect, {
      currentTokenCount: 277403,
    });
    expect(result.meta.error).toBeUndefined();
  });

  it("does not reset compaction attempt budget after successful tool-result truncation", async () => {
    const overflowError = queueOverflowAttemptWithOversizedToolOutput(
      mockedRunEmbeddedAttempt,
      makeOverflowError(),
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "nothing to compact",
      })
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 3",
          firstKeptEntryId: "entry-7",
          tokensBefore: 140000,
        }),
      );

    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
  });

  it("fires compaction hooks during overflow recovery for ownsCompaction engines", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "engine-owned compaction",
        tokensAfter: 50,
      },
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expectRecordFields(mockCallArg(mockedGlobalHookRunner.runBeforeCompaction), {
      messageCount: -1,
      sessionFile: "/tmp/session.json",
    });
    expectRecordFields(mockCallArg(mockedGlobalHookRunner.runBeforeCompaction, 0, 1), {
      sessionKey: "test-key",
    });
    expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction), {
      messageCount: -1,
      compactedCount: -1,
      tokenCount: 50,
      sessionFile: "/tmp/session.json",
    });
    expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction, 0, 1), {
      sessionKey: "test-key",
    });
  });

  it("runs maintenance after successful overflow-recovery compaction", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "engine-owned compaction",
        tokensAfter: 50,
      },
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    const maintenanceParams = expectMockCallFields(mockedRunContextEngineMaintenance, {
      contextEngine: mockedContextEngine,
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      reason: "compaction",
    });
    expectRecordFields(maintenanceParams.runtimeContext, {
      trigger: "overflow",
      authProfileId: "test-profile",
    });
  });

  it("retries overflow recovery against the rotated compacted transcript", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          sessionIdUsed: "rotated-session",
          sessionFileUsed: "/tmp/rotated-session.json",
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "rotated overflow compaction",
        tokensAfter: 50,
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.json",
      }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expectMockCallFields(
      mockedRunEmbeddedAttempt,
      {
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.json",
      },
      1,
    );
    expectMockCallFields(mockedRunContextEngineMaintenance, {
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.json",
    });
  });

  it("guards thrown engine-owned overflow compaction attempts", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine boom"));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("returns retry_limit when repeated retries never converge", async () => {
    mockedRunEmbeddedAttempt.mockClear();
    mockedCompactDirect.mockClear();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedPickFallbackThinkingLevel.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("unsupported reasoning mode"),
      }),
    );
    mockedPickFallbackThinkingLevel.mockReturnValue("low");

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("preserves replay invalidation when retries exhaust after side effects", async () => {
    mockedRunEmbeddedAttempt.mockClear();
    mockedCompactDirect.mockClear();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedPickFallbackThinkingLevel.mockReturnValue("low");
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("unsupported reasoning mode"),
        replayMetadata: {
          hadPotentialSideEffects: true,
          replaySafe: false,
        },
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("normalizes abort-wrapped prompt errors before handing off to model fallback", async () => {
    const promptError = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });
    const normalized = Object.assign(new Error("Resource has been exhausted (e.g. check quota)."), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError }));
    mockedCoerceToFailoverError.mockReturnValue(normalized);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalized ? "rate_limit" : undefined,
      status: err === normalized ? 429 : undefined,
      code: undefined,
    }));
    mockedResolveFailoverStatus.mockReturnValue(429);

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        config: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.2"],
              },
            },
          },
        },
      }),
    ).rejects.toBe(normalized);

    expect(mockCallArg(mockedCoerceToFailoverError)).toBe(promptError);
    expectRecordFields(mockCallArg(mockedCoerceToFailoverError, 0, 1), {
      provider: "anthropic",
      model: "test-model",
      profileId: "test-profile",
    });
    expect(mockedResolveFailoverStatus).toHaveBeenCalledWith("rate_limit");
  });
});
