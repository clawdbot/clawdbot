import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  buildContextOverflowRecoveryText,
  MAX_LIVE_SWITCH_RETRIES,
} from "./agent-runner-execution.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  isCliProviderMock: vi.fn((_: unknown) => false),
  isInternalMessageChannelMock: vi.fn((_: unknown) => false),
  createBlockReplyDeliveryHandlerMock: vi.fn(),
}));

const GENERIC_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

function makeTestModel(id: string, contextTokens: number): ModelDefinitionConfig {
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

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
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

vi.mock("../../agents/pi-embedded-helpers.js", () => ({
  BILLING_ERROR_USER_MESSAGE: "billing",
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
  isCompactionFailureError: () => false,
  isContextOverflowError: () => false,
  isBillingErrorMessage: () => false,
  isLikelyContextOverflowError: () => false,
  isOverloadedErrorMessage: (message: string) => /overloaded|capacity/i.test(message),
  isRateLimitErrorMessage: (message: string) =>
    /rate.limit|too many requests|429|usage limit/i.test(message),
  isTransientHttpError: () => false,
  sanitizeUserFacingText: (text?: string) => text ?? "",
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: vi.fn(),
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

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (params: {
    provider: string;
    model: string;
    run: { provider?: string; authProfileId?: string; authProfileIdSource?: "auto" | "user" };
  }) => ({
    embeddedContext: {},
    senderContext: {},
    runBaseParams: {
      provider: params.provider,
      model: params.model,
      authProfileId: params.provider === params.run.provider ? params.run.authProfileId : undefined,
      authProfileIdSource:
        params.provider === params.run.provider ? params.run.authProfileIdSource : undefined,
    },
  }),
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
  resolveModelFallbackOptions: vi.fn(() => ({})),
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

async function getRunAgentTurnWithFallback() {
  return (await import("./agent-runner-execution.js")).runAgentTurnWithFallback;
}

async function getApplyFallbackCandidateSelectionToEntry() {
  return (await import("./agent-runner-execution.js")).applyFallbackCandidateSelectionToEntry;
}

type FallbackRunnerParams = {
  run: (provider: string, model: string) => Promise<unknown>;
  classifyResult?: (params: {
    result: { payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }> };
    provider: string;
    model: string;
    attempt: number;
    total: number;
  }) => Promise<unknown>;
};

type EmbeddedAgentParams = {
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onItemEvent?: (payload: {
    itemId?: string;
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

function createMockTypingSignaler(): TypingSignaler {
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
  };
}

function createFollowupRun(): FollowupRun {
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
      thinkLevel: "low",
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

function createMockReplyOperation(): {
  replyOperation: ReplyOperation;
  failMock: ReturnType<typeof vi.fn>;
} {
  const failMock = vi.fn();
  return {
    failMock,
    replyOperation: {
      key: "main",
      sessionId: "session",
      abortSignal: new AbortController().signal,
      resetTriggered: false,
      phase: "running",
      result: null,
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
      attachBackend: vi.fn(),
      detachBackend: vi.fn(),
      complete: vi.fn(),
      completeThen: vi.fn((afterClear: () => void) => afterClear()),
      fail: failMock,
      abortByUser: vi.fn(),
      abortForRestart: vi.fn(),
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

function expectNoMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
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

function requireMockCallArgWithFields(
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
  expect(found).toBeDefined();
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return requireRecord(found, label);
}

function expectBlockReplyCall(
  onBlockReply: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectMockCallArgFields(onBlockReply, index, "block reply payload", fields);
}

function createMinimalRunAgentTurnParams(overrides?: {
  followupRun?: FollowupRun;
  opts?: GetReplyOptions;
  sessionCtx?: TemplateContext;
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
    typingSignals: createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: (payload: ReplyPayload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterCompactionFailure: async () => false,
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
  };
}

describe("buildContextOverflowRecoveryText", () => {
  it("keeps the generic compaction-buffer hint without heartbeat model evidence", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("points to heartbeat model bleed when the last runtime model matches configured heartbeat.model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("ollama/qwen3.5-9b-32k:latest (32k context)");
    expect(text).toContain("openrouter/qwen3.6-plus");
    expect(text).toContain("heartbeat model bleed");
    expect(text).toContain("heartbeat.isolatedSession");
    expect(text).not.toContain("reserveTokensFloor");
  });

  it("does not blame heartbeat when the smaller runtime model is not the configured heartbeat model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });
});

describe("runAgentTurnWithFallback", () => {
  beforeEach(() => {
    state.runEmbeddedPiAgentMock.mockReset();
    state.runCliAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.isCliProviderMock.mockReset();
    state.isCliProviderMock.mockReturnValue(false);
    state.isInternalMessageChannelMock.mockReset();
    state.isInternalMessageChannelMock.mockReturnValue(false);
    state.createBlockReplyDeliveryHandlerMock.mockReset();
    state.createBlockReplyDeliveryHandlerMock.mockReturnValue(undefined);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the static extra system prompt to CLI backends", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.extraSystemPrompt = "dynamic inbound metadata\n\nstable group prompt";
    followupRun.run.extraSystemPromptStatic = "stable group prompt";
    followupRun.originatingChannel = "telegram";

    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      extraSystemPrompt: "dynamic inbound metadata\n\nstable group prompt",
      extraSystemPromptStatic: "stable group prompt",
      trigger: "user",
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  });

  it("bridges CLI assistant agent events into onPartialReply for live preview (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Hello", delta: "Hello" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Hello world", delta: " world" },
      });
      return { payloads: [{ text: "Hello world" }], meta: {} };
    });

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onPartialReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    const partialTexts = onPartialReply.mock.calls.map((call) => call[0].text);
    expect(partialTexts).toEqual(["Hello", "Hello world"]);
  });

  it("serializes and drains bridged CLI assistant previews before completing (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Hello", delta: "Hello" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Hello world", delta: " world" },
      });
      return { payloads: [{ text: "Hello world" }], meta: {} };
    });

    let firstPreviewStarted: (() => void) | undefined;
    let releaseFirstPreview: (() => void) | undefined;
    const firstPreviewPromise = new Promise<void>((resolve) => {
      firstPreviewStarted = resolve;
    });
    const previewOrder: string[] = [];
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (payload) => {
        previewOrder.push(payload.text ?? "");
        if (payload.text === "Hello") {
          firstPreviewStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstPreview = resolve;
          });
          previewOrder.push("Hello released");
        }
      },
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    const runPromise = runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onPartialReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await firstPreviewPromise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(previewOrder).toEqual(["Hello"]);

    releaseFirstPreview?.();
    await runPromise;

    expect(previewOrder).toEqual(["Hello", "Hello released", "Hello world"]);
  });

  it("does not bridge CLI assistant deltas when silentExpected is set (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "secret heartbeat output", delta: "secret heartbeat output" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "NO_REPLY do not preview", delta: " do not preview" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    followupRun.run.silentExpected = true;

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onPartialReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("resolves CLI messageProvider from the live session surface when no origin channel is set", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.messageProvider = "stale-provider";

    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      messageChannel: undefined,
      messageProvider: "discord",
    });
  });

  it("does not pass CLI runtime overrides as embedded harness ids for fallback providers", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-7";
    followupRun.run.config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          agentRuntimeOverride: "claude-cli",
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedPiAgentMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "agentHarnessId",
      "claude-cli",
    );
  });

  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ mediaUrls: ["/tmp/generated.png"] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onToolResult,
      } satisfies GetReplyOptions,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(onToolResult, 0, "tool result payload", {
      mediaUrls: ["/tmp/generated.png"],
    });
    expect(onToolResult.mock.calls[0]?.[0]?.text).toBeUndefined();
  });

  it("surfaces model capacity errors from no-text mid-turn failures", async () => {
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "thinking", isReasoning: true }],
      meta: {
        error: {
          kind: "server_overloaded",
          message: "Selected model is at capacity. Please try a different model.",
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([
        {
          text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
          isError: true,
        },
      ]);
    }
  });

  it("surfaces model capacity errors from pre-reply CLI failures", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      new Error("Selected model is at capacity. Please try a different model."),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai-codex";
    followupRun.run.model = "gpt-5.5";

    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result).toEqual({
      kind: "final",
      payload: {
        text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
      },
    });
  });

  it("classifies GPT-5 plan-only terminal results as fallback-eligible", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai-codex";
    followupRun.run.model = "gpt-5.4";
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "agent stopped after repeated plan-only turns without taking a concrete action.",
          isError: true,
        },
      ],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const first = (await params.run("openai-codex", "gpt-5.4")) as {
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
      };
      const classification = await params.classifyResult?.({
        result: first,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        reason: "format",
        code: "planning_only_result",
      });
      return {
        result: { payloads: [{ text: "fallback ok" }], meta: {} },
        provider: "anthropic",
        model: "claude",
        attempts: [
          {
            provider: "openai-codex",
            model: "gpt-5.4",
            error: "planning-only",
            reason: "format",
          },
        ],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe("fallback ok");
      expect(result.fallbackProvider).toBe("anthropic");
      expect(result.fallbackAttempts[0]?.reason).toBe("format");
    }
  });

  it("does not classify silent NO_REPLY terminal results for fallback", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [{ text: "NO_REPLY" }], meta: {} };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai-codex",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("success");
  });

  it("does not classify empty final payloads after block replies were sent", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai-codex";
    followupRun.run.model = "gpt-5.4";
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { directlySentBlockKeys?: Set<string> }) => async () => {
        params.directlySentBlockKeys?.add("block:1");
      },
    );
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onBlockReply?.({ text: "streamed block" });
      return { payloads: [], meta: {} };
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = (await params.run("openai-codex", "gpt-5.4")) as {
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
      };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai-codex",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        opts: { onBlockReply: vi.fn() } satisfies GetReplyOptions,
      }),
    );

    expect(result.kind).toBe("success");
  });

  it("does not classify empty final payloads while block replies are buffered", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai-codex";
    followupRun.run.model = "gpt-5.4";
    const blockReplyPipeline = {
      enqueue: vi.fn(),
      flush: vi.fn(async () => {}),
      stop: vi.fn(),
      hasBuffered: vi.fn(() => true),
      didStream: vi.fn(() => false),
      isAborted: vi.fn(() => false),
      hasSentPayload: vi.fn(() => false),
      getSentMediaUrls: vi.fn(() => []),
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [], meta: {} };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai-codex",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      blockReplyPipeline,
      blockStreamingEnabled: true,
      opts: { onBlockReply: vi.fn() } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
  });

  it("classifies final GPT-5 terminal-empty results instead of silently succeeding", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [], meta: {} };
      const classification = await params.classifyResult?.({
        result,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempt: 1,
        total: 1,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        reason: "format",
        code: "empty_result",
      });
      return {
        result,
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("success");
  });

  it("rolls back persisted fallback selection when result classification rejects a candidate", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };
    const activeSessionStore = { main: sessionEntry };
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const failedResult = await params.run("openai-codex", "gpt-5.4");
      expect(sessionEntry.providerOverride).toBe("openai-codex");
      expect(sessionEntry.modelOverride).toBe("gpt-5.4");
      const classification = await params.classifyResult?.({
        result: failedResult as { payloads?: [] },
        provider: "openai-codex",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        code: "empty_result",
      });
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(sessionEntry.modelOverride).toBeUndefined();
      return {
        result: { payloads: [{ text: "fallback ok" }], meta: {} },
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it("strips a glued leading NO_REPLY token from streamed tool results", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ text: "NO_REPLYThe user is saying hello" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onToolResult,
      } satisfies GetReplyOptions,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("The user is saying hello");
    expect(onToolResult).toHaveBeenCalledWith({ text: "The user is saying hello" });
  });

  it("continues delivering later streamed tool results after an earlier delivery failure", async () => {
    const delivered: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      if (payload.text === "first") {
        throw new Error("simulated delivery failure");
      }
      delivered.push(payload.text ?? "");
    });
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onToolResult?.({ text: "first", mediaUrls: [] });
      void params.onToolResult?.({ text: "second", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onToolResult } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["second"]);
  });

  it("delivers streamed tool results in callback order even when dispatch latency differs", async () => {
    const deliveryOrder: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      const delay = payload.text === "first" ? 5 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      deliveryOrder.push(payload.text ?? "");
    });
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onToolResult?.({ text: "first", mediaUrls: [] });
      void params.onToolResult?.({ text: "second", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onToolResult } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(deliveryOrder).toEqual(["first", "second"]);
  });

  it("forwards item lifecycle events to reply options", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool:read-1",
          kind: "tool",
          title: "read",
          name: "read",
          phase: "start",
          status: "running",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
      } satisfies GetReplyOptions,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "tool:read-1",
      kind: "tool",
      title: "read",
      name: "read",
      phase: "start",
      status: "running",
    });
  });

  it("skips channel item progress when a matching tool event carries the progress", async () => {
    const onItemEvent = vi.fn();
    const onToolStart = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "cmd-1",
          kind: "command",
          title: "Command",
          name: "bash",
          phase: "start",
          status: "running",
          suppressChannelProgress: true,
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onItemEvent,
          onToolStart,
        } satisfies GetReplyOptions,
      }),
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledWith({
      name: "bash",
      phase: "start",
      args: { command: "pnpm test" },
      detailMode: undefined,
    });
  });

  it("preserves suppressed item progress when no tool-start callback is registered", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "cmd-1",
          kind: "command",
          title: "Command",
          name: "bash",
          phase: "start",
          status: "running",
          suppressChannelProgress: true,
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onItemEvent,
        } satisfies GetReplyOptions,
      }),
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "cmd-1",
      kind: "command",
      title: "Command",
      name: "bash",
      phase: "start",
      status: "running",
    });
  });

  it("forwards raw tool progress detail mode to tool-start reply options", async () => {
    const onToolStart = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "pnpm test -- --watch=false" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onToolStart,
        } satisfies GetReplyOptions,
      }),
      toolProgressDetail: "raw",
    });

    expect(result.kind).toBe("success");
    expect(onToolStart).toHaveBeenCalledWith({
      name: "exec",
      phase: "start",
      args: { command: "pnpm test -- --watch=false" },
      detailMode: "raw",
    });
  });

  it("fires tool-start progress before slow typing signals resolve for best-effort Pi events", async () => {
    const onToolStart = vi.fn(async () => {});
    let releaseTyping: (() => void) | undefined;
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTyping = resolve;
        }),
    );
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "echo hi" },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onToolStart,
        } satisfies GetReplyOptions,
      }),
      typingSignals,
    });

    try {
      expect(result.kind).toBe("success");
      expect(onToolStart).toHaveBeenCalledWith({
        name: "exec",
        phase: "start",
        args: { command: "echo hi" },
        detailMode: undefined,
      });
    } finally {
      releaseTyping?.();
      await Promise.resolve();
    }
  });

  it("leaves Codex app-server telemetry publication to the harness", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "codex_app_server.guardian",
        sessionKey: "agent:main:subagent:codex-child",
        data: {
          phase: "blocked",
          message: "command requires approval",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-codex" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-codex",
      stream: "codex_app_server.guardian",
    });
  });

  it("emits an embedded lifecycle terminal backstop when the runner returns without one", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      return {
        payloads: [{ text: "Request timed out before a response was generated.", isError: true }],
        meta: { aborted: true, livenessState: "blocked", replayInvalid: true },
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-timeout" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    const lifecycleEvent = requireRecord(
      requireMockCallArgWithFields(
        emitAgentEvent,
        { runId: "run-timeout", sessionKey: "main", stream: "lifecycle" },
        "agent event",
      ),
      "agent event",
    );
    expectRecordFields(lifecycleEvent, {
      runId: "run-timeout",
      sessionKey: "main",
      stream: "lifecycle",
    });
    const lifecycleData = requireRecord(lifecycleEvent.data, "lifecycle data");
    expectRecordFields(lifecycleData, {
      phase: "end",
      startedAt: 1_000,
      aborted: true,
      livenessState: "blocked",
      replayInvalid: true,
    });
    expect(typeof lifecycleData.endedAt).toBe("number");
  });

  it("does not duplicate embedded lifecycle terminal events already reported by the runner", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "end", endedAt: 1_500 },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-complete" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-complete",
      stream: "lifecycle",
    });
  });

  it("trims chatty GPT ack-turn final prose", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: [
            "I updated the prompt overlay and tightened the runtime guard.",
            "I also added the ack-turn fast path so short approvals skip the recap.",
            "The reply-side brevity cap now trims long prose-heavy GPT confirmations.",
            "I updated tests for the overlay, retry guard, and reply normalization.",
            "Everything is wired together and ready for verification.",
          ].join(" "),
        },
      ],
      meta: {},
    }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      commandBody: "ok do it",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(
        "I updated the prompt overlay and tightened the runtime guard. I also added the ack-turn fast path so short approvals skip the recap. The reply-side brevity cap now trims long prose-heavy GPT confirmations...",
      );
    }
  });

  it("does not trim GPT replies when the user asked for depth", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const longDetailedReply = [
      "Here is the detailed breakdown.",
      "First, the runner now detects short approval turns and skips the recap path.",
      "Second, the reply layer scores long prose-heavy GPT confirmations and trims them only in chat-style turns.",
      "Third, code fences and richer structured outputs are left untouched so technical answers stay intact.",
      "Finally, the overlay reinforces that this is a live chat and nudges the model toward short natural replies.",
    ].join(" ");
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: longDetailedReply }],
      meta: {},
    }));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      commandBody: "explain in detail what changed",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(longDetailedReply);
    }
  });

  it("forwards plan, approval, command output, and patch events", async () => {
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "plan",
        data: {
          phase: "update",
          title: "Assistant proposed a plan",
          explanation: "Inspect code, patch it, run tests.",
          steps: ["Inspect code", "Patch code", "Run tests"],
        },
      });
      await params.onAgentEvent?.({
        stream: "approval",
        data: {
          phase: "requested",
          kind: "exec",
          status: "pending",
          title: "Command approval requested",
          approvalId: "approval-1",
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "delta",
          title: "command ls",
          toolCallId: "exec-1",
          output: "README.md",
        },
      });
      await params.onAgentEvent?.({
        stream: "patch",
        data: {
          itemId: "patch:patch-1",
          phase: "end",
          title: "apply patch",
          toolCallId: "patch-1",
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: [],
          summary: "1 added, 1 modified",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onPlanUpdate,
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(onPlanUpdate).toHaveBeenCalledWith({
      phase: "update",
      title: "Assistant proposed a plan",
      explanation: "Inspect code, patch it, run tests.",
      steps: ["Inspect code", "Patch code", "Run tests"],
      source: undefined,
    });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Command approval requested",
      itemId: undefined,
      toolCallId: undefined,
      approvalId: "approval-1",
      approvalSlug: undefined,
      command: undefined,
      host: undefined,
      reason: undefined,
      scope: undefined,
      message: undefined,
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      itemId: "command:exec-1",
      phase: "delta",
      title: "command ls",
      toolCallId: "exec-1",
      name: undefined,
      output: "README.md",
      status: undefined,
      exitCode: undefined,
      durationMs: undefined,
      cwd: undefined,
    });
    expect(onPatchSummary).toHaveBeenCalledWith({
      itemId: "patch:patch-1",
      phase: "end",
      title: "apply patch",
      toolCallId: "patch-1",
      name: undefined,
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: [],
      summary: "1 added, 1 modified",
    });
  });

  it("keeps compaction start notices silent by default", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps compaction callbacks active when notices are silent by default", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onBlockReply,
        onCompactionStart,
        onCompactionEnd,
      },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("emits a compaction start notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("emits a compaction completion notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("delivers compaction hook messages without duplicating notifyUser notices", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start", messages: ["Hook before"] },
      });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true, messages: ["Hook after"] },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "Hook before",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "Hook after",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("prefers onCompactionEnd callback over default notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply, onCompactionEnd },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    // The start notice still fires (no onCompactionStart callback provided),
    // but the completion notice is suppressed in favor of the callback.
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
  });

  it("emits an incomplete compaction notice when compaction ends without completing", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: false },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction incomplete",
      isCompactionNotice: true,
    });
  });

  it("does not show a rate-limit countdown for mixed-cause fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 402 (billing)",
        ),
        {
          name: "FallbackSummaryError",
          attempts: [
            { provider: "anthropic", model: "claude", error: "429", reason: "rate_limit" },
            { provider: "openai", model: "gpt-5.4", error: "402", reason: "billing" },
          ],
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).not.toContain("All models failed");
      expect(result.payload.text).not.toContain("402 (billing)");
      expect(result.payload.text).not.toContain("Rate-limited");
    }
  });

  it("surfaces Codex usage-limit reset details for pure fallback exhaustion", async () => {
    const codexMessage =
      "You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error(`All models failed (1): openai/gpt-5.5: ${codexMessage}`), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: codexMessage,
            reason: "rate_limit",
          },
        ],
        soonestCooldownExpiry: null,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(`⚠️ ${codexMessage}`);
      expect(result.payload.text).not.toContain("All models failed");
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
  });

  it("surfaces direct Codex usage-limit errors when fallback does not wrap one attempt", async () => {
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error(codexMessage));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(`⚠️ ${codexMessage}`);
      expectRecordFields(requireRecord(getReplyPayloadMetadata(result.payload), "reply metadata"), {
        deliverDespiteSourceReplySuppression: true,
      });
    }
  });

  it("surfaces billing guidance for pure billing cooldown fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude-opus-4-6: Provider anthropic has billing issue (skipping all models) (billing) | anthropic/claude-sonnet-4-6: Provider anthropic has billing issue (skipping all models) (billing)",
        ),
        {
          name: "FallbackSummaryError",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-6",
              error: "Provider anthropic has billing issue (skipping all models)",
              reason: "billing",
            },
            {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              error: "Provider anthropic has billing issue (skipping all models)",
              reason: "billing",
            },
          ],
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe("billing");
    }
  });

  it("surfaces gateway restart text when fallback exhaustion wraps a drain error", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: new GatewayDrainingError(),
          },
        ],
        soonestCooldownExpiry: null,
        cause: new GatewayDrainingError(),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("gateway_draining");
    expect(failCall[1]).toBeInstanceOf(GatewayDrainingError);
  });

  it("surfaces gateway restart text when fallback exhaustion wraps a cleared lane error", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("fallback exhausted"), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "anthropic",
            model: "claude",
            error: new CommandLaneClearedError("session:main"),
          },
        ],
        soonestCooldownExpiry: null,
        cause: new CommandLaneClearedError("session:main"),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    const failCall = requireMockCall(failMock, 0, "reply operation fail");
    expect(failCall[0]).toBe("command_lane_cleared");
    expect(failCall[1]).toBeInstanceOf(CommandLaneClearedError);
  });

  it("surfaces gateway restart text when the reply operation was aborted for restart", async () => {
    const { replyOperation, failMock } = createMockReplyOperation();
    Object.defineProperty(replyOperation, "result", {
      value: { kind: "aborted", code: "aborted_for_restart" } as const,
      configurable: true,
    });
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      replyOperation,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      );
    }
    expect(failMock).not.toHaveBeenCalled();
  });

  it("uses compact generic copy for raw external chat errors when verbose is off", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it.each([
    {
      rejection: new Error("CLI exceeded timeout (300s) and was terminated."),
      modeLabel: "overall CLI turn budget" as const,
      routingSubstring: undefined as string | undefined,
    },
    {
      rejection: new Error("CLI produced no output for 120s and was terminated."),
      modeLabel: "no-output stall" as const,
      routingSubstring: undefined,
    },
    {
      rejection: new Error(
        "All models failed (2): anthropic/claude-opus-4-7: CLI exceeded timeout (300s) and was terminated. | anthropic/foo: bar",
      ),
      modeLabel: "overall CLI turn budget" as const,
      routingSubstring: "(routing anthropic/claude-opus-4-7)",
    },
    {
      rejection: new Error("codex-cli/gpt-5.5: CLI exceeded timeout (60s) and was terminated."),
      modeLabel: "overall CLI turn budget" as const,
      routingSubstring: "(routing codex-cli/gpt-5.5)",
    },
  ])(
    "surfaces CLI subprocess timeout copy instead of generic failure when verbose is off ($modeLabel)",
    async ({ rejection, modeLabel, routingSubstring }) => {
      state.runWithModelFallbackMock.mockRejectedValueOnce(rejection);

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback({
        ...createMinimalRunAgentTurnParams(),
      });

      expect(result.kind).toBe("final");
      if (result.kind !== "final") {
        throw new Error("expected final reply");
      }
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
      expect(result.payload.text).toContain("CLI subprocess");
      expect(result.payload.text).not.toContain("Claude CLI");
      expect(result.payload.text).toContain(modeLabel);
      expect(result.payload.text).toContain("gateway may still be healthy");
      expect(result.payload.text).toContain("cliBackends.<your-runtime>");
      if (routingSubstring) {
        expect(result.payload.text).toContain(routingSubstring);
      }
    },
  );

  it("forwards sanitized generic errors on external chat channels when verbose is on", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: INVALID_ARGUMENT: some other failure. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it.each(["group", "channel"] as const)(
    "keeps raw runner failure boilerplate out of Discord %s chats",
    async (chatType) => {
      state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
        new Error("openai-codex/gpt-5.5 ended with an incomplete terminal response"),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: {
            Provider: "discord",
            Surface: "discord",
            ChatType: chatType,
            GroupSubject: "agent group",
            GroupChannel: "#general",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it("uses compact generic copy for raw runner failures in normal Discord direct chats", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("openai-codex/gpt-5.5 ended with an incomplete terminal response"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("keeps raw runner failure guidance visible in verbose Discord direct chats", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("openai-codex/gpt-5.5 ended with an incomplete terminal response"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("incomplete terminal response");
    }
  });

  it("formats raw Codex API payloads before forwarding verbose external errors", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        'Codex error: {"type":"error","error":{"type":"server_error","message":"Something exploded"},"sequence_number":2}',
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: LLM error server_error: Something exploded. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("surfaces gateway reauth guidance for known OAuth refresh failures", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for openai-codex. Re-auth with `openclaw models auth login --provider openai-codex`, then try again.",
      );
    }
  });

  it("surfaces direct provider auth guidance for missing API keys", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth; OpenAI agent model runs use openai/gpt-* through the Codex runtime. Set OPENAI_API_KEY only for direct OpenAI API-key surfaces. | No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth; OpenAI agent model runs use openai/gpt-* through the Codex runtime. Set OPENAI_API_KEY only for direct OpenAI API-key surfaces.',
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.",
      );
    }
  });

  it("falls back to a generic provider message for unsafe missing-key provider ids", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error('No API key found for provider "openai`\nrm -rf /".'),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.",
      );
    }
  });

  it("falls back to a generic reauth command when the provider in the OAuth error is unsafe", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway. Re-auth with `openclaw models auth login`, then try again.",
      );
    }
  });

  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("keeps raw generic errors on internal control surfaces", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "chat",
        Surface: "chat",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("INVALID_ARGUMENT: some other failure");
      expect(result.payload.text).toContain("Logs: openclaw logs --follow");
    }
  });

  it("restarts the active prompt when a live model switch is requested", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run(
          fallbackInvocation === 0 ? "anthropic" : "openai",
          fallbackInvocation === 0 ? "claude" : "gpt-5.4",
        ),
        provider: fallbackInvocation === 0 ? "anthropic" : "openai",
        model: fallbackInvocation++ === 0 ? "claude" : "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "switched" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
  });

  it("breaks out of the retry loop when LiveSessionModelSwitchError is thrown repeatedly (#58348)", async () => {
    // Simulate a scenario where the persisted session selection keeps conflicting
    // with the fallback model, causing LiveSessionModelSwitchError on every attempt.
    // The outer loop must be bounded to prevent a session death loop.
    let switchCallCount = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        switchCallCount++;
        return {
          result: await params.run("anthropic", "claude"),
          provider: "anthropic",
          model: "claude",
          attempts: [],
        };
      },
    );
    state.runEmbeddedPiAgentMock.mockImplementation(async () => {
      throw new LiveSessionModelSwitchError({
        provider: "openai",
        model: "gpt-5.4",
      });
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    // After MAX_LIVE_SWITCH_RETRIES (2) the loop must break instead of continuing
    // forever. The result should be a final error, not an infinite hang.
    expect(result.kind).toBe("final");
    // 1 initial + MAX_LIVE_SWITCH_RETRIES retries = exact total invocations
    expect(switchCallCount).toBe(1 + MAX_LIVE_SWITCH_RETRIES);
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        invocation++;
        if (invocation <= 2) {
          return {
            result: await params.run("anthropic", "claude"),
            provider: "anthropic",
            model: "claude",
            attempts: [],
          };
        }
        // Third invocation succeeds with the switched model
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [],
        };
      },
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-c",
          authProfileIdSource: "auto",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "finally ok" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    // Two switches (within the limit of 2) then success on third attempt
    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
  });

  it("does not roll back newer override changes after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("openai", "gpt-5.4")).rejects.toThrow("fallback failed");
        throw new Error("fallback failed");
      },
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude",
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      sessionEntry.providerOverride = "zai";
      sessionEntry.modelOverride = "glm-5";
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.providerOverride).toBe("zai");
    expect(sessionEntry.modelOverride).toBe("glm-5");
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.providerOverride).toBe("zai");
    expect(sessionStore.main.modelOverride).toBe("glm-5");
  });

  it("drops authProfileId when fallback switches providers", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai-codex", "gpt-5.4"),
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus";
    followupRun.run.authProfileId = "anthropic:openclaw";
    followupRun.run.authProfileIdSource = "user";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(state.runEmbeddedPiAgentMock, 0, "embedded run params", {
      provider: "openai-codex",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.modelOverrideSource).toBe("auto");
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionStore.main.authProfileOverride).toBeUndefined();
  });

  it("does not persist fallback selection for legacy user overrides without modelOverrideSource", async () => {
    // Regression: older persisted sessions can have a user-selected override
    // (modelOverride set) but no modelOverrideSource field, because the field
    // was added later.  These legacy entries must still be protected from
    // fallback overwrite, matching the backward-compat treatment in
    // session-reset-service.
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai-codex", "gpt-5.4"),
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-6";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      // Legacy entry: override is set but the source field is missing.
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      // modelOverrideSource intentionally absent
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    // Legacy user override must survive the fallback unchanged.
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
  });

  it("does not persist fallback selection when modelOverrideSource is user", async () => {
    // Regression: fallback persistence overwrote user-initiated /models
    // selections.  When the user explicitly picked a model, the fallback
    // should NOT clobber it even when the primary model fails.
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai-codex", "gpt-5.4"),
        provider: "openai-codex",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-6";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      // User explicitly selected this model via /models
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    // The user's /models selection must survive the fallback.
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.modelOverrideSource).toBe("user");
  });

  it("keeps same-provider auth profile when fallback only changes model", async () => {
    const applyFallbackCandidateSelectionToEntry =
      await getApplyFallbackCandidateSelectionToEntry();
    const entry = {
      sessionId: "session",
      updatedAt: 1,
      authProfileOverride: "anthropic:openclaw",
      authProfileOverrideSource: "user" as const,
    } as SessionEntry;

    const { updated } = applyFallbackCandidateSelectionToEntry({
      entry,
      run: {
        provider: "anthropic",
        model: "claude-opus",
        authProfileId: "anthropic:openclaw",
        authProfileIdSource: "user",
      } as FollowupRun["run"],
      provider: "anthropic",
      model: "claude-sonnet",
      now: 123,
    });

    expect(updated).toBe(true);
    expectRecordFields(entry as unknown as Record<string, unknown>, {
      updatedAt: 123,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus",
      authProfileOverride: "anthropic:openclaw",
      authProfileOverrideSource: "user",
    });
  });

  it("preserves original auto-fallback origin across chained fallbacks", async () => {
    const applyFallbackCandidateSelectionToEntry =
      await getApplyFallbackCandidateSelectionToEntry();
    const entry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "openrouter",
      modelOverride: "fallback-b",
      modelOverrideSource: "auto" as const,
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus",
    } as SessionEntry;

    const { updated } = applyFallbackCandidateSelectionToEntry({
      entry,
      run: {
        provider: "openrouter",
        model: "fallback-b",
      } as FollowupRun["run"],
      provider: "openrouter",
      model: "fallback-c",
      now: 123,
    });

    expect(updated).toBe(true);
    expectRecordFields(entry as unknown as Record<string, unknown>, {
      updatedAt: 123,
      providerOverride: "openrouter",
      modelOverride: "fallback-c",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus",
    });
  });
});
