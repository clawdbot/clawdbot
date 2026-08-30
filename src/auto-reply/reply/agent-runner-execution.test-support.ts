// Shared mocks and fixtures for agent-runner execution tests.
import path from "node:path";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { DeferredEmbeddedRunLifecycleOwner } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { FailoverError, type FallbackAttemptRecord } from "../../agents/failover-error.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../agents/failover/user-copy.js";
import {
  initialModelFallbackAttemptOptions,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

type RunEntryParams = Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0];
type RunEntryResult = Awaited<ReturnType<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>>;
type RunEntryDelegate = (params: RunEntryParams) => Promise<RunEntryResult>;
type RunCliAgent = typeof import("../../agents/cli-runner.js").runCliAgent;

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
export { createMockReplyOperation } from "./test-helpers.js";
export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";
export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

type TestFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

export function createTestFallbackSummaryError(params: {
  message: string;
  attempts: TestFallbackAttempt[];
  soonestCooldownExpiry?: number | null;
  cause?: unknown;
}): FailoverError {
  const lastAttempt = params.attempts.at(-1);
  return new FailoverError(params.message, {
    reason: lastAttempt?.reason ?? "unknown",
    provider: lastAttempt?.provider,
    model: lastAttempt?.model,
    attempts: params.attempts,
    soonestCooldownExpiry: params.soonestCooldownExpiry ?? null,
    cause: params.cause,
  });
}

const state = vi.hoisted(() => ({
  runEmbeddedAgentMock: vi.fn(),
  runEmbeddedAgentEntryMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  isCliProviderMock: vi.fn((_provider: unknown) => false),
  isInternalMessageChannelMock: vi.fn((_channel: unknown) => false),
  createBlockReplyDeliveryHandlerMock: vi.fn(),
  isCompactionFailureErrorMock: vi.fn((_message: string | undefined) => false),
  isContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  isLikelyContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  updateSessionStoreMock: vi.fn(),
  resolveCurrentTurnImagesMock: vi.fn(),
  peekSessionMcpRuntimeMock: vi.fn(),
  recordMessageToolRunOutcomeMock: vi.fn(),
  productionBuildEmbeddedRunExecutionParams: undefined as
    | typeof buildEmbeddedRunExecutionParams
    | undefined,
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

vi.mock("../../agents/embedded-agent-runner/run-entry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/embedded-agent-runner/run-entry.js")
  >("../../agents/embedded-agent-runner/run-entry.js");
  return {
    ...actual,
    runEmbeddedAgentEntry: (params: RunEntryParams) =>
      state.runEmbeddedAgentEntryMock(params, actual.runEmbeddedAgentEntry as RunEntryDelegate),
  };
});

vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: (params: unknown) => state.peekSessionMcpRuntimeMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: unknown) => {
    const input = params as {
      classifyResult?: (classification: { result: unknown; [key: string]: unknown }) => unknown;
      [key: string]: unknown;
    };
    const adapted = input.classifyResult
      ? {
          ...input,
          classifyResult: (classification: { result: unknown; [key: string]: unknown }) => {
            const candidate = classification.result;
            const wrappedCandidate =
              candidate && typeof candidate === "object" && "result" in candidate
                ? candidate
                : { result: candidate };
            return input.classifyResult?.({
              ...classification,
              result: wrappedCandidate,
            });
          },
        }
      : input;
    const resolved = (await state.runWithModelFallbackMock(adapted)) as {
      outcome?: "completed" | "exhausted";
      result?: unknown;
      [key: string]: unknown;
    };
    const candidate = resolved?.result;
    const wrappedCandidate =
      candidate && typeof candidate === "object" && "result" in candidate
        ? candidate
        : { result: candidate };
    return {
      ...resolved,
      outcome: resolved.outcome ?? "completed",
      result: wrappedCandidate,
    };
  },
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
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

vi.mock("../../agents/bootstrap-budget.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/bootstrap-budget.js")>(
    "../../agents/bootstrap-budget.js",
  )),
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/embedded-agent-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-helpers.js")>(
    "../../agents/embedded-agent-helpers.js",
  );
  return {
    ...actual,
    formatBillingErrorMessage: actual.formatBillingErrorMessage,
    isCompactionFailureError: (message?: string) => state.isCompactionFailureErrorMock(message),
    isContextOverflowError: (message?: string) => state.isContextOverflowErrorMock(message),
    isLikelyContextOverflowError: (message?: string) =>
      state.isLikelyContextOverflowErrorMock(message),
    isTransientHttpError: () => false,
    sanitizeUserFacingText: (text?: string) => text ?? "",
  };
});

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: state.updateSessionStoreMock,
}));

vi.mock("../../globals.js", async () => ({
  ...(await vi.importActual<typeof import("../../globals.js")>("../../globals.js")),
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
vi.mock("../../infra/agent-run-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
    "../../infra/agent-run-registry.js",
  );
  return {
    ...actual,
    clearAgentRunContext: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../infra/message-tool-run-outcome-store.js", () => ({
  recordMessageToolRunOutcome: (params: unknown) => state.recordMessageToolRunOutcomeMock(params),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", async () => ({
  ...(await vi.importActual<typeof import("../../utils/message-channel.js")>(
    "../../utils/message-channel.js",
  )),
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));

vi.mock("../heartbeat.js", async () => {
  const actual = await vi.importActual<typeof import("../heartbeat.js")>("../heartbeat.js");
  return {
    ...actual,
    stripHeartbeatToken: (text: string) => ({
      text,
      didStrip: false,
      shouldSkip: false,
    }),
  };
});

vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: (params: unknown) => state.resolveCurrentTurnImagesMock(params),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (
    params: Parameters<typeof buildEmbeddedRunExecutionParams>[0],
  ) =>
    // Most execution tests isolate fallback policy from config/channel discovery. Ownership
    // regressions opt into the production builder so queue metadata must cross the real boundary.
    state.productionBuildEmbeddedRunExecutionParams
      ? state.productionBuildEmbeddedRunExecutionParams(params)
      : {
          embeddedContext: {
            ...params.run,
            messageProvider: params.replyRoute?.originatingChannel,
            messageTo: params.replyRoute?.originatingTo,
            agentAccountId:
              params.replyRoute?.originatingAccountId ??
              params.sessionCtx.AccountId ??
              params.run.agentAccountId,
            chatType:
              params.replyRoute?.originatingChatType ??
              params.sessionCtx.ChatType ??
              params.run.chatType,
          },
          senderContext: {},
          runBaseParams: {
            runId: params.runId,
            provider: params.provider,
            model: params.model,
            thinkLevel: params.run.thinkLevel,
            authProfileId:
              params.provider === params.run.provider ? params.run.authProfileId : undefined,
            authProfileIdSource:
              params.provider === params.run.provider ? params.run.authProfileIdSource : undefined,
          },
        },
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

export async function getExecuteAgentTurnForTest() {
  const execute = (await import("./agent-runner-execution.js")).executeAgentTurn;
  return async (...args: Parameters<typeof execute>) => {
    const execution = await execute(...args);
    const outcome = execution.outcome;
    if (outcome.kind === "settled") {
      return {
        kind: "success" as const,
        runId: execution.runId,
        runResult: outcome.result,
        fallbackProvider: outcome.resolved.provider,
        fallbackModel: outcome.resolved.model,
        ...(outcome.fallback.exhausted ? { fallbackExhausted: true as const } : {}),
        fallbackAttempts: outcome.fallback.attempts,
        didLogHeartbeatStrip: outcome.didLogHeartbeatStrip,
        autoCompactionCount: outcome.autoCompactionCount,
        directlySentBlockKeys: outcome.directlySentBlockKeys,
        directlySentBlockPayloads: outcome.directlySentBlockPayloads,
        terminalFailurePayload: outcome.terminalFailurePayload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    if (outcome.kind === "rejected") {
      return {
        kind: "final" as const,
        payload: outcome.payload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    const payload: ReplyPayload = { text: "NO_REPLY" };
    return { kind: "final" as const, payload };
  };
}

export async function useProductionEmbeddedRunExecutionParamsForTest(): Promise<void> {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  state.productionBuildEmbeddedRunExecutionParams = actual.buildEmbeddedRunExecutionParams;
}

export async function loadActualRunCliAgentForTest(): Promise<RunCliAgent> {
  return (
    await vi.importActual<typeof import("../../agents/cli-runner.js")>("../../agents/cli-runner.js")
  ).runCliAgent;
}

export type FallbackRunnerParams = TestModelFallbackRunnerParams & {
  sessionId?: string;
  abortSignal?: AbortSignal;
  classifyResult?: (params: {
    result: { payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }> };
    provider: string;
    model: string;
    attempt: number;
    total: number;
  }) => Promise<unknown>;
};

export {
  fallbackModelAttemptOptions as fallbackAttemptOptions,
  initialModelFallbackAttemptOptions as initialFallbackAttemptOptions,
  runInitialModelFallbackAttempt as runInitialFallbackAttempt,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";

export type EmbeddedAgentParams = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  prompt?: string;
  transcriptPrompt?: string;
  lifecycleGeneration?: string;
  onDeferredLifecycleOwner?: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
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
  onLaneWait?: (info: { waitMs: number; queuedAhead: number; waiting?: boolean }) => void;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAutoCompactionSucceeded?: (count: number) => void;
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
  const rootDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-agent-execution-");
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "claude-cli", id: "claude-sonnet-4-6", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-5", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-4-8", input: ["text", "image"] },
        { provider: "codex-cli", id: "gpt-5.4", input: ["text", "image"] },
      ],
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
  opts?: GetReplyOptions;
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
    state.runEmbeddedAgentEntryMock
      .mockReset()
      .mockImplementation((params: RunEntryParams, delegate: RunEntryDelegate) => delegate(params));
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
    state.recordMessageToolRunOutcomeMock.mockReset();
    state.productionBuildEmbeddedRunExecutionParams = undefined;
    state.peekSessionMcpRuntimeMock.mockReturnValue(undefined);
    state.resolveCurrentTurnImagesMock.mockImplementation(
      async (params: { images?: unknown[]; imageOrder?: unknown[] }) => ({
        images: params.images,
        imageOrder: params.imageOrder,
      }),
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude", initialModelFallbackAttemptOptions(params)),
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
