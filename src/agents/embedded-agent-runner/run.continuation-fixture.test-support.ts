import { expect, vi } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import type { AgentInternalEvent } from "../internal-events.js";
import type {
  AgentRuntimeAuthModelRoute,
  AgentRuntimeAuthPlan,
  AgentRuntimePlan,
} from "../runtime-plan/types.js";
import { mockedResolveModelAsync } from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

type RuntimePlanAuthOverrides = Partial<Omit<AgentRuntimeAuthPlan, "modelRoute">> & {
  modelRoute?: AgentRuntimeAuthModelRoute;
};

type RuntimePlanOverrides = Partial<Omit<AgentRuntimePlan, "auth" | "resolvedRef">> & {
  auth?: RuntimePlanAuthOverrides;
  resolvedRef?: Partial<AgentRuntimePlan["resolvedRef"]>;
};

type MockWithCalls = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
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

export function makeForwardingCase(internalEvents: AgentInternalEvent[]) {
  const onAgentToolResult = vi.fn();
  const conversationRecall = {
    anchorSessionKey: "agent:main:telegram:direct:owner",
    scope: "same-agent-private" as const,
    corpus: "sessions" as const,
  };
  return {
    runId: "forward-attempt-params",
    params: {
      toolsAllow: ["exec", "read"],
      conversationRecall,
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
      conversationRecall,
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

export function codexHarnessSupportsKnownProviders(
  ctx: Parameters<AgentHarness["supports"]>[0],
): ReturnType<AgentHarness["supports"]> {
  return ctx.provider === "codex" || ctx.provider === "openai" || ctx.provider === "openai"
    ? { supported: true, priority: 100 }
    : { supported: false };
}

export function makeForwardedRuntimePlan(overrides: RuntimePlanOverrides = {}): AgentRuntimePlan {
  const transcriptPolicy = {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    preserveNativeAnthropicToolUseIds: false,
    repairToolUseResultPairing: true,
    preserveSignatures: false,
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

export function mockCall(mock: MockWithCalls, callIndex = 0): ReadonlyArray<unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call;
}

export function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mockCall(mock, callIndex);
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

export function expectRecordFields(
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

export function expectMockCallFields(
  mock: MockWithCalls,
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

export function expectLogIncludes(mock: { mock: { calls: unknown[][] } }, fragment: string): void {
  expect(mock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(fragment);
}

export function expectLogExcludes(mock: { mock: { calls: unknown[][] } }, fragment: string): void {
  expect(mock.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(fragment);
}

export function queueOpenAIResolvedModel(params: {
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

export function expectRuntimePlanFields(
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

export async function waitForRunEvent(events: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (events.includes(expected)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected run event ${expected}; saw ${events.join(", ")}`);
}
