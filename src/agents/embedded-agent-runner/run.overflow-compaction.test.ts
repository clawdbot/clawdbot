// Coverage for overflow compaction routing, runtime context, and failover.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  rollbackAgentHarnessSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunContext,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  resetAgentRunContextForTest,
  rotateAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import type { AgentHarness } from "../harness/types.js";
import type { AgentInternalEvent } from "../internal-events.js";
import type {
  AgentRuntimeAuthModelRoute,
  AgentRuntimeAuthPlan,
  AgentRuntimePlan,
} from "../runtime-plan/types.js";
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
  mockedExtractObservedOverflowTokenCount,
  mockedGlobalHookRunner,
  mockedGetApiKeyForModel,
  mockedIsProfileInCooldown,
  mockedIsLikelyContextOverflowError,
  mockedMarkAuthProfileSuccess,
  mockedPickFallbackThinkingLevel,
  mockedResolveAuthProfileOrder,
  mockedResolveContextWindowInfo,
  mockedResolveFailoverStatus,
  mockedResolveModelAsync,
  mockedResolveProviderEntryApiKeyProfileReference,
  mockedRunContextEngineMaintenance,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  mockedWaitForDeferredTurnMaintenanceForSession,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;
type RuntimePlanAuthOverrides = Partial<Omit<AgentRuntimeAuthPlan, "modelRoute">> & {
  modelRoute?: AgentRuntimeAuthModelRoute;
};
type RuntimePlanOverrides = Partial<Omit<AgentRuntimePlan, "auth" | "resolvedRef">> & {
  auth?: RuntimePlanAuthOverrides;
  resolvedRef?: Partial<AgentRuntimePlan["resolvedRef"]>;
};

function mergeRuntimePlanAuth(
  base: AgentRuntimeAuthPlan,
  overrides: RuntimePlanAuthOverrides | undefined,
): AgentRuntimeAuthPlan {
  const { modelRoute: _baseModelRoute, ...baseFields } = base;
  const { modelRoute, ...overrideFields } = overrides ?? {};
  const common = { ...baseFields, ...overrideFields };
  return modelRoute ? { ...common, modelRoute } : common;
}
function makeForwardingCase(internalEvents: AgentInternalEvent[]) {
  // Forwarding cases prove request-scoped flags survive the overflow-compaction
  // route into the eventual embedded attempt.
  const onAgentToolResult = vi.fn();
  return {
    runId: "forward-attempt-params",
    params: {
      toolsAllow: ["exec", "read"],
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
      disableMessageTool: true,
      forceMessageTool: true,
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      chatType: "channel",
      senderIsOwner: true,
      internalEvents,
      onAgentToolResult,
    },
    expected: {
      toolsAllow: ["exec", "read"],
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
      disableMessageTool: true,
      forceMessageTool: true,
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      chatType: "channel",
      senderIsOwner: true,
      onAgentToolResult,
    },
  } satisfies {
    runId: string;
    params: Partial<RunEmbeddedAgentParams>;
    expected: Record<string, unknown>;
  };
}

function codexHarnessSupportsKnownProviders(
  ctx: Parameters<AgentHarness["supports"]>[0],
): ReturnType<AgentHarness["supports"]> {
  return ctx.provider === "codex" || ctx.provider === "openai" || ctx.provider === "openai"
    ? { supported: true, priority: 100 }
    : { supported: false };
}

function makeForwardedRuntimePlan(overrides: RuntimePlanOverrides = {}): AgentRuntimePlan {
  // Runtime plan fixture includes every runner seam that can alter auth,
  // delivery, transcript policy, transport, and tool handling.
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
      harnessId: "openclaw",
    },
    tools: {
      normalize: vi.fn((tools) => tools),
      logDiagnostics: vi.fn(),
    },
  };
  return {
    ...basePlan,
    ...overrides,
    auth: mergeRuntimePlanAuth(basePlan.auth, overrides.auth),
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

function queueOpenAIResolvedModel(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  baseUrl: string;
  authStorage: { setRuntimeApiKey: ReturnType<typeof vi.fn> };
}): void {
  mockedResolveModelAsync.mockResolvedValueOnce({
    model: {
      id: "gpt-5.5",
      provider: "openai",
      contextWindow: 200_000,
      api: params.api,
      baseUrl: params.baseUrl,
    },
    error: null,
    authStorage: params.authStorage,
    modelRegistry: {},
  });
}

function expectRuntimePlanFields(
  runtimePlan: unknown,
  expected: {
    auth?: Record<string, unknown>;
    resolvedRef?: Record<string, unknown>;
  },
): void {
  // Tests care about the resolved refs and auth handoff, not the entire plan
  // object produced by runtime selection.
  const plan = expectRecordFields(runtimePlan, {});
  if (expected.resolvedRef) {
    expectRecordFields(plan.resolvedRef, expected.resolvedRef);
  }
  if (expected.auth) {
    expectRecordFields(plan.auth, expected.auth);
  }
}

async function waitForRunEvent(events: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (events.includes(expected)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected run event ${expected}; saw ${events.join(", ")}`);
}

describe("runEmbeddedAgent overflow compaction trigger routing", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("passes precomputed before_agent_start result into the attempt", async () => {
    const beforeAgentStartResult = {
      modelOverride: "agent-start-model",
      prependContext: "agent start context",
    };
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_agent_start",
    );
    mockedGlobalHookRunner.runBeforeAgentStart.mockResolvedValueOnce(beforeAgentStartResult);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-before-agent-start-pass-through",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      beforeAgentStartResult,
    });
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

  it("waits for same-session deferred maintenance before the attempt reads session state", async () => {
    const events: string[] = [];
    mockedWaitForDeferredTurnMaintenanceForSession.mockImplementationOnce(async (sessionKey) => {
      events.push(`wait:${sessionKey}`);
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      events.push("attempt");
      return makeAttemptResult({ promptError: null });
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-wait-deferred-maintenance",
      sessionKey: "agent:main:session-wait-deferred-maintenance",
    });

    expect(events).toEqual(["wait:agent:main:session-wait-deferred-maintenance", "attempt"]);
  });

  it("does not hold the global run lane while waiting for another session's deferred maintenance", async () => {
    const events: string[] = [];
    let releaseSessionA: (() => void) | undefined;
    mockedWaitForDeferredTurnMaintenanceForSession.mockImplementation(async (sessionKey) => {
      events.push(`wait:${sessionKey}`);
      if (sessionKey !== "agent:main:session-a") {
        return;
      }
      await new Promise<void>((resolve) => {
        releaseSessionA = resolve;
      });
    });
    mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
      events.push(`attempt:${(params as { sessionKey?: string }).sessionKey}`);
      return makeAttemptResult({ promptError: null });
    });

    const sessionARun = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-deferred-maintenance-session-a",
      sessionKey: "agent:main:session-a",
    });
    await waitForRunEvent(events, "wait:agent:main:session-a");

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-deferred-maintenance-session-b",
      sessionKey: "agent:main:session-b",
    });

    expect(events).toEqual([
      "wait:agent:main:session-a",
      "wait:agent:main:session-b",
      "attempt:agent:main:session-b",
    ]);
    if (!releaseSessionA) {
      throw new Error("Expected session A maintenance release callback to be initialized");
    }
    releaseSessionA();
    await sessionARun;
    expect(events).toEqual([
      "wait:agent:main:session-a",
      "wait:agent:main:session-b",
      "attempt:agent:main:session-b",
      "attempt:agent:main:session-a",
    ]);
  });

  it("uses the lightweight auth profile store during reply startup", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
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

  it("loads the external Claude CLI auth overlay for PI runs routed by Claude CLI OAuth", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-claude-cli-oauth-auth-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("loads the Claude CLI auth overlay when explicit PI runtime uses Claude CLI OAuth", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/test-model": { agentRuntime: { id: "pi" } },
            },
          },
        },
      },
      runId: "pi-explicit-runtime-claude-cli-oauth-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
  });

  it("does not let an auto-selected stale Anthropic profile suppress Claude CLI auth overlay", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli", "anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      authProfileId: "anthropic:api",
      authProfileIdSource: "auto",
      runId: "pi-auto-profile-does-not-suppress-claude-cli-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("does not let an auto-selected stale profile suppress runtime-selected Claude CLI auth overlay", async () => {
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli", "anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            models: {
              "anthropic/test-model": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      authProfileId: "anthropic:api",
      authProfileIdSource: "auto",
      runId: "pi-auto-profile-does-not-suppress-runtime-claude-cli-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      authProfileId: "anthropic:claude-cli",
      authProfileIdSource: "auto",
    });
  });

  it("loads the Claude CLI auth overlay for ordered fallback profiles after direct Anthropic auth", async () => {
    const authStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValueOnce(authStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:api", "anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:api", "anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-direct-anthropic-with-claude-cli-fallback-overlay",
    });

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:api",
    });
  });

  it("loads the Claude CLI auth overlay from persisted auth-store order", async () => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {},
      order: { anthropic: ["anthropic:claude-cli"] },
    };
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(staticAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValueOnce(claudeAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:claude-cli"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      runId: "pi-store-order-claude-cli-oauth-overlay",
    });

    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:claude-cli",
    });
  });

  it("keeps static Anthropic auth on the no-external auth profile store", async () => {
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key",
          provider: "anthropic",
          key: "static-key",
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["anthropic:api"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "test-model",
      config: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      runId: "pi-static-anthropic-auth-no-external-overlay",
    });

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStoreWithoutExternalProfiles, 0, 1), {
      allowKeychainPrompt: false,
    });
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "anthropic:api",
    });
  });

  it("keeps non-Codex plugin harnesses on the lightweight auth profile store", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "anthropic",
        modelId: "test-model",
        harnessId: "anthropic-plugin",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "anthropic-plugin",
      label: "Anthropic plugin",
      supports: (ctx) =>
        ctx.provider === "anthropic" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "anthropic",
        model: "test-model",
        agentHarnessId: "anthropic-plugin",
        runId: "non-codex-plugin-harness-lightweight-auth-store",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedEnsureAuthProfileStore).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStoreWithoutExternalProfiles, 0, 1), {
      allowKeychainPrompt: false,
    });
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "anthropic",
      authProfileId: undefined,
    });
    expect(pluginParams.runtimePlan).toBe(runtimePlan);
    const authProfileStore = expectRecordFields(pluginParams.authProfileStore, {});
    expect(authProfileStore.profiles).toEqual({});
    expect(
      (pluginParams as { toolAuthProfileStore?: unknown }).toolAuthProfileStore,
    ).toBeUndefined();
  });

  it("forwards unscoped tool auth profiles to Copilot plugin harnesses", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "github-copilot",
        modelId: "gpt-4o",
        harnessId: "copilot",
      },
      auth: {
        harnessAuthProvider: "github-copilot",
        forwardedAuthProfileId: "github-copilot:work",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "copilot",
      label: "Copilot",
      supports: (ctx) =>
        ctx.provider === "github-copilot"
          ? { supported: true, priority: 100 }
          : { supported: false },
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    const copilotAuthStore = {
      version: 1 as const,
      profiles: {
        "github-copilot:work": {
          type: "oauth" as const,
          provider: "github-copilot",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:work": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(copilotAuthStore);

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "github-copilot",
        model: "gpt-4o",
        config: {
          models: {
            providers: {
              "github-copilot": {
                agentRuntime: { id: "copilot" },
                baseUrl: "https://api.githubcopilot.com",
                models: [],
              },
            },
          },
        },
        authProfileId: "github-copilot:work",
        authProfileIdSource: "user",
        runId: "copilot-plugin-harness-forwards-tool-auth-store",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["github-copilot:work"]);
    expect(harnessParams.toolAuthProfileStore).toBe(copilotAuthStore);
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
    const attemptParams = mockCallArg(mockedRunEmbeddedAttempt) as EmbeddedRunAttemptParams;
    expect(attemptParams?.runtimePlan).toBe(runtimePlan);
    expect(attemptParams?.internalEvents).toBe(internalEvents);
    expect(attemptParams?.agentHarnessId).toBe("openclaw");
    expect(attemptParams?.agentHarnessRuntimeOverride).toBe("openclaw");
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

  it("keeps an explicitly captured lifecycle generation across the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-before-restart",
      lifecycleGeneration,
    });

    expectMockCallFields(mockedRunEmbeddedAttempt, {
      lifecycleGeneration,
    });
  });

  it("rebinds preserved queued work to the current lifecycle generation", async () => {
    resetAgentRunContextForTest();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    let enqueueCount = 0;
    let runQueuedTask: (() => void) | undefined;
    const onExecutionStarted = vi.fn();
    const runPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "queued-across-restart",
      trigger: "user",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      onExecutionStarted,
      enqueue: async (task) => {
        enqueueCount += 1;
        if (enqueueCount === 1) {
          return await task();
        }
        return await new Promise((resolve, reject) => {
          runQueuedTask = () => {
            void Promise.resolve().then(task).then(resolve, reject);
          };
        });
      },
    });
    await vi.waitFor(() => expect(runQueuedTask).toBeTypeOf("function"));

    const currentLifecycleGeneration = rotateAgentEventLifecycleGeneration();
    runQueuedTask?.();
    await runPromise;

    expectMockCallFields(mockedRunEmbeddedAttempt, {
      lifecycleGeneration: currentLifecycleGeneration,
    });
    expect(getAgentRunContext("queued-across-restart")).toEqual(
      expect.objectContaining({
        lifecycleGeneration: currentLifecycleGeneration,
      }),
    );
    expect(onExecutionStarted).toHaveBeenCalledWith({
      lifecycleGeneration: currentLifecycleGeneration,
    });
    resetAgentRunContextForTest();
  });

  it("revalidates reserved harness ownership after the global queue wait", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-admission-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "native-session";
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const initialEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId,
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, initialEntry);

    let enqueueCount = 0;
    let runQueuedTask: (() => void) | undefined;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_model_resolve",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    try {
      const runPromise = runEmbeddedAgent({
        ...overflowBaseRunParams,
        agentHarnessId: "codex",
        config: { session: { store: storePath } } as RunEmbeddedAgentParams["config"],
        modelSelectionLocked: true,
        runId: "queued-harness-admission",
        sessionId,
        sessionKey,
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
        enqueue: async (task) => {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            return await task();
          }
          return await new Promise((resolve, reject) => {
            runQueuedTask = () => {
              void Promise.resolve().then(task).then(resolve, reject);
            };
          });
        },
      });
      await vi.waitFor(() => expect(runQueuedTask).toBeTypeOf("function"));

      await rollbackAgentHarnessSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        expectedEntry: initialEntry,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      runQueuedTask?.();

      await expect(runPromise).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
      expect(mockedGlobalHookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects background work queued across lifecycle rotation", async () => {
    resetAgentRunContextForTest();
    let enqueueCount = 0;
    let runQueuedTask: (() => void) | undefined;
    const runPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "background-queued-across-restart",
      trigger: "cron",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      enqueue: async (task) => {
        enqueueCount += 1;
        if (enqueueCount === 1) {
          return await task();
        }
        return await new Promise((resolve, reject) => {
          runQueuedTask = () => {
            void Promise.resolve().then(task).then(resolve, reject);
          };
        });
      },
    });
    await vi.waitFor(() => expect(runQueuedTask).toBeTypeOf("function"));

    rotateAgentEventLifecycleGeneration();
    runQueuedTask?.();

    await expect(runPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(getAgentRunContext("background-queued-across-restart")).toBeUndefined();
  });

  it("does not claim a rebound generation after queued work was aborted", async () => {
    resetAgentRunContextForTest();
    let enqueueCount = 0;
    let runQueuedTask: (() => void) | undefined;
    const abortController = new AbortController();
    const onExecutionStarted = vi.fn();
    const runPromise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "aborted-queued-across-restart",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      abortSignal: abortController.signal,
      onExecutionStarted,
      enqueue: async (task) => {
        enqueueCount += 1;
        if (enqueueCount === 1) {
          return await task();
        }
        return await new Promise((resolve, reject) => {
          runQueuedTask = () => {
            void Promise.resolve().then(task).then(resolve, reject);
          };
        });
      },
    });
    await vi.waitFor(() => expect(runQueuedTask).toBeTypeOf("function"));

    const runResult = runPromise.catch((error: unknown) => error);
    rotateAgentEventLifecycleGeneration();
    abortController.abort();
    runQueuedTask?.();

    await expect(runResult).resolves.toMatchObject({ name: "AbortError" });
    expect(onExecutionStarted).not.toHaveBeenCalled();
    expect(getAgentRunContext("aborted-queued-across-restart")).toBeUndefined();
  });

  it("rejects stale descendants admitted after lifecycle rotation", async () => {
    resetAgentRunContextForTest();
    const preRestartGeneration = getAgentEventLifecycleGeneration();
    rotateAgentEventLifecycleGeneration();

    const runPromise = withAgentRunLifecycleGeneration(preRestartGeneration, () =>
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "stale-descendant",
        enqueue: async (task) => await task(),
      }),
    );

    await expect(runPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(getAgentRunContext("stale-descendant")).toBeUndefined();
  });

  it("marks user-triggered session queue work as foreground", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const observedPriorities: unknown[] = [];

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      runId: "run-user-session-priority",
      enqueue: async (task, opts) => {
        observedPriorities.push(opts?.priority);
        return await task();
      },
    });

    expect(observedPriorities[0]).toBe("foreground");
  });

  it("marks cron-triggered session queue work as background", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const observedPriorities: unknown[] = [];

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      runId: "run-cron-session-priority",
      enqueue: async (task, opts) => {
        observedPriorities.push(opts?.priority);
        return await task();
      },
    });

    expect(observedPriorities[0]).toBe("background");
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["anthropic:work", "openai:other", "openai:work", "xai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:other": {
          type: "oauth" as const,
          provider: "openai",
          access: "other-access",
          refresh: "other-refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:work": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant",
        },
        "xai:work": {
          type: "oauth" as const,
          provider: "xai",
          access: "xai-access",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);

    try {
      await runEmbeddedAgent({
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
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "plugin-harness-forwards-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "codex",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "codex",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimeExternalProfileIds).toBeUndefined();
    expect(forwardedAuthStore.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
    expectRecordFields(authProfiles["openai:work"], {
      provider: "openai",
    });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["openai:work", "xai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        "xai:work": {
          type: "api_key" as const,
          provider: "xai",
          key: "xai-key",
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.4",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedAgent({
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
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "forced-codex-harness-forwards-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      resolvedApiKey: undefined,
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      runtimePlan?: unknown;
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    expect(harnessParams?.runtimePlan).toBe(runtimePlan);
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:work"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toEqual(["openai:work"]);
    expectRecordFields(authProfiles["openai:work"], { provider: "openai" });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledTimes(1);
    const [[successParams]] = mockedMarkAuthProfileSuccess.mock.calls as unknown as Array<
      [{ provider?: string; profileId?: string }]
    >;
    expect(successParams.provider).toBe("openai");
    expect(successParams.profileId).toBe("openai:work");
  });

  it("uses a harness-owned SecretRef fingerprint for successful auth binding", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        assistantTexts: ["ok"],
        authBindingFingerprint: "resolved-secretref-fingerprint",
      }),
    );
    const codexAuthStore = {
      version: 1 as const,
      profiles: {
        "openai:work": {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    };
    const onSuccessfulAuthBinding = vi.fn();
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.4",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: { defaults: { agentRuntime: { id: "codex" } } },
          auth: {
            profiles: {
              "openai:work": { provider: "openai", mode: "api_key" },
            },
          },
        },
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "harness-secretref-auth-binding",
        onSuccessfulAuthBinding,
      } as RunEmbeddedAgentParams & {
        onSuccessfulAuthBinding: typeof onSuccessfulAuthBinding;
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:work",
        agentHarnessId: "codex",
        authFingerprint: "resolved-secretref-fingerprint",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
      }),
    );
  });

  it("bootstraps OAuth credentials for forced openai/* Codex response runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const codexAuthStorage = {
      setRuntimeApiKey: vi.fn(),
      getApiKey: vi.fn(async () => "stored-test-key"),
    };
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["openai:work"],
      profiles: {
        "openai:work": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce(codexAuthStore);
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: codexAuthStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockResolvedValueOnce({
      apiKey: "test-key",
      profileId: "openai:work",
      source: "test",
      mode: "oauth",
    });

    try {
      await runEmbeddedAgent({
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
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "forced-openai-chatgpt-responses-bootstrap-oauth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["openai"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "openai:work",
    });
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      resolvedApiKey: "test-key",
    });
  });

  it("delegates auth bootstrap to a forced Codex harness that owns it", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
              model: { fallbacks: ["anthropic/claude-opus-4-6"] },
            },
          },
        },
        runId: "forced-codex-harness-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: undefined,
      resolvedApiKey: undefined,
    });
    const attempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    expect(attempt.runtimePlan?.auth.modelRoute).toBeUndefined();
  });

  it.each([
    {
      label: "literal provider key",
      apiKey: "configured-platform-key" as unknown,
      expectedApiKey: "configured-platform-key",
      env: undefined,
    },
    {
      label: "provider SecretRef",
      apiKey: { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" } as unknown,
      expectedApiKey: "secret-ref-platform-key",
      env: { name: "OPENAI_PLATFORM_KEY", value: "secret-ref-platform-key" },
    },
  ])("bootstraps the prepared Platform route's $label for a Codex harness", async (testCase) => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const actualModelAuth =
      await vi.importActual<typeof import("../model-auth.js")>("../model-auth.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const authStorage = { setRuntimeApiKey: vi.fn() };
    const modelRoute = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
    };
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        selectedAuthMode: "api-key",
        modelRoute,
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    if (testCase.env) {
      vi.stubEnv(testCase.env.name, testCase.env.value);
    } else {
      mockedResolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "literal" });
    }
    mockedEnsureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200_000,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      error: null,
      authStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockImplementationOnce(async (params) =>
      actualModelAuth.getApiKeyForModel(params as never),
    );

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          agents: {
            defaults: {
              agentRuntime: { id: "codex" },
            },
          },
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: testCase.apiKey,
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        } as RunEmbeddedAgentParams["config"],
        runId: `forced-codex-platform-${testCase.label.replaceAll(" ", "-")}`,
      });
    } finally {
      vi.unstubAllEnvs();
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: undefined,
      resolvedApiKey: testCase.expectedApiKey,
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      auth: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
        modelRoute,
      },
    });
  });

  it("keeps missing OpenClaw auth fatal for a Codex harness without owned bootstrap", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    try {
      await expect(
        runEmbeddedAgent({
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
          runId: "codex-harness-missing-managed-auth",
        }),
      ).rejects.toThrow("No route-compatible authentication source is configured for openai.");
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
  });

  it("loads the external Codex auth overlay before auto-selecting forced Codex runtime profiles", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({ assistantTexts: ["ok"] }),
    );
    const codexAuthStorage = {
      setRuntimeApiKey: vi.fn(),
      getApiKey: vi.fn(async () => "stored-test-key"),
    };
    const runtimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      runtimePersistedProfileIds: ["xai:work"],
      runtimeExternalProfileIds: ["openai:default"],
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        "xai:work": {
          type: "oauth" as const,
          provider: "xai",
          access: "xai-token",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValueOnce({
      version: 1,
      profiles: {},
    });
    mockedResolveAuthProfileOrder.mockImplementation((params?: unknown) => {
      const { provider, store } = (params ?? {}) as {
        provider?: string;
        store?: { profiles?: Record<string, unknown> };
      };
      return provider === "openai" && store?.profiles?.["openai:default"] ? ["openai:default"] : [];
    });
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: codexAuthStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId }: { profileId?: string } = {}) => {
        if (!profileId) {
          throw new Error('No API key found for provider "openai"');
        }
        return {
          apiKey: "test-key",
          profileId,
          source: "test",
          mode: "oauth",
        };
      },
    );

    try {
      await runEmbeddedAgent({
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
        runId: "forced-openai-chatgpt-responses-auto-selects-external-overlay",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedEnsureAuthProfileStore).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(mockedEnsureAuthProfileStore, 0, 1), {
      externalCliProviderIds: ["openai"],
      allowKeychainPrompt: false,
    });
    expect(mockedEnsureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai",
      store: codexAuthStore,
    });
    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    expectMockCallFields(mockedGetApiKeyForModel, {
      profileId: "openai:default",
    });
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
      authProfileIdSource: "auto",
      resolvedApiKey: "test-key",
    });
    expectRuntimePlanFields(pluginParams.runtimePlan, {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    const harnessParams = mockCallArg(pluginRunAttempt) as {
      authProfileStore?: { profiles?: Record<string, unknown> };
      toolAuthProfileStore?: unknown;
    };
    const forwardedAuthStore = expectRecordFields(harnessParams.authProfileStore, {});
    const authProfiles = expectRecordFields(forwardedAuthStore.profiles, {});
    expect(Object.keys(authProfiles)).toEqual(["openai:default"]);
    expect(forwardedAuthStore.runtimePersistedProfileIds).toBeUndefined();
    expect(forwardedAuthStore.runtimeExternalProfileIds).toEqual(["openai:default"]);
    expect(forwardedAuthStore.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
    expectRecordFields(authProfiles["openai:default"], {
      provider: "openai",
    });
    expect(harnessParams.toolAuthProfileStore).toBe(codexAuthStore);
  });

  it("refreshes OAuth credentials for a compatible plugin without owned bootstrap", async () => {
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
    const codexAuthStorage = {
      setRuntimeApiKey: vi.fn(),
      getApiKey: vi.fn(async () => "stored-test-key"),
    };
    const firstRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub", "openai:backup"],
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
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    const codexAuthStore = {
      version: 1 as const,
      profiles: {
        "openai:sub": {
          type: "oauth" as const,
          provider: "openai",
          access: "sub-access-token",
          refresh: "sub-refresh-token",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "oauth" as const,
          provider: "openai",
          access: "backup-access-token",
          refresh: "backup-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex-compatible test harness",
      supports: codexHarnessSupportsKnownProviders,
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValue(codexAuthStore);
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub", "openai:backup"]);
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200000,
        api: "openai-chatgpt-responses",
      },
      error: null,
      authStorage: codexAuthStorage,
      modelRegistry: {},
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(firstRuntimePlan)
      .mockReturnValueOnce(secondRuntimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId }: { profileId?: string } = {}) => ({
        apiKey: profileId === "openai:backup" ? "backup-token" : "sub-token",
        profileId: profileId ?? "openai:sub",
        source: "test",
        mode: "oauth",
      }),
    );
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === subscriptionLimit ? normalizedLimit : null,
    );
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalizedLimit ? "rate_limit" : undefined,
      status: err === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
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
        runId: "generic-openai-harness-rotates-oauth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(2);
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(1, "openai", "sub-token");
    expect(codexAuthStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(2, "openai", "backup-token");
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:sub",
      resolvedApiKey: "sub-token",
    });
    expectMockCallFields(
      pluginRunAttempt,
      {
        provider: "openai",
        authProfileId: "openai:backup",
        resolvedApiKey: "backup-token",
      },
      1,
    );
    const firstAttempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    const secondAttempt = mockCallArg(pluginRunAttempt, 1) as EmbeddedRunAttemptParams;
    expect(Object.keys(firstAttempt.authProfileStore.profiles)).toEqual([
      "openai:sub",
      "openai:backup",
    ]);
    expect(Object.keys(secondAttempt.authProfileStore.profiles)).toEqual(["openai:backup"]);
    expect(secondAttempt.authProfileStore).not.toBe(firstAttempt.authProfileStore);
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth" as const,
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:default"]);
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));

    try {
      await runEmbeddedAgent({
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
        authProfileId: "openai:default",
        authProfileIdSource: "auto",
        runId: "forced-codex-harness-keeps-auto-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedEnsureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:default"]);

    try {
      await runEmbeddedAgent({
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
        runId: "forced-codex-harness-auto-selects-openai-chatgpt-auth",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
    expectMockCallFields(mockedResolveAuthProfileOrder, {
      provider: "openai",
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(1);
    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    const pluginParams = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:default",
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:default",
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:personal",
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    mockedBuildAgentRuntimePlan.mockReturnValueOnce(runtimePlan);
    mockedGetApiKeyForModel.mockRejectedValueOnce(new Error("generic auth should be skipped"));
    mockedResolveAuthProfileOrder.mockReturnValueOnce(["openai:personal"]);
    const friendlyAuthProfileStore = {
      version: 1 as const,
      profiles: {
        "openai:personal": {
          type: "oauth" as const,
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    mockedEnsureAuthProfileStore.mockReturnValue(friendlyAuthProfileStore);
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(friendlyAuthProfileStore);

    try {
      await runEmbeddedAgent({
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
      provider: "openai",
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
        harnessAuthProvider: "openai",
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
      provider: "openai",
    });
  });

  it("rotates Codex from subscription to a non-cooled Platform profile", async () => {
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
    let cooldownRaceActive = false;
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        cooldownRaceActive = true;
        return makeAttemptResult({ promptError: subscriptionLimit });
      }
      return makeAttemptResult({ assistantTexts: ["backup ok"], promptError: null });
    });
    const firstRuntimePlan = makeForwardedRuntimePlan({
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
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
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(firstRuntimePlan)
      .mockReturnValueOnce(secondRuntimePlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId, model }: { profileId?: string; model?: { api?: string } } = {}) => {
        expect(profileId).toBe("openai:backup");
        expect(model?.api).toBe("openai-responses");
        return {
          apiKey: "platform-key",
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key" as const,
        };
      },
    );
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub", "openai:cooled", "openai:backup"]);
    mockedIsProfileInCooldown.mockImplementation(
      (_store, profileId) => cooldownRaceActive && profileId === "openai:cooled",
    );
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
        "openai:cooled": {
          type: "api_key",
          provider: "openai",
          key: "sk-cooled",
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
      await runEmbeddedAgent({
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
        authProfileId: "openai:sub",
        authProfileIdSource: "auto",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledOnce();
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledOnce();
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("openai", "platform-key");
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:cooled" }),
    );
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    const firstAttempt = expectMockCallFields(pluginRunAttempt, {
      provider: "openai",
      authProfileId: "openai:sub",
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
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
      },
    });
    expectRuntimePlanFields(secondAttempt.runtimePlan, {
      auth: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
    expectRecordFields(firstAttempt.model, {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expectRecordFields(secondAttempt.model, {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectMockCallFields(mockedBuildAgentRuntimePlan, {
      preparedAuthPlan: expect.objectContaining({
        modelRoute: expect.objectContaining({
          api: "openai-chatgpt-responses",
          authRequirement: "subscription",
        }),
      }),
    });
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuthPlan: expect.objectContaining({
          modelRoute: expect.objectContaining({
            api: "openai-responses",
            authRequirement: "api-key",
          }),
        }),
      }),
    );
    const firstAuthProfileStore = expectRecordFields(firstAttempt.authProfileStore, {});
    const firstAuthProfiles = expectRecordFields(firstAuthProfileStore.profiles, {});
    expect(Object.keys(firstAuthProfiles)).toEqual(["openai:sub"]);
    const secondAuthProfileStore = expectRecordFields(secondAttempt.authProfileStore, {});
    const secondAuthProfiles = expectRecordFields(secondAuthProfileStore.profiles, {});
    expect(Object.keys(secondAuthProfiles)).toEqual(["openai:backup"]);
    expect(secondAuthProfileStore).not.toBe(firstAuthProfileStore);
    expect(firstAttempt.resolvedApiKey).toBeUndefined();
    expect(secondAttempt.resolvedApiKey).toBe("platform-key");
  });

  it("clears a Platform key when Codex rotates to a subscription profile", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const platformLimit = new Error("Platform profile rate limited");
    const normalizedLimit = Object.assign(new Error(platformLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    let attemptCount = 0;
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => {
      attemptCount += 1;
      return attemptCount === 1
        ? makeAttemptResult({ promptError: platformLimit })
        : makeAttemptResult({ assistantTexts: ["subscription ok"], promptError: null });
    });
    const platformPlan = makeForwardedRuntimePlan({
      resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "codex" },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:platform",
        forwardedAuthProfileCandidateIds: ["openai:platform"],
        selectedAuthMode: "api_key",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      },
    });
    const subscriptionPlan = makeForwardedRuntimePlan({
      resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "codex" },
      auth: {
        providerForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:sub",
        forwardedAuthProfileCandidateIds: ["openai:sub"],
        selectedAuthMode: "oauth",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authStorage,
    });
    queueOpenAIResolvedModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authStorage,
    });
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(platformPlan)
      .mockReturnValueOnce(subscriptionPlan);
    mockedGetApiKeyForModel.mockImplementation(
      async ({ profileId, model }: { profileId?: string; model?: { api?: string } } = {}) => {
        expect(profileId).toBe("openai:platform");
        expect(model?.api).toBe("openai-responses");
        return {
          apiKey: "platform-key",
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key" as const,
        };
      },
    );
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:platform", "openai:sub"]);
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === platformLimit ? normalizedLimit : null,
    );
    mockedDescribeFailoverError.mockImplementation((error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
      reason: error === normalizedLimit ? "rate_limit" : undefined,
      status: error === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: { agents: { defaults: { agentRuntime: { id: "codex" } } } },
        runId: "forced-codex-platform-to-subscription",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(mockedGetApiKeyForModel).toHaveBeenCalledOnce();
    expect(pluginRunAttempt).toHaveBeenCalledTimes(2);
    const firstAttempt = mockCallArg(pluginRunAttempt) as EmbeddedRunAttemptParams;
    const secondAttempt = mockCallArg(pluginRunAttempt, 1) as EmbeddedRunAttemptParams;
    expect(firstAttempt.resolvedApiKey).toBe("platform-key");
    expect(secondAttempt.resolvedApiKey).toBeUndefined();
    expect(Object.keys(firstAttempt.authProfileStore.profiles)).toEqual(["openai:platform"]);
    expect(Object.keys(secondAttempt.authProfileStore.profiles)).toEqual(["openai:sub"]);
    expect(secondAttempt.authProfileStore).not.toBe(firstAttempt.authProfileStore);
    expectRecordFields(firstAttempt.model, {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectRecordFields(secondAttempt.model, {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("selects OpenClaw for a profile-to-direct subscription fallback plan", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const subscriptionLimit = new Error("subscription profile exhausted");
    const normalizedLimit = Object.assign(new Error(subscriptionLimit.message), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>();
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      authBootstrap: "harness",
      supports: (context) =>
        context.modelProvider?.preparedAuth?.requirement === "subscription" &&
        context.modelProvider.preparedAuth.source !== "profile"
          ? { supported: false, reason: "direct subscription auth is not reproducible" }
          : { supported: true, priority: 100 },
      runAttempt: pluginRunAttempt,
    });
    const authStorage = { setRuntimeApiKey: vi.fn() };
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "gpt-5.5",
        provider: "openai",
        contextWindow: 200_000,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      error: null,
      authStorage,
      modelRegistry: {},
    });
    mockedEnsureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:sub": {
          type: "oauth",
          provider: "openai",
          access: "profile-subscription-token",
          refresh: "profile-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedResolveAuthProfileOrder.mockReturnValue(["openai:sub"]);
    mockedResolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "literal" });
    mockedGetApiKeyForModel.mockImplementation(async ({ profileId }: { profileId?: string } = {}) =>
      profileId
        ? {
            apiKey: "profile-subscription-token",
            profileId,
            source: `profile:${profileId}`,
            mode: "oauth" as const,
          }
        : {
            apiKey: "direct-subscription-token",
            source: "models.providers.openai",
            mode: "oauth" as const,
          },
    );
    const route = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription" as const,
      requestTransportOverrides: "none" as const,
    };
    mockedBuildAgentRuntimePlan
      .mockReturnValueOnce(
        makeForwardedRuntimePlan({
          resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "openclaw" },
          auth: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            forwardedAuthProfileId: "openai:sub",
            forwardedAuthProfileCandidateIds: ["openai:sub"],
            selectedAuthMode: "oauth",
            modelRoute: route,
          },
        }),
      )
      .mockReturnValueOnce(
        makeForwardedRuntimePlan({
          resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "openclaw" },
          auth: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "oauth",
            modelRoute: route,
          },
        }),
      );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: subscriptionLimit }))
      .mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["direct fallback ok"], promptError: null }),
      );
    mockedCoerceToFailoverError.mockImplementation((error) =>
      error === subscriptionLimit ? normalizedLimit : null,
    );
    mockedDescribeFailoverError.mockImplementation((error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
      reason: error === normalizedLimit ? "rate_limit" : undefined,
      status: error === normalizedLimit ? 429 : undefined,
      code: undefined,
    }));

    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-chatgpt-responses",
                auth: "oauth",
                apiKey: "configured-direct-subscription-token",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [],
              },
            },
          },
        },
        runId: "implicit-codex-full-plan-falls-back-openclaw",
      });
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectMockCallFields(mockedRunEmbeddedAttempt, {
      agentHarnessId: "openclaw",
      authProfileId: "openai:sub",
      resolvedApiKey: "profile-subscription-token",
    });
    expectMockCallFields(
      mockedRunEmbeddedAttempt,
      {
        agentHarnessId: "openclaw",
        authProfileId: undefined,
        resolvedApiKey: "direct-subscription-token",
      },
      1,
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
      supports: codexHarnessSupportsKnownProviders,
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

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactParams = expectMockCallFields(mockedCompactDirect, {
      sessionId: "test-session",
      sessionTarget: expect.objectContaining({
        sessionId: "test-session",
        sessionKey: "test-key",
      }),
    });
    expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
      authProfileId: "test-profile",
    });
  });

  it("keeps implicit Codex overflow recovery out of generic compaction without a native compactor", async () => {
    useOpenAIPlatformAuthFixture();
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const overflowError = makeOverflowError();
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        promptError: overflowError,
        promptErrorSource: "prompt",
        assistantTexts: [],
      }),
    );
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: codexHarnessSupportsKnownProviders,
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
    });

    try {
      await expect(
        runEmbeddedAgent({
          ...overflowBaseRunParams,
          provider: "openai",
          model: "gpt-5.5",
          config: {
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: "test-key",
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          },
          runId: "implicit-codex-overflow-owner",
        }),
      ).rejects.toThrow(overflowError.message);
    } finally {
      clearAgentHarnesses();
    }

    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    const attemptParams = expectMockCallFields(pluginRunAttempt, { agentHarnessId: "codex" });
    expect(attemptParams.modelSelectionLocked).not.toBe(true);
    expect(mockedIsLikelyContextOverflowError).toHaveBeenCalledWith(overflowError.message);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("preserves a locked OpenClaw model in overflow compaction context", async () => {
    useOpenAIPlatformAuthFixture();
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
      config: {
        agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
      },
    });

    const compactParams = expectMockCallFields(mockedCompactDirect, {});
    expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
      modelSelectionLocked: true,
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("preserves an explicit empty fallback override in overflow compaction context", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      modelFallbacksOverride: [],
      config: {
        agents: {
          defaults: {
            model: { fallbacks: ["anthropic/claude-opus-4-6"] },
          },
        },
      },
    });

    const compactParams = expectMockCallFields(mockedCompactDirect, {});
    expectRecordFields(compactParams.runtimeContext, {
      trigger: "overflow",
      modelFallbacksOverride: [],
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

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

  it("recovers preflight compaction when stale tokens point at an empty transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-preflight-"));
    const storePath = path.join(dir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "test-key", storePath },
      {
        sessionId: "test-session",
        updatedAt: 1,
        totalTokens: 1_500_000,
        totalTokensFresh: true,
        inputTokens: 20,
        outputTokens: 10_855,
        cacheRead: 1_761_324,
        cacheWrite: 33_047,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "claude-cli",
          model: "claude-opus-4-7",
          route: "compact_only",
          shouldCompact: true,
          estimatedPromptTokens: 1_794_391,
          contextTokenBudget: 1_048_576,
          promptBudgetBeforeReserve: 1_044_480,
          reserveTokens: 4_096,
          effectiveReserveTokens: 4_096,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 749_911,
          toolResultReducibleChars: 0,
          messageCount: 0,
          unwindowedMessageCount: 0,
        },
      },
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 1,
            provider: "claude-cli",
            model: "claude-opus-4-7",
            route: "compact_only",
            shouldCompact: true,
            estimatedPromptTokens: 1_794_391,
            contextTokenBudget: 1_048_576,
            promptBudgetBeforeReserve: 1_044_480,
            reserveTokens: 4_096,
            effectiveReserveTokens: 4_096,
            remainingPromptBudgetTokens: 0,
            overflowTokens: 749_911,
            toolResultReducibleChars: 0,
            messageCount: 0,
            unwindowedMessageCount: 0,
          },
          assistantTexts: [],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });

    try {
      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        config: {
          session: {
            store: storePath,
          },
        } as RunEmbeddedAgentParams["config"],
      });

      expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.agentMeta?.compactionTokensAfter).toBeUndefined();
      expect(result.meta.agentMeta?.contextBudgetStatus).toBeUndefined();
      const stored = loadSessionEntry({ sessionKey: "test-key", storePath });
      expect(stored?.totalTokens).toBe(0);
      expect(stored?.totalTokensFresh).toBe(true);
      expect(stored?.inputTokens).toBeUndefined();
      expect(stored?.outputTokens).toBeUndefined();
      expect(stored?.cacheRead).toBeUndefined();
      expect(stored?.cacheWrite).toBeUndefined();
      expect(stored?.contextBudgetStatus).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expectMockCallFields(mockedCompactDirect, {
      currentTokenCount: 277403,
    });
    expect(result.meta.error).toBeUndefined();
  });

  it("passes preflight prompt estimates into synthetic overflow compaction", async () => {
    mockedExtractObservedOverflowTokenCount.mockReturnValueOnce(undefined);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          promptErrorSource: "precheck",
          preflightRecovery: {
            route: "compact_then_truncate",
            estimatedPromptTokens: 268138,
            promptBudgetBeforeReserve: 241616,
            overflowTokens: 26522,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-preflight",
        tokensBefore: 268138,
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expectMockCallFields(mockedCompactDirect, {
      currentTokenCount: 268138,
    });
    expectRecordFields(expectMockCallFields(mockedCompactDirect, {}).runtimeContext, {
      currentTokenCount: 268138,
    });
    expect(result.meta.error).toBeUndefined();
  });

  it("passes minimally over-budget count when overflow text is confirmed but unparseable", async () => {
    mockedExtractObservedOverflowTokenCount.mockReturnValueOnce(undefined);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          lastAssistant: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Context window exceeded for this request.",
            usage: { totalTokens: 0 },
          } as never,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-9",
        tokensBefore: 200001,
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expectMockCallFields(mockedCompactDirect, {
      currentTokenCount: 200001,
    });
    expect(result.meta.error).toBeUndefined();
  });

  it("surfaces a visible blocked payload for Codex promptError overflow without assistant text", async () => {
    const promptError = new Error(
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );
    const terminalLifecycleMeta: Array<Record<string, unknown>> = [];
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError,
        promptErrorSource: "prompt",
        assistantTexts: [],
        attemptUsage: { input: 0, output: 0, total: 0 },
        setTerminalLifecycleMeta: (meta) => {
          terminalLifecycleMeta.push(meta);
        },
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedIsLikelyContextOverflowError).toHaveBeenCalledWith(promptError.message);
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining("Context overflow"),
    });
    expect(result.payloads?.[0]?.text).toContain("/reset");
    expect(result.payloads?.[0]?.text).toContain("/new");
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.finalAssistantVisibleText).toBe(result.payloads?.[0]?.text);
    expect(terminalLifecycleMeta.at(-1)).toMatchObject({ livenessState: "blocked" });
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

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

    await runEmbeddedAgent(overflowBaseRunParams);

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

    await runEmbeddedAgent(overflowBaseRunParams);

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
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
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

    const replyOperation = createReplyOperation({
      sessionKey: "test-key",
      sessionId: "test-session",
      resetTriggered: false,
    });
    const onSessionIdChanged = vi.fn();
    replyOperation.setPhase("running");
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        replyOperation,
        onSessionIdChanged,
      });

      const compactParams = expectMockCallFields(mockedCompactDirect, {});
      expectMockCallFields(
        mockedRunEmbeddedAttempt,
        {
          sessionId: "rotated-session",
          sessionFile: "/tmp/rotated-session.json",
        },
        1,
      );
      const maintenanceParams = expectMockCallFields(mockedRunContextEngineMaintenance, {
        sessionId: "rotated-session",
        sessionFile: "/tmp/rotated-session.json",
      });
      expect(maintenanceParams.runtimeSettings).toBe(compactParams.runtimeSettings);
      const runtimeSettings = expectRecordFields(maintenanceParams.runtimeSettings, {});
      expectRecordFields(runtimeSettings.runtime, {
        mode: "degraded",
      });
      expectRecordFields(runtimeSettings.diagnostics, {
        degradedReason: "context_overflow",
      });
      expect(replyOperation.sessionId).toBe("rotated-session");
      expect(onSessionIdChanged).toHaveBeenCalledWith("rotated-session");
      expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction), {
        previousSessionId: "test-session",
        sessionFile: "/tmp/rotated-session.json",
      });
      expectRecordFields(mockCallArg(mockedGlobalHookRunner.runAfterCompaction, 0, 1), {
        sessionId: "rotated-session",
      });
    } finally {
      replyOperation.complete();
    }
  });

  it("uses the top-level successor id when resolving a partial compaction session target", async () => {
    const rotatedStorePath = "/tmp/rotated-sessions.sqlite";
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          sessionIdUsed: "rotated-session",
          sessionFileUsed: `sqlite:main:rotated-session:${rotatedStorePath}`,
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "rotated overflow compaction",
        tokensAfter: 50,
        sessionId: "rotated-session",
        sessionTarget: {
          sessionKey: "test-key",
          storePath: rotatedStorePath,
        },
      },
    });

    await runEmbeddedAgent(overflowBaseRunParams);

    expectMockCallFields(
      mockedRunEmbeddedAttempt,
      {
        sessionId: "rotated-session",
        sessionFile: `sqlite:main:rotated-session:${rotatedStorePath}`,
      },
      1,
    );
    expectMockCallFields(mockedRunContextEngineMaintenance, {
      sessionId: "rotated-session",
      sessionFile: `sqlite:main:rotated-session:${rotatedStorePath}`,
    });
  });

  it("does not let an old execution rotate a newer same-id run context", async () => {
    resetAgentRunContextForTest();
    const currentLifecycleGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext("shared-run", {
      sessionKey: "new-session-key",
      sessionId: "new-session",
      lifecycleGeneration: currentLifecycleGeneration,
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: "old-rotated-session",
      }),
    );

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        runId: "shared-run",
        lifecycleGeneration: "pre-restart",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(getAgentRunContext("shared-run")).toEqual(
      expect.objectContaining({
        sessionKey: "new-session-key",
        sessionId: "new-session",
        lifecycleGeneration: currentLifecycleGeneration,
      }),
    );
    resetAgentRunContextForTest();
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("threads a composed run abort signal into engine-owned overflow compaction", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    const abortController = new AbortController();
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({ summary: "engine-owned compaction", tokensAfter: 50 }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      abortSignal: abortController.signal,
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactArg = mockCallArg(mockedCompactDirect) as { abortSignal?: AbortSignal };
    expect(compactArg.abortSignal).toBeInstanceOf(AbortSignal);
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

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
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "test-profile": {
          provider: "anthropic",
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedCoerceToFailoverError.mockReturnValue(normalized);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalized ? "rate_limit" : undefined,
      status: err === normalized ? 429 : undefined,
      code: undefined,
    }));
    mockedResolveFailoverStatus.mockReturnValue(429);

    await expect(
      runEmbeddedAgent({
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
      authMode: "oauth",
    });
    expect(mockedResolveFailoverStatus).toHaveBeenCalledWith("rate_limit");
  });
});
