// Shared mocks and fixtures for agent-runner execution tests.
import { afterEach, beforeEach, expect, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../agents/embedded-agent-helpers/errors.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { ReplyOptionsWithHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";
export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

const state = vi.hoisted(() => ({
  runEmbeddedAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  isCliProviderMock: vi.fn((_: unknown) => false),
  isInternalMessageChannelMock: vi.fn((_: unknown) => false),
  createBlockReplyDeliveryHandlerMock: vi.fn(),
  isCompactionFailureErrorMock: vi.fn((_: string | undefined) => false),
  isContextOverflowErrorMock: vi.fn((_: string | undefined) => false),
  isLikelyContextOverflowErrorMock: vi.fn((_: string | undefined) => false),
  updateSessionStoreMock: vi.fn(),
  resolveCurrentTurnImagesMock: vi.fn(),
  peekSessionMcpRuntimeMock: vi.fn(),
}));

export const GENERIC_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
export function makeTestModel(id: string, contextTokens: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  };
}

vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: (params: unknown) => state.peekSessionMcpRuntimeMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: (provider: unknown) => state.isCliProviderMock(provider),
  };
});

vi.mock("../../agents/bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/embedded-agent-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-helpers.js")>(
    "../../agents/embedded-agent-helpers.js",
  );
  return {
    BILLING_ERROR_USER_MESSAGE: "billing",
    formatBillingErrorMessage: actual.formatBillingErrorMessage,
    formatRateLimitOrOverloadedErrorCopy: (message: string) => {
      if (/model\s+(?:is\s+)?at capacity/i.test(message)) {
        return "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
      }
      if (/rate.limit|too many requests|429/i.test(message)) {
        return "⚠️ API rate limit reached. Please try again later.";
      }
      if (/overloaded/i.test(message)) {
        return "The AI service is temporarily overloaded. Please try again in a moment.";
      }
      return undefined;
    },
    isCompactionFailureError: (message?: string) => state.isCompactionFailureErrorMock(message),
    isContextOverflowError: (message?: string) => state.isContextOverflowErrorMock(message),
    isBillingErrorMessage: actual.isBillingErrorMessage,
    isLikelyContextOverflowError: (message?: string) =>
      state.isLikelyContextOverflowErrorMock(message),
    isOverloadedErrorMessage: (message: string) => /overloaded|capacity/i.test(message),
    isRateLimitErrorMessage: (message: string) =>
      /rate.limit|too many requests|429|usage limit/i.test(message),
    isTransientHttpError: () => false,
    sanitizeUserFacingText: (text?: string) => text ?? "",
  };
});

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: state.updateSessionStoreMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  const emitAgentEvent = vi.fn((...args: Parameters<typeof actual.emitAgentEvent>) =>
    actual.emitAgentEvent(...args),
  );
  return {
    ...actual,
    clearAgentRunContext: vi.fn(),
    emitAgentEvent,
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));

vi.mock("../heartbeat.js", () => ({
  stripHeartbeatToken: (text: string) => ({
    text,
    didStrip: false,
    shouldSkip: false,
  }),
}));

vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: (params: unknown) => state.resolveCurrentTurnImagesMock(params),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (params: {
    provider: string;
    model: string;
    run: {
      provider?: string;
      thinkLevel?: string;
      authProfileId?: string;
      authProfileIdSource?: "auto" | "user";
      agentAccountId?: string;
      chatType?: string;
    };
    replyRoute?: {
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingChatType?: string;
    };
    sessionCtx: { AccountId?: string; ChatType?: string };
  }) => ({
    embeddedContext: {
      messageProvider: params.replyRoute?.originatingChannel,
      messageTo: params.replyRoute?.originatingTo,
      agentAccountId:
        params.replyRoute?.originatingAccountId ??
        params.sessionCtx.AccountId ??
        params.run.agentAccountId,
      chatType:
        params.replyRoute?.originatingChatType ?? params.sessionCtx.ChatType ?? params.run.chatType,
    },
    senderContext: {},
    runBaseParams: {
      provider: params.provider,
      model: params.model,
      thinkLevel: params.run.thinkLevel,
      authProfileId: params.provider === params.run.provider ? params.run.authProfileId : undefined,
      authProfileIdSource:
        params.provider === params.run.provider ? params.run.authProfileIdSource : undefined,
    },
  }),
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
  resolveModelFallbackOptions: vi.fn(
    (run: { provider?: string; model?: string; config?: unknown; agentDir?: string }) => ({
      provider: run.provider,
      model: run.model,
      cfg: run.config,
      agentDir: run.agentDir,
    }),
  ),
  resolveRunFastModeForFallbackCandidate: (params: {
    run: { fastMode?: unknown; fastModeAutoOnSeconds?: unknown };
  }) => ({
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
  }),
}));

vi.mock("./reply-delivery.js", () => ({
  createBlockReplyDeliveryHandler: (params: unknown) =>
    state.createBlockReplyDeliveryHandlerMock(params),
}));

vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaContext: () => ({
    normalizePayload: (payload: unknown) => payload,
  }),
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

export async function getRunAgentTurnWithFallback() {
  return (await import("./agent-runner-execution.js")).runAgentTurnWithFallback;
}

export type FallbackRunnerParams = {
  provider: string;
  model: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  run: (provider: string, model: string) => Promise<unknown>;
  classifyResult?: (params: {
    result: { payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }> };
    provider: string;
    model: string;
    attempt: number;
    total: number;
  }) => Promise<unknown>;
};

export type EmbeddedAgentParams = {
  prompt?: string;
  transcriptPrompt?: string;
  lifecycleGeneration?: string;
  onExecutionStarted?: (info?: { lifecycleGeneration?: string }) => void;
  onExecutionPhase?: (info: {
    phase:
      | "runner_entered"
      | "workspace"
      | "runtime_plugins"
      | "before_agent_reply"
      | "model_resolution"
      | "auth"
      | "context_engine"
      | "attempt_dispatch"
      | "context_assembled"
      | "turn_accepted"
      | "process_spawned"
      | "tool_execution_started"
      | "assistant_output_started"
      | "model_call_started";
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    tool?: string;
    toolCallId?: string;
    itemId?: string;
  }) => void;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoningSnapshot?: boolean;
    requiresReasoningProgressOptIn?: boolean;
  }) => Promise<void> | void;
  onReasoningEnd?: () => Promise<void> | void;
  onItemEvent?: (payload: {
    itemId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void;
  onAgentEvent?: (payload: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<void> | void;
};

export function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
    signalExecutionActivity: vi.fn(async () => {}),
  };
}

export function createFollowupRun(): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

export function createTestUserTurnRecorder(message: PersistedUserTurnMessage) {
  return createUserTurnTranscriptRecorder({
    message,
    target: createTestUserTurnTranscriptTarget(),
    updateMode: "none",
  });
}

export function createMockReplyOperation(options?: { abortSignal?: AbortSignal }): {
  replyOperation: ReplyOperation;
  failMock: ReturnType<typeof vi.fn>;
  freezeAbortMock: ReturnType<typeof vi.fn>;
  retainFailureUntilCompleteMock: ReturnType<typeof vi.fn>;
  updateSessionIdMock: ReturnType<typeof vi.fn>;
} {
  const failMock = vi.fn();
  const freezeAbortMock = vi.fn();
  const retainFailureUntilCompleteMock = vi.fn();
  const updateSessionIdMock = vi.fn();
  return {
    failMock,
    freezeAbortMock,
    retainFailureUntilCompleteMock,
    updateSessionIdMock,
    replyOperation: {
      key: "main",
      sessionId: "session",
      abortSignal: options?.abortSignal ?? new AbortController().signal,
      resetTriggered: false,
      terminalRecovery: false,
      acceptedSteeredInboundAudio: false,
      phase: "running",
      result: null,
      startedAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      hasOwnedSessionId: vi.fn((sessionId: string) => sessionId === "session"),
      recordActivity: vi.fn(),
      setPhase: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
      markDeferredMaintenanceWaitEnded: vi.fn(),
      updateSessionId: updateSessionIdMock,
      updateSessionKey: vi.fn(),
      attachBackend: vi.fn(),
      detachBackend: vi.fn(),
      freezeAbort: freezeAbortMock,
      retainFailureUntilComplete: retainFailureUntilCompleteMock,
      complete: vi.fn(),
      completeThen: vi.fn((afterClear: () => void) => afterClear()),
      completeWithAfterClearBarrier: vi.fn(),
      fail: failMock,
      abortByUser: vi.fn(() => true),
      abortForRestart: vi.fn(() => true),
      markTerminalRecovery: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
    },
  };
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

export function expectNoMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const hasMatchingCall = calls.some((call) => {
    const value = call[0];
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => record[key] === expected);
  });
  expect(hasMatchingCall).toBe(false);
}

export function requireMockCallArgWithFields(
  mock: unknown,
  fields: Record<string, unknown>,
  label: string,
) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const found = calls
    .map((call) => call[0])
    .find((value) => {
      if (typeof value !== "object" || value === null) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return Object.entries(fields).every(([key, expected]) => record[key] === expected);
    });
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return requireRecord(found, label);
}

export function expectBlockReplyCall(
  onBlockReply: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectMockCallArgFields(onBlockReply, index, "block reply payload", fields);
}

export function createMinimalRunAgentTurnParams(overrides?: {
  followupRun?: FollowupRun;
  opts?: GetReplyOptions & ReplyOptionsWithHeartbeatRunScope;
  replyOperation?: ReplyOperation;
  sessionCtx?: TemplateContext;
  typingSignals?: TypingSignaler;
}) {
  return {
    commandBody: "fix it",
    followupRun: overrides?.followupRun ?? createFollowupRun(),
    sessionCtx:
      overrides?.sessionCtx ??
      ({
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext),
    opts: overrides?.opts ?? ({} satisfies GetReplyOptions),
    replyOperation: overrides?.replyOperation,
    typingSignals: overrides?.typingSignals ?? createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: (payload: ReplyPayload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
  };
}

export const NON_DIRECT_FAILURE_SURFACE_CASES = [
  { label: "Discord group", provider: "discord", chatType: "group" },
  { label: "Discord channel", provider: "discord", chatType: "channel" },
  { label: "Slack channel", provider: "slack", chatType: "channel" },
  { label: "Telegram group", provider: "telegram", chatType: "group" },
  { label: "WhatsApp group", provider: "whatsapp", chatType: "group" },
  { label: "Microsoft Teams channel", provider: "msteams", chatType: "channel" },
] as const;

export function createNonDirectFailureSessionCtx(
  testCase: (typeof NON_DIRECT_FAILURE_SURFACE_CASES)[number],
): TemplateContext {
  return {
    Provider: testCase.provider,
    Surface: testCase.provider,
    ChatType: testCase.chatType,
    GroupSubject: `${testCase.label} fixture`,
    GroupChannel: "#general",
    MessageSid: "msg",
  } as unknown as TemplateContext;
}

export function setupAgentRunnerExecutionTestState() {
  beforeEach(() => {
    vi.useRealTimers();
    state.runEmbeddedAgentMock.mockReset();
    state.runCliAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.isCliProviderMock.mockReset();
    state.isCliProviderMock.mockReturnValue(false);
    state.isInternalMessageChannelMock.mockReset();
    state.isInternalMessageChannelMock.mockReturnValue(false);
    state.createBlockReplyDeliveryHandlerMock.mockReset();
    state.createBlockReplyDeliveryHandlerMock.mockReturnValue(undefined);
    state.isCompactionFailureErrorMock.mockReset();
    state.isCompactionFailureErrorMock.mockReturnValue(false);
    state.isContextOverflowErrorMock.mockReset();
    state.isContextOverflowErrorMock.mockReturnValue(false);
    state.isLikelyContextOverflowErrorMock.mockReset();
    state.isLikelyContextOverflowErrorMock.mockReturnValue(false);
    state.updateSessionStoreMock.mockReset();
    state.resolveCurrentTurnImagesMock.mockReset();
    state.peekSessionMcpRuntimeMock.mockReset();
    state.peekSessionMcpRuntimeMock.mockReturnValue(undefined);
    state.resolveCurrentTurnImagesMock.mockImplementation(
      async (params: { images?: unknown[]; imageOrder?: unknown[] }) => ({
        images: params.images,
        imageOrder: params.imageOrder,
      }),
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
  });

  afterEach(() => {
    // Fake-timer tests must not leak into --isolate=false peers.
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    vi.clearAllMocks();
  });

  return state;
}
