import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
// E2E tests for run-reply-agent execution and generated session artifacts.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildCurrentRunRestartRecoveryClaim } from "../../agents/agent-command-restart-recovery.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../../agents/failover/user-copy.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { TypingMode } from "../../config/types.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TemplateContext } from "../templating.js";
import { resolveActiveExplicitSteerSessionKey } from "./explicit-steer-routing.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import {
  createReplyOperation,
  type ReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { consumeReplyUsageState } from "./reply-usage-state.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createMockTypingController } from "./test-helpers.js";

type AgentRunParams = {
  sessionId?: string;
  sessionFile?: string;
  onPartialReply?: (payload: { text?: string }) => Promise<boolean | void> | boolean | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoning?: boolean;
    isCommentary?: boolean;
  }) => Promise<void> | void;
  onBlockReplyFlush?: () => Promise<void>;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  silentExpected?: boolean;
  trigger?: string;
  bootstrapContextRunKind?: string;
};

const state = vi.hoisted(() => ({
  beforeAgentReplyHasHooksMock: vi.fn(),
  beforeAgentReplyRunMock: vi.fn(),
  compactEmbeddedAgentSessionMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  materializeMcpAppChannelPresentationMock: vi.fn(),
  queueEmbeddedAgentMessageMock: vi.fn(),
  activeBackendCancelMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
}));
const parkedSteer = vi.hoisted(() => {
  const admit = vi.fn(async () => "steer" as const);
  const accepted = vi.fn();
  const fallback = vi.fn();
  const consume = vi.fn();
  return {
    admit,
    accepted,
    fallback,
    consume,
    park: vi.fn(() => ({ admit, accepted, fallback, consume })),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

function requireStoredSessionEntry(storePath: string, sessionKey = "main"): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  if (!entry) {
    throw new Error(`expected stored session entry for ${sessionKey}`);
  }
  return entry;
}

async function createSessionStoreFile(entry: SessionEntry, sessionKey = "main"): Promise<string> {
  const dir = tempDirs.make("openclaw-agent-runner-");
  const storePath = join(dir, "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  return storePath;
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function makeSessionFixture<SessionKey extends string = "main">(
  overrides: Partial<SessionEntry> = {},
  sessionKey: SessionKey = "main" as SessionKey,
): Promise<{
  sessionEntry: SessionEntry;
  sessionStore: Record<SessionKey, SessionEntry>;
  storePath: string;
}> {
  const sessionEntry = makeSessionEntry(overrides);
  const sessionStore = { [sessionKey]: sessionEntry } as Record<SessionKey, SessionEntry>;
  const storePath = await createSessionStoreFile(sessionEntry, sessionKey);
  return { sessionEntry, sessionStore, storePath };
}

async function readStoredMainSession(storePath: string): Promise<SessionEntry> {
  return requireStoredSessionEntry(storePath);
}

let modelFallbackModule: typeof import("../../agents/model-fallback-runner.js");
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;

function makeCompletedFallbackRunner(
  overrides: {
    provider?: string;
    model?: string;
    attempts?: Awaited<
      ReturnType<typeof modelFallbackModule.runWithModelFallback<unknown>>
    >["attempts"];
  } = {},
) {
  const provider = overrides.provider ?? "openai";
  const model = overrides.model ?? "gpt-5.5";
  const attempts = overrides.attempts ?? [
    {
      provider: "lmstudio",
      model: "gemma-4-e4b-it",
      error: "Connection error.",
      reason: "timeout",
    },
  ];
  return async <T>(params: Parameters<typeof modelFallbackModule.runWithModelFallback<T>>[0]) => ({
    outcome: "completed" as const,
    result: await runFallbackModelAttempt(
      params,
      provider,
      model,
      attempts.at(-1)?.reason ?? "unknown",
    ),
    provider,
    model,
    attempts,
  });
}

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: TestModelFallbackRunnerParams) => ({
    outcome: "completed" as const,
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/runtime-plan/build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/runtime-plan/build.js")>()),
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: state.beforeAgentReplyHasHooksMock,
    runBeforeAgentReply: state.beforeAgentReplyRunMock,
  }),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) => state.compactEmbeddedAgentSessionMock(params),
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: (channel: unknown) => state.getChannelPluginMock(channel),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => {
  const { clearActiveEmbeddedRun, setActiveEmbeddedRun } =
    await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>();
  return {
    // Queue admission is controlled here; logical-turn registration and retirement stay real.
    clearActiveEmbeddedRun,
    setActiveEmbeddedRun,
    formatEmbeddedAgentQueueFailureSummary: () => "test queue rejection",
    queueEmbeddedAgentMessageWithOutcomeAsync: async (
      sessionId: string,
      prompt: string,
      options: unknown,
    ) => {
      const result = state.queueEmbeddedAgentMessageMock(sessionId, prompt, options);
      if (typeof result === "object") {
        return result;
      }
      return result
        ? {
            queued: true,
            sessionId,
            target: "embedded_run",
            gatewayHealth: "live",
            enqueuedAtMs: Date.now(),
          }
        : {
            queued: false,
            sessionId,
            reason: "no_active_run",
            target: "none",
            gatewayHealth: "live",
          };
    },
  };
});

vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: (params: unknown) =>
    state.materializeMcpAppChannelPresentationMock(params),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: vi.fn(),
  parkSteerCandidate: parkedSteer.park,
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  // Avoid attributing the initial agent-runner import cost to the first test case.
  modelFallbackModule = await import("../../agents/model-fallback-runner.js");
  ({ onAgentEvent } = await import("../../infra/agent-events.js"));
  await getRunReplyAgent();
});

beforeEach(() => {
  clearSessionQueues(["main"]);
  replyRunTesting.resetReplyRunRegistry();
  state.compactEmbeddedAgentSessionMock.mockReset();
  state.compactEmbeddedAgentSessionMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "test-default",
  });
  state.runEmbeddedAgentMock.mockReset();
  state.runEmbeddedAgentMock.mockResolvedValue({
    payloads: [{ text: "final" }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  });
  state.queueEmbeddedAgentMessageMock.mockReset();
  state.activeBackendCancelMock.mockReset();
  state.beforeAgentReplyHasHooksMock.mockReset().mockReturnValue(false);
  state.beforeAgentReplyRunMock.mockReset();
  state.queueEmbeddedAgentMessageMock.mockReturnValue(false);
  state.getChannelPluginMock.mockReset();
  state.materializeMcpAppChannelPresentationMock.mockReset();
  parkedSteer.admit.mockReset().mockResolvedValue("steer");
  parkedSteer.accepted.mockReset();
  parkedSteer.fallback.mockReset();
  parkedSteer.consume.mockReset();
  parkedSteer.park.mockReset();
  parkedSteer.park.mockReturnValue({
    admit: parkedSteer.admit,
    accepted: parkedSteer.accepted,
    fallback: parkedSteer.fallback,
    consume: parkedSteer.consume,
  });
  vi.mocked(enqueueFollowupRun).mockReset().mockReturnValue(true);
  vi.mocked(refreshQueuedFollowupSession).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createMinimalRun(params?: {
  opts?: InternalGetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  isRunActive?: () => boolean;
  shouldSteer?: boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
  replyOperation?: ReplyOperation;
  currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
  sessionCtx?: Partial<TemplateContext>;
  sourceTurnId?: string;
  runOverrides?: Partial<FollowupRun["run"]>;
  bindActiveAuthority?: boolean;
  attachSteerBackend?: boolean;
  activeBackendRunId?: string;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
    ...params?.sessionCtx,
  } as unknown as TemplateContext;
  const sourceTurnId =
    params?.sourceTurnId ??
    buildChannelSourceTurnId({
      provider: sessionCtx.Provider,
      accountId: sessionCtx.AccountId,
      conversationId: sessionCtx.OriginatingTo,
      messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    });
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "interrupt",
  } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
    currentInboundEventKind: params?.currentInboundEventKind,
    originatingChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
    originatingTo: sessionCtx.OriginatingTo,
    originatingChatId: sessionCtx.NativeChannelId ?? sessionCtx.ChatId,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      // Mocked reply routes already have prepared input facts; discovery has its own vision tests.
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text"] },
        { provider: "openai", id: "gpt-5.5", input: ["text"] },
        { provider: "openai", id: "gpt-5.6-sol", input: ["text"] },
        { provider: "google", id: "gemini-2.5-flash", input: ["text"] },
        { provider: "deepinfra", id: "moonshotai/Kimi-K2.5", input: ["text"] },
        { provider: "lmstudio", id: "gemma-4-e4b-it", input: ["text"] },
      ],
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
      ...params?.runOverrides,
    },
  } as unknown as FollowupRun;
  const activeOperation = replyRunRegistry.get(sessionKey);
  if (activeOperation && params?.isActive && params.bindActiveAuthority !== false) {
    activeOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
  }

  return {
    followupRun,
    sourceTurnId,
    typing,
    opts,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      const operation = replyRunRegistry.get(sessionKey);
      if (operation && params?.attachSteerBackend !== false) {
        operation.attachBackend({
          kind: "embedded",
          runId: params?.activeBackendRunId,
          cancel: state.activeBackendCancelMock,
          claimPendingUserInputAnswer: async (prompt, options) => {
            const result = (await state.queueEmbeddedAgentMessageMock(
              operation.sessionId,
              prompt,
              options,
            )) as boolean | { queued: boolean };
            return result === true || (typeof result === "object" && result.queued);
          },
          messageInjection: {
            isAvailable: () => true,
            queueMessage: async (prompt, options) => {
              const result = (await state.queueEmbeddedAgentMessageMock(
                operation.sessionId,
                prompt,
                options,
              )) as
                | boolean
                | {
                    queued: boolean;
                    reason?: string;
                    transcriptCommit?: "unconfirmed";
                    errorMessage?: string;
                  };
              if (result === false || (typeof result === "object" && !result.queued)) {
                throw new Error(typeof result === "object" ? result.reason : "queue rejected");
              }
              return typeof result === "object" && result.transcriptCommit === "unconfirmed"
                ? {
                    transcriptCommit: result.transcriptCommit,
                    errorMessage: result.errorMessage ?? "commit unconfirmed",
                  }
                : undefined;
            },
          },
        });
      }
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: params?.shouldSteer ?? false,
        shouldFollowup: params?.shouldFollowup ?? false,
        isActive: params?.isActive ?? false,
        isRunActive: params?.isRunActive,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
        replyOperation: params?.replyOperation,
      });
    },
  };
}

function requireScheduledFollowupRunner(): (run: FollowupRun) => Promise<void> {
  const scheduled = vi.mocked(scheduleFollowupDrain).mock.calls.at(-1);
  if (!scheduled) {
    throw new Error("expected a scheduled follow-up drain");
  }
  expect(scheduled[0]).toBe("main");
  return scheduled[1];
}

async function runHookBackedEmbeddedAgent(params: {
  agentId?: string;
  prompt: string;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir: string;
}) {
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: params.runId,
    trigger: params.trigger,
    event: { cleanedBody: params.prompt },
    context: {
      runId: params.runId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
      workspaceDir: params.workspaceDir,
    },
  });
  return hookResult?.handled
    ? {
        payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
        meta: { agentMeta: {} },
      }
    : {
        payloads: [{ text: "model reply" }],
        meta: { agentMeta: {} },
      };
}

function attachSourceTurnRecorder(params: {
  followupRun: FollowupRun;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sourceTurnId: string | undefined;
  storePath: string;
  text: string;
}): void {
  if (!params.sourceTurnId) {
    throw new Error("test source turn id required");
  }
  params.followupRun.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    input: { text: params.text, idempotencyKey: params.sourceTurnId },
    target: {
      agentId: "main",
      config: {},
      cwd: "/tmp",
      sessionEntry: params.sessionEntry,
      sessionId: "session",
      sessionKey: params.followupRun.run.sessionKey ?? "main",
      sessionStore: params.sessionStore,
      storePath: params.storePath,
    },
  });
}

function requireBuiltChannelSourceTurnId(
  params: Parameters<typeof buildChannelSourceTurnId>[0],
): string {
  const sourceTurnId = buildChannelSourceTurnId(params);
  if (!sourceTurnId) {
    throw new Error("test channel source turn id required");
  }
  return sourceTurnId;
}

describe("runReplyAgent active steering", () => {
  it("queues instead of steering when privilege facts differ on the active route", async () => {
    const activeRoute = { provider: "openai", model: "gpt-fallback" };
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      bindActiveAuthority: false,
    });
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.bindToolAuthoritySnapshot(
      prepareReplyToolAuthority({
        ...followupRun,
        run: {
          ...followupRun.run,
          runtimePluginToolGrant: {
            pluginId: "workboard",
            toolNames: ["workboard_complete"],
          },
        },
      }),
    );
    active.bindToolAuthorityRoute(activeRoute);
    active.setPhase("running");

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    active.complete();
  });

  it("offers a route-only mismatch to the pending-input owner", async () => {
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const activeRoute = { provider: "openai", model: "gpt-fallback" };
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      bindActiveAuthority: false,
    });
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    active.bindToolAuthorityRoute(activeRoute);
    active.setPhase("running");

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledWith(
      "session",
      "hello",
      expect.objectContaining({
        pendingInputAuthorityFingerprint: active.toolAuthorityFingerprint,
      }),
    );
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    active.complete();
  });

  it("drains an authority-mismatched turn after its provided operation clears", async () => {
    const provided = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:source",
      sessionId: "provided-session",
      resetTriggered: false,
    });
    provided.bindToolAuthoritySnapshot({
      fingerprint: () => "different-authority",
      project: () => "different-authority",
    });
    provided.setPhase("running");
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      replyOperation: provided,
      bindActiveAuthority: false,
      runOverrides: {
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text", "image"] }],
      },
    });
    const image = { type: "image" as const, data: "queued", mimeType: "image/png" };
    followupRun.images = [image];

    await expect(run()).resolves.toBeUndefined();

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    provided.complete();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledOnce();
    await requireScheduledFollowupRunner()(followupRun);
    expect(mockCallArgs(state.runEmbeddedAgentMock, "queued image drain")[0]).toMatchObject({
      images: [image],
      modelHasVision: true,
    });
  });

  it("keeps the continuing Telegram task's typing alive after an accepted steer", async () => {
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const taskTyping = createMockTypingController({ isActive: vi.fn(() => true) });
    bindReplyOperationTyping(active, taskTyping);
    const { run, typing } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        NativeChannelId: "123",
        MessageSid: "steer-telegram",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(taskTyping.startTypingLoop).toHaveBeenCalledOnce();
    expect(taskTyping.cleanup).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();

    active.complete();

    expect(taskTyping.cleanup).toHaveBeenCalledOnce();
  });

  it("injects a steer without claiming a new agent reply", async () => {
    const runState: ReplyOperationRunState = {};
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        NativeChannelId: "24680",
        MessageSid: "steer-declined",
        SenderId: "sender-42",
      },
      runOverrides: {
        agentId: "main",
        messageProvider: "discord",
        senderId: "sender-42",
      },
    });

    try {
      await expect(run()).resolves.toBeUndefined();

      expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
      expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
      expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledWith(
        "session",
        "hello",
        expect.objectContaining({ steeringMode: "all" }),
      );
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(replyRunRegistry.get("main")).toBe(active);
    } finally {
      active.complete();
    }
  });

  it("does not let before_agent_reply claim an accepted steer", async () => {
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue({
      handled: true,
      reply: { text: "claimed steer" },
    });
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const { run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "steer-claimed",
      },
      runOverrides: { agentId: "main", messageProvider: "discord" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(active.phase).toBe("running");
    expect(active.result).toBeNull();
    active.complete();
  });

  it("replays a declined steer without dispatching its hook twice", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(false);
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "steer-fallback",
      },
      runOverrides: { agentId: "main", messageProvider: "discord" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    active.complete();
    await requireScheduledFollowupRunner()(followupRun);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
  });

  it("runs one normal fallback after Gateway rejects injection", async () => {
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { run } = createMinimalRun({
      opts: { messageInjectionDisposition: "rejected" },
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "steer-pre-attempted",
      },
      runOverrides: { agentId: "main", messageProvider: "discord" },
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "model reply" }));

    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("does not steer, enqueue, or start a second run after accepted Gateway injection", async () => {
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: {
        messageInjectionDisposition: "accepted",
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("falls back visibly when the active CLI backend cannot accept injection", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    active.attachBackend({ kind: "cli", cancel: vi.fn() });
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run } = createMinimalRun({
      attachSteerBackend: false,
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    active.complete();
    await requireScheduledFollowupRunner()(followupRun);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("durably records an adopted steer once with the active run id for transcript projection", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "use the monochrome version instead",
        idempotencyKey: "matrix:$explicit-steer",
        sender: { id: "user-42", name: "Ada" },
      },
      target: {
        agentId: "main",
        cwd: "/tmp",
        sessionEntry,
        sessionId: "session",
        sessionKey: "main",
        sessionStore,
        storePath,
      },
    });
    const events: string[] = [];
    state.queueEmbeddedAgentMessageMock.mockImplementationOnce(
      async (_sessionId: string, _prompt: string, options: unknown) => {
        expect(requireRecord(options, "embedded queue options")).toMatchObject({
          steeringMode: "all",
          isInboundUserMessage: true,
          waitForTranscriptCommit: true,
          queueIdentity: expect.any(String),
          userTurnTranscriptRecorder: recorder,
        });
        events.push("transcript-committed");
        await recorder.persistApproved();
        return true;
      },
    );
    const onAdopted = vi.fn(() => {
      events.push("adopted");
    });
    const { followupRun, run } = createMinimalRun({
      activeBackendRunId: "active-run",
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      storePath,
      opts: { turnAdoptionLifecycle: { onAdopted } },
    });
    followupRun.prompt = "use the monochrome version instead";
    followupRun.userTurnTranscriptRecorder = recorder;

    await expect(run()).resolves.toBeUndefined();

    expect(events).toEqual(["transcript-committed", "adopted"]);
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    const transcript = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "session",
      sessionKey: "main",
      storePath,
    });
    const projectedUserRows = transcript.filter(
      (entry): entry is { message: Record<string, unknown> } => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return false;
        }
        const message = (entry as { message?: unknown }).message;
        return Boolean(
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { role?: unknown }).role === "user" &&
          (message as { content?: unknown }).content === followupRun.prompt,
        );
      },
    );
    expect(projectedUserRows).toHaveLength(1);
    expect(projectedUserRows[0]?.message).toMatchObject({
      __openclaw: {
        senderId: "user-42",
        senderName: "Ada",
        steerTargetRunId: "active-run",
      },
    });
    expect(recorder.getPersistedMessage?.()).toMatchObject({
      __openclaw: { steerTargetRunId: "active-run" },
    });
    active.complete();
  });

  it("falls back once when the pre-resolved steer owner disappears before queue admission", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    active.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: vi.fn() },
    });
    const commandCtx = {
      CommandAuthorized: true,
      CommandBody: "/steer finish with a table",
      CommandSource: "text" as const,
      CommandTurn: {
        kind: "text-slash" as const,
        source: "text" as const,
        authorized: true,
        commandName: "steer",
        body: "/steer finish with a table",
      },
      SessionKey: "main",
    };
    expect(
      resolveActiveExplicitSteerSessionKey({ cfg: {}, ctx: commandCtx, sessionKey: "main" }),
    ).toBe("main");

    active.complete();
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });
    followupRun.prompt = "finish with a table";

    await expect(run()).resolves.toBeUndefined();

    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    await requireScheduledFollowupRunner()(followupRun);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("steers against the session's registered run owner, not a source-keyed reservation", async () => {
    // A native command continuation whose target-slot adoption was skipped
    // (#104844) still carries its slash-source reservation; steering must
    // target the operation that owns this session's run slot.
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const targetOwner = createReplyOperation({
      sessionKey: "main",
      sessionId: "target-active-session",
      resetTriggered: false,
    });
    targetOwner.setPhase("running");
    const sourceReservation = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:steer-user",
      sessionId: "source-reservation-session",
      resetTriggered: false,
    });
    const { run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      replyOperation: sourceReservation,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledWith(
      "target-active-session",
      "hello",
      expect.objectContaining({ steeringMode: "all" }),
    );

    targetOwner.complete();
    sourceReservation.complete();
  });

  it("waits for transcript commit and keeps a rejected adoption finalizer irrevocably adopted", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const finalizerError = new Error("dedupe finalizer failed");
    const events: string[] = [];
    state.queueEmbeddedAgentMessageMock.mockImplementationOnce(
      (_sessionId: string, _prompt: string, options: unknown) => {
        expect(requireRecord(options, "embedded queue options")).toMatchObject({
          steeringMode: "all",
          waitForTranscriptCommit: true,
        });
        events.push("transcript-committed");
        return true;
      },
    );
    const onAdopted = vi.fn(async () => {
      events.push("adoption-finalizer");
      throw finalizerError;
    });
    const { run, typing } = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(events).toEqual(["transcript-committed", "adoption-finalizer"]);
    expect(onAdopted).toHaveBeenCalledTimes(1);
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    active.complete();
    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    "no_active_run",
    "not_streaming",
    "stale_run",
    "compacting",
    "image_input_unsupported",
    "source_reply_delivery_mode_mismatch",
    "task_suggestion_delivery_mode_mismatch",
    "transcript_commit_wait_unsupported",
    "runtime_rejected",
  ] as const)("queues a follow-up when active steering fails with %s", async (reason) => {
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce({
      queued: false,
      sessionId: "session",
      reason,
      gatewayHealth: "live",
    });
    const onAdopted = vi.fn();
    const onBlockReply = vi.fn();
    const { run } = createMinimalRun({
      opts: { onBlockReply, turnAdoptionLifecycle: { onAdopted } },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalled();
    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onAdopted).not.toHaveBeenCalled();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
  });

  it("adopts and consumes non-handoff unconfirmed steering without replay", async () => {
    const runState: ReplyOperationRunState = {};
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce({
      queued: true,
      sessionId: "session",
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage: "receipt unavailable",
    });
    const onAdopted = vi.fn();
    const { run, typing } = createMinimalRun({
      opts: {
        [REPLY_OPERATION_RUN_STATE]: runState,
        turnAdoptionLifecycle: { onAdopted },
      },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(state.activeBackendCancelMock).toHaveBeenCalledOnce();
    expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(runState.messageInjectionAborted).toBe(true);
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    active.complete();
  });

  it("unconfirmed steer commit aborts only the captured operation, never a same-key successor", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session-a",
      resetTriggered: false,
    });
    active.setPhase("running");
    const activeAbortByUser = vi.spyOn(active, "abortByUser");
    let successor: ReplyOperation | undefined;
    let successorAbortByUser: MockInstance<ReplyOperation["abortByUser"]> | undefined;
    state.queueEmbeddedAgentMessageMock.mockImplementationOnce(() => {
      active.complete();
      successor = createReplyOperation({
        sessionKey: "main",
        sessionId: "session-b",
        resetTriggered: false,
      });
      successor.setPhase("running");
      successorAbortByUser = vi.spyOn(successor, "abortByUser");
      return {
        queued: true,
        sessionId: "session-a",
        target: "embedded_run",
        gatewayHealth: "live",
        transcriptCommit: "unconfirmed",
        errorMessage: "receipt unavailable",
      };
    });
    const { run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();
    if (!successor || !successorAbortByUser) {
      throw new Error("expected same-key successor operation");
    }
    try {
      expect(successorAbortByUser).not.toHaveBeenCalled();
      expect(activeAbortByUser).toHaveBeenCalledOnce();
    } finally {
      successor.complete();
    }
  });

  it("admits an ordinary rejected steering turn with durable recovery state", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const onAdopted = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(
        (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
      ).toBeUndefined();
      return {
        payloads: [{ text: "final" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "rejected-steering-message",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "steering rejected before admission",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    await requireScheduledFollowupRunner()(followupRun);
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });
});

describe("runReplyAgent MCP App channel action", () => {
  it("materializes the latest view on the final channel payload", async () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Weather app",
              action: {
                type: "web-app",
                url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
              },
            },
          ],
        },
      ],
    };
    state.materializeMcpAppChannelPresentationMock.mockReturnValue(presentation);
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "The forecast is sunny." }, { text: "NO_REPLY" }],
      latestMcpAppChannelView: { viewId: "view-latest" },
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });
    const { run } = createMinimalRun({
      sessionCtx: { Provider: "telegram", OriginatingChannel: "telegram" },
      runOverrides: { messageProvider: "telegram" },
    });

    await expect(run()).resolves.toEqual(
      expect.objectContaining({ text: "The forecast is sunny.", presentation }),
    );
    expect(state.materializeMcpAppChannelPresentationMock).toHaveBeenCalledWith({
      sessionKey: "main",
      view: { viewId: "view-latest" },
    });
  });
});

describe("runReplyAgent heartbeat followup guard", () => {
  it("drops heartbeat runs when reply-lane admission finds an active owner", async () => {
    const runState: ReplyOperationRunState = {};
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: false,
      shouldFollowup: false,
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "active-run" });
    active.complete();
  });

  it("records the operation owned by an admitted heartbeat run", async () => {
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { isHeartbeat: true, [REPLY_OPERATION_RUN_STATE]: runState },
    });

    await run();

    expect(runState.admission).toEqual({ status: "owned" });
    expect(resolveReplyOperationAgentTurn(runState)).toBe("ok");
  });

  it("records a failed heartbeat turn when a visible reply replaces its synthetic failure", async () => {
    const runState: ReplyOperationRunState = {};
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible terminal failure." }],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run failed after producing a visible reply.",
        },
      },
    });
    const { run } = createMinimalRun({
      opts: { isHeartbeat: true, [REPLY_OPERATION_RUN_STATE]: runState },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];

    expect(payloads.map((payload) => payload?.text)).toEqual(["Visible terminal failure."]);
    expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
  });

  it("runs visible turns with the session id returned by admission", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    const sessionStore = {
      main: {
        sessionId: "pre-compact-session",
        sessionFile: "main",
        updatedAt: Date.now(),
      },
    };
    const { run } = createMinimalRun({
      runOverrides: { sessionId: "stale-session" },
      sessionStore,
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 1, output: 1 },
        },
      },
    });

    const pending = run();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    active.updateSessionId("post-compact-session");
    sessionStore.main = {
      sessionId: "post-compact-session",
      sessionFile: "main",
      updatedAt: Date.now(),
    };
    active.complete();
    await pending;

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const [call] = mockCallArgs(state.runEmbeddedAgentMock, "run embedded agent");
    expect((call as AgentRunParams).sessionId).toBe("post-compact-session");
    expect((call as AgentRunParams).sessionFile).toBe("main");
  });

  it("drops runs when reply-lane admission sees an already-aborted caller", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const runState: ReplyOperationRunState = {};
    const { run, typing } = createMinimalRun({
      opts: {
        abortSignal: abortController.signal,
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      isActive: false,
      shouldFollowup: false,
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "aborted" });
  });

  it("drops heartbeat runs when another run is active", async () => {
    const runState: ReplyOperationRunState = {};
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "active-run" });
  });

  it("drops heartbeat runs before steering active streams", async () => {
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("still enqueues non-heartbeat runs when another run is active", async () => {
    const { run } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("defers hooks until an active run's follow-up is admitted", async () => {
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    const { run } = createMinimalRun({
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("records queue-cap rejection while cleaning up typing", async () => {
    vi.mocked(enqueueFollowupRun).mockImplementationOnce((...args) => {
      args[1].onQueueDisposition?.("queue-cap-new");
      return false;
    });
    const runState: ReplyOperationRunState = {};
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "queue-cap" });
  });

  it("keeps typing alive when a followup is queued behind a live active run", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.cleanup).not.toHaveBeenCalled();
    active.complete();
  });

  it("starts draining after enqueue when the reply lane owner is already gone", async () => {
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps the drain dormant until the reply lane owner clears", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const { run } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    await run();

    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();

    active.complete();

    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
  });

  it("drains followup queue when an unexpected exception escapes the run path", async () => {
    const accounting = await import("./session-usage.js");
    const persistSpy = vi
      .spyOn(accounting, "persistSessionUsageUpdate")
      .mockRejectedValueOnce(new Error("persist exploded"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    try {
      const runState: ReplyOperationRunState = {};
      const { run } = createMinimalRun({
        opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      });
      await expect(run()).rejects.toThrow("persist exploded");
      expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
      expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    } finally {
      persistSpy.mockRestore();
    }
  });

  it.each([
    { label: "legacy void in a direct chat", callbackResult: undefined, sessionCtx: {} },
    { label: "explicit acceptance in a direct chat", callbackResult: true, sessionCtx: {} },
    { label: "explicit rejection in a direct chat", callbackResult: false, sessionCtx: {} },
    {
      label: "legacy void in a group chat",
      callbackResult: undefined,
      sessionCtx: {
        ChatType: "group" as const,
        SessionKey: "agent:test:telegram:group:-100123",
      },
    },
  ])(
    "preserves $label through terminal failure with block streaming disabled",
    async ({ callbackResult, sessionCtx }) => {
      const accounting = await import("./session-usage.js");
      const persistSpy = vi
        .spyOn(accounting, "persistSessionUsageUpdate")
        .mockRejectedValueOnce(new Error("persist exploded"));
      const onPartialReply = vi.fn(async () => callbackResult);
      let observedCallbackResult: boolean | void = undefined;
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        observedCallbackResult = await params.onPartialReply?.({ text: "partial answer" });
        return {
          payloads: [{ text: "final answer" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      try {
        const { run } = createMinimalRun({
          blockStreamingEnabled: false,
          opts: { onPartialReply, preserveProgressCallbackStartOrder: true },
          sessionCtx,
        });
        if (callbackResult === false) {
          await expect(run()).rejects.toThrow("persist exploded");
        } else {
          const result = await run();
          const payload = Array.isArray(result) ? result[0] : result;
          expect(payload).toMatchObject({
            text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
            isError: true,
          });
        }
        expect(onPartialReply).toHaveBeenCalledWith({
          text: "partial answer",
          mediaUrls: undefined,
        });
        expect(observedCallbackResult).toBe(callbackResult);
      } finally {
        persistSpy.mockRestore();
      }
    },
  );

  it.each([true, undefined, false])(
    "reports provider failure after a group partial with visibility %s",
    async (callbackResult) => {
      const onPartialReply = vi.fn(async () => callbackResult);
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onPartialReply?.({ text: "partial answer" });
        throw new Error("model stream failed");
      });
      const { run } = createMinimalRun({
        blockStreamingEnabled: false,
        opts: { onPartialReply, preserveProgressCallbackStartOrder: true },
        sessionCtx: {
          ChatType: "group",
          SessionKey: "agent:test:telegram:group:-100123",
        },
      });

      const result = await run();
      const payload = Array.isArray(result) ? result[0] : result;

      expect(payload).toMatchObject({
        text: callbackResult === false ? "NO_REPLY" : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        ...(callbackResult === false ? {} : { isError: true }),
      });
      expect(onPartialReply).toHaveBeenCalledOnce();
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { label: "accepted answer", payload: { text: "answer block" }, delivered: true },
    { label: "in-flight answer", payload: { text: "answer block" }, delivered: true },
    { label: "queued answer", payload: { text: "answer block" }, delivered: true },
    { label: "aborted answer", payload: { text: "answer block" }, delivered: false },
    {
      label: "reasoning",
      payload: { text: "internal reasoning", isReasoning: true },
      delivered: false,
    },
    {
      label: "commentary",
      payload: { text: "working on it", isCommentary: true },
      delivered: false,
    },
    { label: "rejected answer", payload: { text: "answer block" }, delivered: false },
  ])(
    "reports provider failure after $label block delivery",
    async ({ label, payload, delivered }) => {
      const replyOperation =
        label === "aborted answer"
          ? createReplyOperation({
              sessionKey: "main",
              sessionId: "session",
              resetTriggered: false,
            })
          : undefined;
      const deliveryStarted = createDeferred();
      let blockFlush: Promise<void> | undefined;
      const onBlockReply = vi.fn(async () => {
        deliveryStarted.resolve();
        if (label === "in-flight answer" || replyOperation) {
          await setImmediate();
          replyOperation?.abortByUser();
        }
        if (label === "rejected answer") {
          throw new Error("transport rejected the block");
        }
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onBlockReply?.(payload);
        blockFlush = label === "queued answer" ? undefined : params.onBlockReplyFlush?.();
        if (label !== "queued answer") {
          await deliveryStarted.promise;
        }
        if (label !== "in-flight answer" && label !== "queued answer" && !replyOperation) {
          await blockFlush;
        }
        throw new Error("model stream failed after block delivery");
      });
      const { run } = createMinimalRun({
        replyOperation,
        blockStreamingEnabled: true,
        opts: { onBlockReply, reasoningPayloadsEnabled: true, commentaryPayloadsEnabled: true },
        sessionCtx: { ChatType: "group" },
      });

      const result = await run();
      await blockFlush;
      const reply = Array.isArray(result) ? result[0] : result;

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(reply).toMatchObject({
        text: delivered ? GENERIC_EXTERNAL_RUN_FAILURE_TEXT : "NO_REPLY",
        ...(delivered ? { isError: true } : {}),
      });
    },
  );

  it("rethrows after a delivered partial without visible content", async () => {
    const accounting = await import("./session-usage.js");
    const persistSpy = vi
      .spyOn(accounting, "persistSessionUsageUpdate")
      .mockRejectedValueOnce(new Error("persist exploded"));
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "   " });
      return {
        payloads: [{ text: "final answer" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    try {
      const { run } = createMinimalRun({
        blockStreamingEnabled: false,
        opts: { onPartialReply },
      });

      await expect(run()).rejects.toThrow("persist exploded");
    } finally {
      persistSpy.mockRestore();
    }
  });

  it("rethrows heartbeat failures after a delivered partial", async () => {
    const accounting = await import("./session-usage.js");
    const persistSpy = vi
      .spyOn(accounting, "persistSessionUsageUpdate")
      .mockRejectedValueOnce(new Error("persist exploded"));
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "heartbeat detail" });
      return {
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    try {
      const { run } = createMinimalRun({
        blockStreamingEnabled: false,
        opts: { isHeartbeat: true, onPartialReply },
      });

      await expect(run()).rejects.toThrow("persist exploded");
    } finally {
      persistSpy.mockRestore();
    }
  });

  it("keeps user aborts silent after a delivered partial", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "partial answer" });
      replyOperation.abortByUser();
      throw new Error("run stopped");
    });

    const { run } = createMinimalRun({
      blockStreamingEnabled: false,
      opts: { onPartialReply },
      replyOperation,
    });
    const result = await run();

    expect(result).toEqual({ text: "NO_REPLY" });
  });

  it.each(["reasoning", "commentary"] as const)(
    "rethrows after %s-only block streaming",
    async (lane) => {
      const accounting = await import("./session-usage.js");
      const persistSpy = vi
        .spyOn(accounting, "persistSessionUsageUpdate")
        .mockRejectedValueOnce(new Error("persist exploded"));
      const onBlockReply = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onBlockReply?.({
          text: `internal ${lane}`,
          ...(lane === "reasoning" ? { isReasoning: true } : { isCommentary: true }),
        });
        return {
          payloads: [{ text: "final answer" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      try {
        const { run } = createMinimalRun({
          blockStreamingEnabled: true,
          opts: {
            onBlockReply,
            reasoningPayloadsEnabled: lane === "reasoning",
            commentaryPayloadsEnabled: lane === "commentary",
          },
        });

        await expect(run()).rejects.toThrow("persist exploded");
        expect(onBlockReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: `internal ${lane}` }),
          expect.any(Object),
        );
      } finally {
        persistSpy.mockRestore();
      }
    },
  );
});

describe("runReplyAgent pending final delivery capture", () => {
  it("delivers an authenticated channel reply through the configured default agent", async () => {
    const config = {
      agents: {
        list: [{ id: "ops", default: true }, { id: "worker" }],
        defaults: { compaction: { memoryFlush: {} } },
      },
    };
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };
    const storePath = join(
      tempDirs.make("openclaw-custom-default-agent-"),
      "agents",
      "ops",
      "sessions",
      "sessions.json",
    );
    await replaceSessionEntry(
      { agentId: "ops", defaultAgentId: "ops", sessionKey: "main", storePath },
      sessionEntry,
    );
    const sessionCtx = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "custom-default-source-message",
      SenderId: "sender-42",
      SenderName: "Ada",
    } as const;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "custom default agent reply" }],
      meta: {},
    });
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx,
      runOverrides: {
        agentId: undefined,
        config,
        messageProvider: "discord",
      },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    if (!sourceTurnId) {
      throw new Error("test channel source turn id required");
    }
    followupRun.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: {
        text: "custom default agent request",
        idempotencyKey: sourceTurnId,
        sender: { id: "sender-42", name: "Ada" },
      },
      target: {
        agentId: "ops",
        config,
        cwd: "/tmp",
        sessionEntry,
        sessionId: "session",
        sessionKey: "main",
        sessionStore,
        storePath,
      },
    });

    setRuntimeConfigSnapshot(config, config);
    try {
      await expect(run()).resolves.toEqual(
        expect.objectContaining({ text: "custom default agent reply" }),
      );

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(
        await loadTranscriptEvents({
          agentId: "ops",
          sessionId: "session",
          sessionKey: "main",
          storePath,
        }),
      ).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: "custom default agent request",
          }),
        }),
      );
      expect(await readStoredMainSession(storePath)).toMatchObject({
        pendingFinalDelivery: {
          kind: "replayable",
          text: "custom default agent reply",
          context: { channel: "discord", to: "channel:24680" },
        },
        restartRecoveryTerminalRunIds: [sourceTurnId],
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not persist message-tool-only final replies for heartbeat replay", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "private final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
  });

  it("does not persist sendPolicy-denied final replies for heartbeat replay", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      sendPolicy: "deny",
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "denied final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
  });

  it("persists only visible non-reasoning final reply text", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hidden reasoning", isReasoning: true }, { text: "visible final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    const result = await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "visible final",
      intentId: expect.any(String),
      deliveries: [{ id: expect.any(String), state: "prepared" }],
    });
    const visiblePayload = (Array.isArray(result) ? result : [result]).find(
      (payload) => payload?.text === "visible final",
    );
    expect(getReplyPayloadMetadata(visiblePayload ?? {})).toMatchObject({
      pendingFinalDeliveryCompletion: {
        deliveryId: stored.pendingFinalDelivery?.deliveries?.[0]?.id,
        intentId: stored.pendingFinalDelivery?.intentId,
        sessionId: "session",
        sessionKey: "main",
        storePath,
      },
    });
  });

  it("owns a media-only final with its complete replay directive", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ mediaUrl: "https://example.test/final.png" }],
      meta: {},
    });
    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    const result = await run();
    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "MEDIA:https://example.test/final.png",
      intentId: expect.any(String),
      deliveries: [{ id: expect.any(String), state: "prepared" }],
    });
    const payload = Array.isArray(result) ? result[0] : result;
    expect(getReplyPayloadMetadata(payload ?? {})).toMatchObject({
      pendingFinalDeliveryCompletion: {
        deliveryId: stored.pendingFinalDelivery?.deliveries?.[0]?.id,
        intentId: stored.pendingFinalDelivery?.intentId,
      },
    });
  });

  it("owns mixed text and media finals without replaying a partial aggregate", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "visible text" }, { mediaUrl: "https://example.test/final.png" }],
      meta: {},
    });
    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];
    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "transport-only",
      deliveries: [
        { id: expect.any(String), state: "prepared" },
        { id: expect.any(String), state: "prepared" },
      ],
    });
    expect(stored.pendingFinalDelivery).not.toHaveProperty("text");
    expect(
      payloads.map(
        (payload) =>
          getReplyPayloadMetadata(payload ?? {})?.pendingFinalDeliveryCompletion?.deliveryId,
      ),
    ).toEqual(stored.pendingFinalDelivery?.deliveries?.map(({ id }) => id));
  });

  it("persists canonical SQLite pending final delivery after its intent commits", async () => {
    const sessionKey = "agent:main:main";
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({}, sessionKey);
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "visible canonical final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    const result = await run();
    const stored = loadSessionEntry({ sessionKey, storePath });
    expect(stored).toMatchObject({
      pendingFinalDelivery: {
        kind: "replayable",
        intentId: expect.any(String),
        text: "visible canonical final",
        deliveries: [{ id: expect.any(String), state: "prepared" }],
      },
      sessionId: "session",
    });
    const visiblePayload = Array.isArray(result) ? result[0] : result;
    expect(getReplyPayloadMetadata(visiblePayload ?? {})).toMatchObject({
      pendingFinalDeliveryCompletion: {
        deliveryId: stored?.pendingFinalDelivery?.deliveries?.[0]?.id,
        intentId: stored?.pendingFinalDelivery?.intentId,
        sessionId: "session",
        sessionKey,
        storePath,
      },
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("rejects canonical SQLite pending final delivery when its session is deleted", async () => {
    const sessionKey = "agent:main:main";
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({}, sessionKey);
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const operation = replyRunRegistry.get(sessionKey);
      if (!operation) {
        throw new Error("expected admitted reply operation");
      }
      // Match the dispatcher's initiating context so the injected deletion reaches
      // final-delivery persistence instead of the competing-work guard.
      await runWithReplyOperationLifecycleAdmission(operation, () =>
        applySessionEntryLifecycleMutation({
          removals: [{ sessionKey }],
          skipMaintenance: true,
          storePath,
        }),
      );
      return {
        payloads: [{ text: "final from deleted session" }],
        meta: {},
      };
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(run()).rejects.toThrow("pending final delivery session changed or was deleted");
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("does not persist canonical SQLite pending final delivery on a reset session", async () => {
    const sessionKey = "agent:main:main";
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({}, sessionKey);
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "session-after-reset", updatedAt: Date.now() },
      );
      return {
        payloads: [{ text: "final from previous session" }],
        meta: {},
      };
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(run()).rejects.toThrow("pending final delivery session changed or was deleted");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-after-reset",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toBeUndefined();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("persists auto-reply delivery context for restart recovery", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      accountId: "work",
      conversationId: "channel:24680",
      messageId: "1503645939964055592",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const storedDuringRun = await readStoredMainSession(storePath);
      expect(storedDuringRun.restartRecoveryDeliveryContext).toEqual({
        channel: "discord",
        to: "channel:24680",
        accountId: "work",
        threadId: "1503645939964055592",
      });
      expect(typeof storedDuringRun.restartRecoveryDeliveryRunId).toBe("string");
      return {
        payloads: [{ text: "visible final" }],
        meta: {},
      };
    });

    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        AccountId: "work",
        MessageSid: "1503645939964055592",
        MessageThreadId: "1503645939964055592",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "durable discord request",
    });
    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "visible final",
      context: {
        channel: "discord",
        to: "channel:24680",
        accountId: "work",
        threadId: "1503645939964055592",
      },
    });
    expect(stored.restartRecoverySourceIngress).toBe("channel");
    expect(stored.restartRecoveryDeliveryContext).toBeUndefined();
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("recovers a scoped Telegram topic and admits the next inbound turn", async () => {
    const sessionKey = "agent:main:main:thread:1234:42";
    const deliveryContext = {
      channel: "telegram",
      to: "telegram:1234",
      accountId: "work",
      threadId: 42,
    };
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture(
      {
        delivery: normalizeSessionDeliveryState({
          context: { ...deliveryContext, threadId: "42" },
        }),
      },
      sessionKey,
    );
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const claimed = requireStoredSessionEntry(storePath, sessionKey);
      expect(claimed.restartRecoveryDeliveryContext).toEqual(deliveryContext);
      expect(typeof claimed.restartRecoveryDeliveryRunId).toBe("string");
      expect(
        buildCurrentRunRestartRecoveryClaim({
          entry: claimed,
          runId: claimed.restartRecoveryDeliveryRunId ?? "missing-recovery-run",
          deliveryContext: { ...deliveryContext, threadId: "42" },
        }),
      ).toMatchObject({ restartRecoveryDeliveryContext: deliveryContext });
      return { payloads: [{ text: "recovered topic reply" }], meta: {} };
    });

    const topicContext = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: deliveryContext.to,
      AccountId: deliveryContext.accountId,
      MessageThreadId: deliveryContext.threadId,
      TransportThreadId: deliveryContext.threadId,
      SessionKey: sessionKey,
    } as const;
    const interrupted = createMinimalRun({
      sessionCtx: { ...topicContext, MessageSid: "telegram-topic-message-1" },
      runOverrides: { messageProvider: "telegram" },
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: interrupted.followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId: interrupted.sourceTurnId,
      storePath,
      text: "recover this private topic",
    });

    await expect(interrupted.run()).resolves.toEqual(
      expect.objectContaining({ text: "recovered topic reply" }),
    );

    const completed = requireStoredSessionEntry(storePath, sessionKey);
    expect(completed.restartRecoveryDeliveryRunId).toBeUndefined();
    const nextStore = { [sessionKey]: completed };
    const followup = createMinimalRun({
      sessionCtx: { ...topicContext, MessageSid: "telegram-topic-message-2" },
      runOverrides: { messageProvider: "telegram" },
      sessionEntry: completed,
      sessionStore: nextStore,
      sessionKey,
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: followup.followupRun,
      sessionEntry: completed,
      sessionStore: nextStore,
      sourceTurnId: followup.sourceTurnId,
      storePath,
      text: "accept the next private-topic message",
    });

    await expect(followup.run()).resolves.toEqual(expect.objectContaining({ text: "final" }));
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(requireStoredSessionEntry(storePath, sessionKey).restartRecoveryDeliveryRunId).toBe(
      undefined,
    );
  });

  it("fails closed and retires an unknown terminal receipt when the live run returns", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "discord-message-unknown",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const current = await readStoredMainSession(storePath);
      await replaceSessionEntry(
        { storePath, sessionKey: "main" },
        {
          ...current,
          restartRecoveryDeliveryReceiptState: "terminal-pending",
          restartRecoveryDeliveryToolCallId: "message-call-unknown",
          updatedAt: Date.now(),
        },
      );
      return {
        payloads: [{ text: "fallback final" }],
        meta: {},
      };
    });

    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-unknown",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "maybe send a terminal reply",
    });
    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await run();

    expect(await readStoredMainSession(storePath)).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      restartRecoveryTerminalRunIds: [expectedSourceTurnId],
    });
    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
    expect(stored.restartRecoveryDeliveryReceiptState).toBeUndefined();
    expect(stored.restartRecoveryDeliveryToolCallId).toBeUndefined();
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });

  it("rejects channel recovery admission without a source-keyed user turn", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const { run } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-without-recorder",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await expect(run()).rejects.toThrow(
      "channel restart recovery requires source-keyed user-turn admission",
    );

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(await readStoredMainSession(storePath)).not.toMatchObject({
      restartRecoveryDeliveryRunId: expect.any(String),
    });
  });

  it("does not arm channel recovery without a source turn id", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect((await readStoredMainSession(storePath)).restartRecoveryDeliveryRunId).toBeUndefined();
      return { payloads: [{ text: "visible final" }], meta: {} };
    });
    const { run } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-without-source-id",
      },
      sourceTurnId: "",
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "visible final" }));
    expect((await readStoredMainSession(storePath)).restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("drops a redelivered terminal channel source before hooks or model work", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const sessionCtx = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "redelivered-terminal-message",
    } as const;
    const first = createMinimalRun({
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: first.followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId: first.sourceTurnId,
      storePath,
      text: "execute once",
    });

    await first.run();

    const completedEntry = await readStoredMainSession(storePath);
    expect(completedEntry.restartRecoveryTerminalRunIds).toEqual([first.sourceTurnId]);
    state.runEmbeddedAgentMock.mockClear();
    const onAdopted = vi.fn();
    const completedStore = { main: completedEntry };
    const duplicate = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry: completedEntry,
      sessionStore: completedStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: duplicate.followupRun,
      sessionEntry: completedEntry,
      sessionStore: completedStore,
      sourceTurnId: duplicate.sourceTurnId,
      storePath,
      text: "execute once",
    });

    await expect(duplicate.run()).resolves.toBeUndefined();

    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect((await readStoredMainSession(storePath)).restartRecoveryTerminalRunIds).toEqual([
      first.sourceTurnId,
    ]);
  });

  it("drops a redelivered active channel source before hooks or queue work", async () => {
    const sessionCtx = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "redelivered-active-message",
    } as const;
    const sourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "redelivered-active-message",
    });
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      status: "running",
      restartRecoveryDeliveryRunId: "active-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:24680",
      },
    });
    const onAdopted = vi.fn();
    const duplicate = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: duplicate.followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId: duplicate.sourceTurnId,
      storePath,
      text: "execute once",
    });

    await expect(duplicate.run()).resolves.toBeUndefined();

    expect(duplicate.sourceTurnId).toBe(sourceTurnId);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      status: "running",
      restartRecoveryDeliveryRunId: "active-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    });
  });

  it("tombstones a redelivered source whose recovery claim is already terminal", async () => {
    const sessionCtx = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "redelivered-terminal-message",
    } as const;
    const sourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "redelivered-terminal-message",
    });
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      status: "done",
      restartRecoveryDeliveryRunId: "terminal-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:24680",
      },
    });
    const onAdopted = vi.fn();
    const duplicate = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await expect(duplicate.run()).resolves.toBeUndefined();

    expect(duplicate.sourceTurnId).toBe(sourceTurnId);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    const stored = await readStoredMainSession(storePath);
    expect(stored).toMatchObject({
      status: "done",
      restartRecoveryTerminalRunIds: [sourceTurnId],
    });
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });

  it("atomically replaces a terminal stale recovery claim for the next run", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: false,
      restartRecoveryDeliveryContext: {
        channel: "webchat",
        to: "stale-client",
      },
      restartRecoveryDeliveryRunId: "stale-run",
      restartRecoveryDeliverySourceRunId: "stale-control-ui-run",
      status: "done",
    });
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      accountId: "work",
      conversationId: "channel:24680",
      messageId: "1503645939964055592",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const storedDuringRun = await readStoredMainSession(storePath);
      expect(storedDuringRun.restartRecoveryDeliveryContext).toEqual({
        channel: "discord",
        to: "channel:24680",
        accountId: "work",
        threadId: "1503645939964055592",
      });
      expect(storedDuringRun.restartRecoveryDeliveryRunId).not.toBe("stale-run");
      expect(storedDuringRun.restartRecoveryDeliveryRunId).toEqual(expect.any(String));
      expect(storedDuringRun.restartRecoveryDeliverySourceRunId).toBe(expectedSourceTurnId);
      expect(storedDuringRun.restartRecoveryTerminalRunIds).toEqual(["stale-control-ui-run"]);
      return {
        payloads: [{ text: "visible final" }],
        meta: {},
      };
    });

    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        AccountId: "work",
        MessageSid: "1503645939964055592",
        MessageThreadId: "1503645939964055592",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "next durable discord request",
    });
    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.restartRecoveryDeliveryContext).toBeUndefined();
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored.restartRecoveryTerminalRunIds).toEqual([
      "stale-control-ui-run",
      expectedSourceTurnId,
    ]);
  });

  it("admits the next channel turn after a failed recovery became terminal", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: true,
      restartRecoveryTerminalRunIds: ["failed-source-turn"],
      status: "failed",
    });
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      accountId: "work",
      conversationId: "channel:24680",
      messageId: "1503645939964055593",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(await readStoredMainSession(storePath)).toMatchObject({
        abortedLastRun: false,
        restartRecoveryDeliverySourceRunId: expectedSourceTurnId,
        restartRecoveryTerminalRunIds: ["failed-source-turn"],
        status: "running",
      });
      return {
        payloads: [{ text: "visible final" }],
        meta: {},
      };
    });

    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        AccountId: "work",
        MessageSid: "1503645939964055593",
        MessageThreadId: "1503645939964055593",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "request after failed recovery",
    });

    await run();

    expect(sourceTurnId).toBe(expectedSourceTurnId);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["failed-source-turn", expectedSourceTurnId],
    });
  });

  it("migrates a legacy transcript-only claim before preserving its pending final", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: false,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const storedDuringRun = await readStoredMainSession(storePath);
      expect(storedDuringRun.restartRecoveryBeforeAgentReplyState).toBeUndefined();
      expect(storedDuringRun.restartRecoveryDeliveryContext).toBeUndefined();
      expect(storedDuringRun.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      expect(typeof storedDuringRun.restartRecoveryDeliveryRunId).toBe("string");
      expect(storedDuringRun.restartRecoveryDeliverySourceRunId).toBe("control-ui-run");
      expect(storedDuringRun.restartRecoverySourceIngress).toBe("control-ui");
      return {
        payloads: [{ text: "visible final" }],
        meta: {},
      };
    });

    const { run } = createMinimalRun({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "webchat",
      },
      sourceTurnId: "channel-user:v1:different-from-gateway-run",
      runOverrides: { messageProvider: "webchat" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(sessionStore.main.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
    const stored = await readStoredMainSession(storePath);
    expect(stored.restartRecoveryDeliveryContext).toBeUndefined();
    expect(stored.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(stored.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "visible final",
      context: { channel: "webchat" },
      intentId: expect.any(String),
      createdAt: expect.any(Number),
    });
    expect(stored.restartRecoverySourceIngress).toBe("control-ui");
    expect(stored.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
  });

  it("advances a transcript-only admission to pending before running a discovered hook", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: false,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "control-ui",
      status: "running",
    });
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockImplementation(async () => {
      expect((await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState).toBe(
        "pending",
      );
      expect((await readStoredMainSession(storePath)).restartRecoverySourceIngress).toBe(
        "control-ui",
      );
      return undefined;
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const result = await runHookBackedEmbeddedAgent(params);
      expect(
        (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
      ).toBeUndefined();
      return result;
    });

    const { run } = createMinimalRun({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "webchat",
      },
      sourceTurnId: "channel-user:v1:different-from-gateway-run",
      runOverrides: { messageProvider: "webchat" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("does not carry a stale hook checkpoint into a fresh claim", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      restartRecoveryBeforeAgentReplyState: "handled-reply",
    });
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockImplementation(async () => {
      expect((await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState).toBe(
        "pending",
      );
      return undefined;
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        MessageSid: "fresh-message",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        Provider: "discord",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "fresh request",
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "model reply" }));

    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("adopts a transcript-only claim by its short id when the full id differs", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
    const { run } = createMinimalRun({
      sessionCtx: {
        MessageSid: "msg",
        MessageSidFull: "provider-full-msg",
        OriginatingChannel: "webchat",
        Provider: "webchat",
      },
      sourceTurnId: "channel-user:v1:control-ui-run",
      runOverrides: { messageProvider: "webchat" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "final" }));
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const stored = await readStoredMainSession(storePath);
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
  });

  it("rejects a transcript-only claim already aborted for restart", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: true,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
    const onAdopted = vi.fn();
    const { run } = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "webchat",
      },
      runOverrides: { messageProvider: "webchat" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await expect(run()).rejects.toThrow("restart recovery claim changed before agent adoption");

    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
  });

  it("clears an adopted transcript-only claim after user cancellation", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      abortedLastRun: false,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "running",
    });
    const replyOperation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(replyOperation.abortByUser()).toBe(true);
      const current = await readStoredMainSession(storePath);
      await replaceSessionEntry(
        { storePath, sessionKey: "main" },
        { ...current, abortedLastRun: true, status: "killed", updatedAt: Date.now() },
      );
      throw new Error("cancelled");
    });

    try {
      const { run } = createMinimalRun({
        replyOperation,
        sessionCtx: {
          Provider: "webchat",
          OriginatingChannel: "webchat",
        },
        runOverrides: { messageProvider: "webchat" },
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });

      await run();

      const stored = await readStoredMainSession(storePath);
      expect(stored.abortedLastRun).toBe(true);
      expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
      expect(stored.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
    } finally {
      replyOperation.complete();
    }
  });

  it("fires onAdopted after restart recovery delivery context persist completes", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      accountId: "work",
      conversationId: "channel:24680",
      messageId: "1503645939964055592",
    });
    const events: string[] = [];
    const onAdopted = vi.fn(async () => {
      const storedAtAdoption = await readStoredMainSession(storePath);
      expect(storedAtAdoption.restartRecoveryDeliveryContext).toEqual({
        channel: "discord",
        to: "channel:24680",
        accountId: "work",
        threadId: "1503645939964055592",
      });
      expect(typeof storedAtAdoption.restartRecoveryDeliveryRunId).toBe("string");
      expect(storedAtAdoption.restartRecoveryDeliverySourceRunId).toBe(expectedSourceTurnId);
      expect(storedAtAdoption.restartRecoveryRequesterAccountId).toBe("work");
      expect(storedAtAdoption.restartRecoveryRequesterSenderId).toBe("discord-user");
      expect(storedAtAdoption.restartRecoverySourceIngress).toBe("channel");
      expect(storedAtAdoption.restartRecoverySourceReplyDeliveryMode).toBe("message_tool_only");
      const transcript = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath,
      });
      expect(transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "user",
              content: "durable discord request",
            }),
          }),
        ]),
      );
      events.push("adopted");
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      events.push("agent-run");
      return {
        payloads: [{ text: "visible final" }],
        meta: {},
      };
    });

    const { followupRun, run, sourceTurnId } = createMinimalRun({
      opts: {
        turnAdoptionLifecycle: { onAdopted },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        AccountId: "work",
        SenderId: "discord-user",
        MessageSid: "1503645939964055592",
        MessageThreadId: "1503645939964055592",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "durable discord request",
    });
    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await run();

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(events).toEqual(["adopted", "agent-run"]);
    expect(
      (await readStoredMainSession(storePath)).restartRecoverySourceReplyDeliveryMode,
    ).toBeUndefined();
    expect((await readStoredMainSession(storePath)).restartRecoverySourceIngress).toBeUndefined();
    expect(
      (await readStoredMainSession(storePath)).restartRecoveryRequesterAccountId,
    ).toBeUndefined();
    expect(
      (await readStoredMainSession(storePath)).restartRecoveryRequesterSenderId,
    ).toBeUndefined();
  });

  it("persists the channel adapter's narrowed message-action scope", async () => {
    state.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: () => ({ sameChannelThreadRequired: true }),
      },
    });
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const onAdopted = vi.fn(async () => {
      expect(
        (await readStoredMainSession(storePath)).restartRecoverySameChannelThreadRequired,
      ).toBe(true);
    });
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      opts: {
        turnAdoptionLifecycle: { onAdopted },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      sessionCtx: {
        Provider: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        MessageSid: "1700000000.000001",
        MessageThreadId: "1699999999.000001",
      },
      runOverrides: { messageProvider: "slack" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "durable slack request",
    });

    await run();

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(
      (await readStoredMainSession(storePath)).restartRecoverySameChannelThreadRequired,
    ).toBeUndefined();
  });

  it("runs a deferred before_agent_reply hook only after durable admission", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "discord-message-1",
    });
    const events: string[] = [];
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockImplementation(async (_event, context) => {
      expect(context.sessionId).toBe("session");
      const storedAtHook = await readStoredMainSession(storePath);
      expect(storedAtHook.status).toBe("running");
      expect(storedAtHook.restartRecoveryDeliverySourceRunId).toBe(expectedSourceTurnId);
      expect(storedAtHook.restartRecoveryBeforeAgentReplyState).toBe("pending");
      const transcript = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath,
      });
      expect(transcript.at(-1)).toMatchObject({
        message: { role: "user", content: "hook-owned request" },
      });
      events.push("hook");
      return { handled: true, reply: { text: "hook reply" } };
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      opts: {
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            events.push("adopted");
          },
        },
      },
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-1",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "hook-owned request",
    });
    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "hook reply" }));

    expect(events).toEqual(["adopted", "hook"]);
    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      pendingFinalDelivery: { kind: "replayable", text: "hook reply" },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryForceSafeTools: true,
      restartRecoverySourceIngress: "channel",
    });
  });

  it("finalizes a hook-handled turn when source delivery is intentionally suppressed", async () => {
    const receipt: ReplyOperationRunState = {};
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue({
      handled: true,
      reply: { text: "private hook reply" },
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
        [REPLY_OPERATION_RUN_STATE]: receipt,
      },
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-silent-hook",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "private hook request",
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "private hook reply" }));
    expect(resolveReplyOperationAgentTurn(receipt)).toBe("ok");

    expect(await readStoredMainSession(storePath)).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: [sourceTurnId],
    });
  });

  it("checkpoints an unhandled before_agent_reply hook before the model starts", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const result = await runHookBackedEmbeddedAgent(params);
      expect(
        (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
      ).toBeUndefined();
      return result;
    });
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "discord-message-2",
      },
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId,
      storePath,
      text: "model-owned request",
    });

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "model reply" }));

    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      pendingFinalDelivery: {
        kind: "replayable",
        text: "model reply",
        context: { channel: "discord" },
        intentId: expect.any(String),
        createdAt: expect.any(Number),
      },
      restartRecoverySourceIngress: "channel",
    });
    expect(
      (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
    ).toBeUndefined();
  });

  it("fires onAdopted for suppressed-delivery runs before the agent turn", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const events: string[] = [];
    const onAdopted = vi.fn(async () => {
      const storedAtAdoption = await readStoredMainSession(storePath);
      expect(storedAtAdoption.restartRecoveryDeliveryContext).toBeUndefined();
      expect(storedAtAdoption.restartRecoveryDeliveryRunId).toBeUndefined();
      events.push("adopted");
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      events.push("agent-run");
      return {
        payloads: [{ text: "ambient final" }],
        meta: {},
      };
    });

    const { run } = createMinimalRun({
      opts: {
        turnAdoptionLifecycle: { onAdopted },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        AccountId: "default",
        MessageSid: "42",
        InboundEventKind: "room_event",
      },
      runOverrides: { messageProvider: "telegram" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      currentInboundEventKind: "room_event",
    });

    await run();

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(events).toEqual(["adopted", "agent-run"]);
  });

  it("keeps heartbeat replies with real content in pending final delivery", async () => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Sent daily summary to channel." }],
      meta: {},
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: true },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "Sent daily summary to channel.",
    });
  });

  it("persists heartbeat reply remainder as pending delivery when remainder exceeds ackMaxChars", async () => {
    // When a heartbeat response contains HEARTBEAT_OK followed by substantive content,
    // the remainder after stripping the token must be persisted for durable delivery.
    // The default ackMaxChars is 300 — any remainder longer than that is treated as real content.
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const longRemainder = "Sent daily digest to channel. ".repeat(12).trimEnd(); // ~360 chars, > 300
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: `HEARTBEAT_OK ${longRemainder}` }],
      meta: {},
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: true },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    const result = await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: longRemainder,
      deliveries: [{ id: expect.any(String), state: "prepared" }],
    });
    const payload = Array.isArray(result) ? result[0] : result;
    expect(getReplyPayloadMetadata(payload ?? {})).toMatchObject({
      pendingFinalDeliveryCompletion: {
        deliveryId: stored.pendingFinalDelivery?.deliveries?.[0]?.id,
        intentId: stored.pendingFinalDelivery?.intentId,
        sessionId: "session",
        sessionKey: "main",
        storePath,
      },
    });
  });
});

describe("runReplyAgent typing (heartbeat)", () => {
  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("does not persist heartbeat ack text as pending final delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-heartbeat-pending-"));
    const storePath = join(dir, "sessions.json");
    await replaceSessionEntry(
      { storePath, sessionKey: "main" },
      { sessionId: "session", updatedAt: 1 },
    );
    try {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: {},
      });

      const { run } = createMinimalRun({
        opts: { isHeartbeat: true },
        sessionCtx: { Provider: "heartbeat" },
        sessionKey: "main",
        storePath,
      });
      await run();

      const stored = requireStoredSessionEntry(storePath);
      expect(stored.pendingFinalDelivery).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suppresses NO_REPLY partials but allows normal No-prefix partials", async () => {
    const cases = [
      {
        partials: ["NO_REPLY"],
        finalText: "NO_REPLY",
        expectedForwarded: [] as string[],
        shouldType: false,
      },
      {
        partials: ["NO", "NO_", "NO_RE", "NO_REPLY"],
        finalText: "NO_REPLY",
        expectedForwarded: [] as string[],
        shouldType: false,
      },
      {
        partials: ["No", "No, that is valid"],
        finalText: "No, that is valid",
        expectedForwarded: ["No", "No, that is valid"],
        shouldType: true,
      },
      {
        partials: ["NO_REPLYThe user is saying hello"],
        finalText: "NO_REPLYThe user is saying hello",
        expectedForwarded: ["The user is saying hello"],
        shouldType: true,
      },
    ] as const;

    for (const testCase of cases) {
      const onPartialReply = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        for (const text of testCase.partials) {
          await params.onPartialReply?.({ text });
        }
        return { payloads: [{ text: testCase.finalText }], meta: {} };
      });

      const { run, typing } = createMinimalRun({
        opts: { isHeartbeat: false, onPartialReply },
        typingMode: "message",
      });
      await run();

      if (testCase.expectedForwarded.length === 0) {
        expect(onPartialReply).not.toHaveBeenCalled();
      } else {
        expect(onPartialReply).toHaveBeenCalledTimes(testCase.expectedForwarded.length);
        testCase.expectedForwarded.forEach((text, index) => {
          expect(onPartialReply).toHaveBeenNthCalledWith(index + 1, {
            text,
            mediaUrls: undefined,
          });
        });
      }

      if (testCase.shouldType) {
        expect(typing.startTypingOnText).toHaveBeenCalled();
      } else {
        expect(typing.startTypingOnText).not.toHaveBeenCalled();
      }
      expect(typing.startTypingLoop).not.toHaveBeenCalled();
    }
  });

  it("keeps final text blocks after partial preview streaming", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "First block\n\nSecond block" });
      return {
        payloads: [{ text: "First block" }, { text: "Second block" }],
        meta: {},
      };
    });

    const { run } = createMinimalRun({
      opts: { onPartialReply },
      typingMode: "message",
    });

    const result = await run();

    expect(onPartialReply).toHaveBeenCalledWith({ text: "First block\n\nSecond block" });
    expect(result).toEqual([
      expect.objectContaining({ text: "First block" }),
      expect.objectContaining({ text: "Second block" }),
    ]);
  });

  it("suppresses narrated silent-turn partials, block replies, and final payloads", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nI am trying to send NO_REPLY now." });
      await params.onPartialReply?.({ text: "I am trying to send NO_REPLY now." });
      await params.onBlockReply?.({ text: "I am trying to send NO_REPLY now." });
      return { payloads: [{ text: "I am trying to send NO_REPLY now." }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("suppresses bare NO_REPLY silent-turn payloads", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nNO_REPLY" });
      await params.onPartialReply?.({ text: "NO_REPLY" });
      await params.onBlockReply?.({ text: "NO_REPLY" });
      return { payloads: [{ text: "NO_REPLY" }], meta: { finalAssistantText: "NO_REPLY" } };
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("does not start typing on assistant message start without prior text in message mode", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onAssistantMessageStart?.();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing from reasoning stream in thinking mode", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("keeps assistant partial streaming enabled when reasoning mode is stream", async () => {
    const onPartialReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await params.onPartialReply?.({ text: "answer chunk" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { onPartialReply, onReasoningStream },
      runOverrides: { reasoningLevel: "stream" },
    });
    await run();

    expect(onReasoningStream).toHaveBeenCalled();
    expect(onPartialReply).toHaveBeenCalledWith({ text: "answer chunk", mediaUrls: undefined });
  });

  it("suppresses typing in never mode", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals typing on normalized block replies", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "\n\nchunk", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      blockStreamingEnabled: true,
      opts: { onBlockReply },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("chunk");
    expect(onBlockReply).toHaveBeenCalled();
    const [blockPayload, blockOpts] = onBlockReply.mock.calls.at(0) ?? [];
    const blockPayloadRecord = requireRecord(blockPayload, "block payload");
    expect(blockPayloadRecord.text).toBe("chunk");
    expect(blockPayloadRecord.audioAsVoice).toBe(false);
    const blockOptions = requireRecord(blockOpts, "block options");
    expect(blockOptions.abortSignal).toBeInstanceOf(AbortSignal);
    expect(blockOptions.timeoutMs).toBeTypeOf("number");
  });

  it("strips workflow function response scaffolding from final delivery", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: [
            "Visible intro.",
            "<function_calls>",
            '<invoke name="exec"><parameter name="command">node scripts/search.mjs</parameter></invoke>',
            "</function_calls>",
            "<function_response>",
            'Searching for: "what skills matter most in the age of AI"',
            "...",
            "</function_response>",
            "Visible answer.",
          ].join("\n"),
        },
      ],
      meta: {},
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payloads = Array.isArray(res) ? res : res ? [res] : [];

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Visible intro.\n\n\nVisible answer.");
  });

  it("handles typing for normal and silent tool results", async () => {
    const cases = [
      {
        toolText: "tooling",
        shouldType: true,
        shouldForward: true,
      },
      {
        toolText: "NO_REPLY",
        shouldType: false,
        shouldForward: false,
      },
    ] as const;

    for (const testCase of cases) {
      const onToolResult = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onToolResult?.({ text: testCase.toolText, mediaUrls: [] });
        return { payloads: [{ text: "final" }], meta: {} };
      });

      const { run, typing } = createMinimalRun({
        typingMode: "message",
        opts: { onToolResult },
      });
      await run();

      if (testCase.shouldType) {
        expect(typing.startTypingOnText).toHaveBeenCalledWith(testCase.toolText);
      } else {
        expect(typing.startTypingOnText).not.toHaveBeenCalled();
      }

      if (testCase.shouldForward) {
        expect(onToolResult).toHaveBeenCalledWith({
          text: testCase.toolText,
          mediaUrls: [],
        });
      } else {
        expect(onToolResult).not.toHaveBeenCalled();
      }
    }
  });

  it("enables channel-owned tool summaries when default tool messages are suppressed", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.shouldEmitToolResult?.()).toBe(true);
      expect(params.shouldEmitToolOutput?.()).toBe(false);
      await params.onToolResult?.({ text: "🛠️ `run ruby`", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: {
        suppressDefaultToolProgressMessages: true,
        forceToolResultProgress: true,
        onToolResult,
      },
      resolvedVerboseLevel: "off",
    });
    await run();

    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `run ruby`",
      mediaUrls: [],
    });
  });

  it("preserves channelData on forwarded tool results", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(onToolResult).toHaveBeenCalledWith({
      text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      channelData: {
        execApproval: {
          approvalId: "117ba06d-1111-2222-3333-444444444444",
          approvalSlug: "117ba06d",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    });
  });

  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({
        mediaUrls: ["/tmp/generated.png"],
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    const toolPayload = requireRecord(
      mockCallArgs(onToolResult, "onToolResult")[0],
      "tool payload",
    );
    expect(toolPayload.mediaUrls).toEqual(["/tmp/generated.png"]);
    expect(toolPayload.text).toBeUndefined();
  });

  it("does not retry transient HTTP failures in the reply layer", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("502 Bad Gateway"));

    const { run } = createMinimalRun({ typingMode: "message" });
    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(payloads.map((payload) => payload?.text)).toHaveLength(1);
    expect(payloads[0]?.text).toContain("provider internal error");
  });

  it("announces model fallback transitions across verbose levels", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-fallback-pin-"));
    const storePath = join(storeRoot, "sessions.json");
    const cases = [
      { name: "verbose on", verbose: "on" as const },
      { name: "verbose off", verbose: "off" as const },
    ] as const;
    for (const testCase of cases) {
      const sessionEntry = makeSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
      });
      await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);
      const sessionStore = { main: sessionEntry };
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "final" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      });
      vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => {
        const { onFallbackStep } = args;
        expect(args.provider, testCase.name).toBe("openai");
        expect(args.model, testCase.name).toBe("gpt-5.6-sol");
        await onFallbackStep?.({
          fallbackStepType: "fallback_step",
          fallbackStepFromModel: "openai/gpt-5.6-sol",
          fallbackStepToModel: "deepinfra/moonshotai/Kimi-K2.5",
          fallbackStepFromFailureReason: "rate_limit",
          fallbackStepFinalOutcome: "succeeded",
        });
        return {
          outcome: "completed" as const,
          result: await runFallbackModelAttempt(
            args,
            "deepinfra",
            "moonshotai/Kimi-K2.5",
            "rate_limit",
          ),
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "openai",
              model: "gpt-5.6-sol",
              error: "Provider openai is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        };
      });

      const { run } = createMinimalRun({
        resolvedVerboseLevel: testCase.verbose,
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
        runOverrides: { provider: "openai", model: "gpt-5.6-sol" },
      });
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const res = await run();
      off();
      const payload = Array.isArray(res)
        ? (res[0] as { text?: string })
        : (res as { text?: string });
      const stored = requireStoredSessionEntry(storePath);
      expect(payload.text, testCase.name).toContain("Model Fallback:");
      expect(payload.text, testCase.name).toContain("deepinfra/moonshotai/Kimi-K2.5");
      expect(stored.providerOverride, testCase.name).toBe("openai");
      expect(stored.modelOverride, testCase.name).toBe("gpt-5.6-sol");
      expect(stored.modelOverrideSource, testCase.name).toBe("user");
      expect(stored.modelProvider, testCase.name).toBe("openai");
      expect(stored.model, testCase.name).toBe("gpt-5.6-sol");
      expect(stored.fallbackNotice?.selectedModel, testCase.name).toBe("openai/gpt-5.6-sol");
      expect(stored.fallbackNotice?.activeModel, testCase.name).toBe(
        "deepinfra/moonshotai/Kimi-K2.5",
      );
      expect(stored.fallbackNotice?.reason, testCase.name).toBe("rate limit");
      expect(
        phases.filter((phase) => phase === "fallback"),
        testCase.name,
      ).toHaveLength(1);
      expect(phases, testCase.name).toContain("fallback_step");
    }
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("does not report an exhausted fallback candidate as a successful winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-exhausted-trace-"));
    const storePath = join(root, "sessions.json");
    const sessionFile = join(root, "session.jsonl");
    const runId = "run-exhausted-trace";
    const sessionEntry = makeSessionEntry({
      traceLevel: "raw",
    });
    await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);
    try {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "Terminal tool summary", isError: true }],
        meta: {
          error: {
            kind: "incomplete_turn",
            message: "Agent ended incomplete",
            fallbackSafe: true,
            terminalPresentation: true,
          },
          executionTrace: {
            winnerProvider: "anthropic",
            winnerModel: "claude",
            attempts: [{ provider: "anthropic", model: "claude", result: "success" }],
            fallbackUsed: false,
            runner: "embedded",
          },
          agentMeta: {
            sessionId: "session",
            provider: "anthropic",
            model: "claude",
            usage: { input: 10, output: 2 },
          },
        },
      });
      vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(
        async (args) => ({
          outcome: "exhausted",
          result: await runInitialModelFallbackAttempt(args, "anthropic", "claude"),
          provider: "anthropic",
          model: "claude",
          attempts: [
            {
              provider: "anthropic",
              model: "claude",
              error: "Agent ended incomplete",
              reason: "format",
            },
          ],
        }),
      );

      const { run } = createMinimalRun({
        opts: { runId },
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath,
        runOverrides: {
          sessionFile,
          traceAuthorized: true,
        },
      });
      const result = await run();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text ?? "")
        .join("\n");

      expect(text).not.toContain("winner=anthropic/claude");
      expect(text).not.toContain("result=success");
      expect(text).toContain("Summary: fallback=yes attempts=1");
      expect(consumeReplyUsageState(runId)?.resolvedRef).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains pending tool delivery before returning an empty terminal-run failure", async () => {
    let markToolResultStarted = () => {};
    const toolResultStarted = new Promise<void>((resolve) => {
      markToolResultStarted = resolve;
    });
    let releaseToolResult = () => {};
    const toolResultReleased = new Promise<void>((resolve) => {
      releaseToolResult = resolve;
    });
    let toolResultDelivered = false;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      void params.onToolResult?.({ text: "late tool result" });
      return {
        payloads: [],
        meta: {
          error: {
            kind: "tool_result_mismatch",
            message: "Agent run reached a terminal error before reply delivery.",
          },
        },
      };
    });
    const { run } = createMinimalRun({
      opts: {
        onToolResult: async () => {
          markToolResultStarted();
          await toolResultReleased;
          toolResultDelivered = true;
        },
      },
    });

    const pendingResult = run();
    await toolResultStarted;
    expect(toolResultDelivered).toBe(false);
    releaseToolResult();
    const result = await pendingResult;
    const payload = Array.isArray(result) ? result[0] : result;

    expect(toolResultDelivered).toBe(true);
    expect(payload).toMatchObject({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isError: true,
    });
  });

  it.each([
    {
      name: "releases a queued followup after the pending tool delivery idle bound",
      elapsedMs: 30_000,
      owned: false,
    },
    {
      name: "keeps a queued followup owned until pending tool delivery settles",
      elapsedMs: 29_999,
      owned: true,
    },
  ])("$name", async ({ elapsedMs, owned }) => {
    vi.useFakeTimers();
    const toolResultStarted = createDeferred();
    const toolResultReleased = createDeferred();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      void params.onToolResult?.({ text: "pending tool result" });
      return { payloads: [{ text: "followup complete" }], meta: {} };
    });
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
      opts: {
        forceToolResultProgress: true,
        onToolResult: async () => {
          toolResultStarted.resolve();
          await toolResultReleased.promise;
        },
      },
    });
    let followup: Promise<void> | undefined;
    try {
      await run();
      followup = requireScheduledFollowupRunner()(followupRun);
      await toolResultStarted.promise;

      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(replyRunRegistry.get("main") !== undefined).toBe(owned);

      toolResultReleased.resolve();
      await followup;
      expect(replyRunRegistry.get("main")).toBeUndefined();
    } finally {
      toolResultReleased.resolve();
      await followup;
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "empty output", payloads: [] },
    { label: "reasoning-only output", payloads: [{ text: "internal", isReasoning: true }] },
    { label: "commentary-only output", payloads: [{ text: "internal", isCommentary: true }] },
    { label: "directive-only output", payloads: [{ text: "[[reply_to_current]]" }] },
  ])("surfaces successful $label through normal reply delivery", async ({ payloads }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads, meta: {} });
    const { run } = createMinimalRun({
      runOverrides: { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    });

    const result = await run();
    const payloadsResult = Array.isArray(result) ? result : [result];

    expect(payloadsResult).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("did not produce a visible reply"),
        isError: true,
        replyToId: "msg",
      }),
    );
  });

  it("surfaces a marked fallback for an empty message-tool-only completion", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await run();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      text: expect.stringContaining("did not produce a visible reply"),
      isError: true,
    });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([
    { lane: "reasoning", payload: { text: "internal", isReasoning: true } },
    { lane: "commentary", payload: { text: "internal", isCommentary: true } },
  ])("does not let streamed $lane suppress the empty-reply fallback", async ({ payload }) => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.(payload);
      return { payloads: [], meta: {} };
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: true,
      opts: {
        onBlockReply,
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
      },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(expect.objectContaining(payload));
    expect(payloads).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("did not produce a visible reply"),
        isError: true,
      }),
    );
  });

  it.each([
    {
      label: "NO_REPLY",
      pendingContinuation: false,
      result: {
        payloads: [{ text: "NO_REPLY" }],
        meta: { finalAssistantVisibleText: "NO_REPLY" },
      },
    },
    {
      label: "yielded continuation",
      pendingContinuation: true,
      result: { payloads: [], meta: { yielded: true } },
    },
    {
      label: "pending tool continuation",
      pendingContinuation: true,
      result: { payloads: [], meta: { pendingToolCalls: [{ name: "hosted_tool" }] } },
    },
  ])("keeps successful $label completions silent", async ({ result, pendingContinuation }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce(result);
    const onPendingContinuation = vi.fn();
    const { run } = createMinimalRun({ opts: { onPendingContinuation } });

    await expect(run()).resolves.toBeUndefined();
    expect(onPendingContinuation).toHaveBeenCalledTimes(pendingContinuation ? 1 : 0);
  });

  it("delivers one bounded status for an accepted child continuation", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I’m continuing this work and will send the result when it is ready." }],
      meta: { continuationPending: true },
      acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:child" }],
    });
    const onPendingContinuation = vi.fn();
    const { run } = createMinimalRun({ opts: { onPendingContinuation } });

    const result = await run();
    expect(result).toMatchObject({
      text: "I’m continuing this work and will send the result when it is ready.",
      replyToId: "msg",
    });
    expect(onPendingContinuation).toHaveBeenCalledOnce();
    expect(
      getReplyPayloadMetadata(requireRecord(result, "continuation status"))?.continuationStatus,
    ).toBe(true);
  });

  it("delivers an explicit yield acknowledgment after accepting a child spawn", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
      acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:child" }],
    });
    const onPendingContinuation = vi.fn();
    const { run } = createMinimalRun({ opts: { onPendingContinuation } });

    await expect(run()).resolves.toMatchObject({
      text: "Research started; results will follow.",
      replyToId: "msg",
    });
    expect(onPendingContinuation).toHaveBeenCalledOnce();
  });

  it("prefers a yield acknowledgment over an earlier generated tool warning", async () => {
    const toolWarning = setReplyPayloadMetadata(
      { text: "⚠️ Bash failed", isError: true },
      { toolErrorWarning: { toolName: "bash" } },
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [toolWarning],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
      acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:child" }],
    });
    const { run } = createMinimalRun();

    await expect(run()).resolves.toMatchObject({
      text: "Research started; results will follow.",
      replyToId: "msg",
    });
  });

  it("keeps a generated tool warning when the yield acknowledgment is not deliverable", async () => {
    const toolWarning = setReplyPayloadMetadata(
      { text: "⚠️ Bash failed", isError: true },
      { toolErrorWarning: { toolName: "bash" } },
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [toolWarning],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun({ currentInboundEventKind: "room_event" });

    await expect(run()).resolves.toMatchObject({
      text: "⚠️ Bash failed",
      isError: true,
      replyToId: "msg",
    });
  });

  it("keeps a generated tool warning when the yield acknowledgment normalizes to empty", async () => {
    const toolWarning = setReplyPayloadMetadata(
      { text: "⚠️ Bash failed", isError: true },
      { toolErrorWarning: { toolName: "bash" } },
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [toolWarning],
      meta: {
        yielded: true,
        yieldAcknowledgment: "[[reply_to_current]]",
      },
      acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:child" }],
    });
    const { run } = createMinimalRun();

    await expect(run()).resolves.toMatchObject({
      text: "⚠️ Bash failed",
      isError: true,
      replyToId: "msg",
    });
  });

  it("delivers an explicit yield acknowledgment in message-tool-only mode", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await run();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({ text: "Research started; results will follow." });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("preserves a visible final reply instead of adding a yield acknowledgment", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Research already finished." }],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun();

    await expect(run()).resolves.toMatchObject({
      text: "Research already finished.",
      replyToId: "msg",
    });
  });

  it("delivers a yield acknowledgment when the only payload is filtered", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "internal reasoning", isReasoning: true }],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun();

    await expect(run()).resolves.toMatchObject({
      text: "Research started; results will follow.",
      replyToId: "msg",
    });
  });

  it.each([
    {
      label: "room event",
      params: { currentInboundEventKind: "room_event" as const },
    },
    {
      label: "internal handoff",
      params: {
        runOverrides: {
          inputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
        },
      },
    },
  ])("keeps successful empty $label completions silent", async ({ params }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun(params);

    await expect(run()).resolves.toBeUndefined();
  });

  it.each([
    {
      label: "silent token",
      payload: { text: "NO_REPLY" },
      opts: undefined,
      expectedText: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    },
    {
      label: "heartbeat acknowledgement",
      payload: { text: "HEARTBEAT_OK" },
      opts: { isHeartbeat: true as const },
      expectedText: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    },
    {
      label: "reasoning-only output",
      payload: { text: "internal reasoning", isReasoning: true },
      opts: undefined,
      expectedText: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    },
    {
      label: "commentary-only output",
      payload: { text: "internal commentary", isCommentary: true },
      opts: undefined,
      expectedText: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    },
    {
      label: "directive-only output",
      payload: { text: "[[reply_to_current]]" },
      opts: undefined,
      expectedText: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    },
  ])("replaces filtered $label after a terminal failure", async (testCase) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [testCase.payload],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error before visible reply delivery.",
        },
      },
    });
    const { run } = createMinimalRun({
      opts: testCase.opts,
      runOverrides: {
        config: { channels: { whatsapp: { replyToMode: "first" } } },
      },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];
    const failure = payloads.find((payload) => payload?.isError === true);

    expect(failure?.text).toBe(testCase.expectedText);
    expect(failure?.replyToId).toBe("msg");
  });

  it.each([
    { label: "message-tool", delivery: { didSendViaMessagingTool: true } },
    {
      label: "source-reply",
      delivery: { didDeliverSourceReplyViaMessageTool: true },
    },
  ])("does not duplicate an empty terminal failure after $label delivery", async ({ delivery }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error after delivery.",
        },
      },
      ...delivery,
    });

    const { run } = createMinimalRun();
    const result = await run();

    expect(result).toBeUndefined();
  });

  it("does not duplicate an empty terminal failure after an accepted answer block", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "complete answer" });
      return {
        payloads: [],
        meta: { error: { kind: "tool_result_mismatch", message: "terminal error after delivery" } },
      };
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: true,
      opts: { onBlockReply },
      sessionCtx: { ChatType: "group" },
    });

    expect(await run()).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "complete answer" }),
      expect.any(Object),
    );
  });

  it("does not persist active fallback state for internal subagent announce fallback", async () => {
    const sessionEntry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.5",
      responseUsage: "tokens",
    });
    const sessionStore = { main: sessionEntry };
    const storeRoot = await mkdtemp(join(tmpdir(), "openclaw-internal-fallback-"));
    const storePath = join(storeRoot, "sessions.json");
    await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionStore.main);
    try {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "subagent timed out" }],
        meta: {
          agentMeta: {
            usage: {
              input: 100,
              output: 50,
            },
          },
        },
      });
      vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => {
        const { onFallbackStep } = args;
        await onFallbackStep?.({
          fallbackStepType: "fallback_step",
          fallbackStepFromModel: "openai/gpt-5.5",
          fallbackStepToModel: "google/gemini-2.5-flash",
          fallbackStepFromFailureReason: "timeout",
          fallbackStepFinalOutcome: "succeeded",
        });
        return {
          outcome: "completed" as const,
          result: await runFallbackModelAttempt(args, "google", "gemini-2.5-flash", "timeout"),
          provider: "google",
          model: "gemini-2.5-flash",
          attempts: [
            {
              provider: "openai",
              model: "gpt-5.5",
              error: "codex app-server attempt timed out",
              reason: "timeout",
            },
          ],
        };
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
        runOverrides: {
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:codex:subagent:c34fca91",
            sourceChannel: "__internal__",
            sourceTool: "subagent_announce",
          },
        },
      });
      const res = await run();

      expect(sessionEntry.modelProvider).toBe("openai");
      expect(sessionEntry.model).toBe("gpt-5.5");
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(sessionEntry.modelOverride).toBeUndefined();
      expect(sessionEntry.modelOverrideSource).toBeUndefined();
      expect(sessionEntry.fallbackNotice).toBeUndefined();
      const persistedSession = requireStoredSessionEntry(storePath);
      expect(persistedSession.modelProvider).toBe("openai");
      expect(persistedSession.model).toBe("gpt-5.5");
      expect(persistedSession.providerOverride).toBeUndefined();
      expect(persistedSession.modelOverride).toBeUndefined();
      expect(persistedSession.modelOverrideSource).toBeUndefined();
      expect(persistedSession.fallbackNotice).toBeUndefined();
      const payloads = Array.isArray(res) ? res : res ? [res] : [];
      expect(payloads.some((payload) => payload.text?.includes("Model Fallback:"))).toBe(false);
      expect(payloads.some((payload) => payload.text?.includes("Usage:"))).toBe(false);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("surfaces empty internal fallback failures without persisting visible fallback state", async () => {
    const sessionEntry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.5",
    });
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => {
      const { onFallbackStep } = args;
      await onFallbackStep?.({
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "openai/gpt-5.5",
        fallbackStepToModel: "google/gemini-2.5-flash",
        fallbackStepFromFailureReason: "timeout",
        fallbackStepFinalOutcome: "succeeded",
      });
      return {
        outcome: "completed" as const,
        result: await runFallbackModelAttempt(args, "google", "gemini-2.5-flash", "timeout"),
        provider: "google",
        model: "gemini-2.5-flash",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "codex app-server attempt timed out",
            reason: "timeout",
          },
        ],
      };
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      runOverrides: {
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:codex:subagent:c34fca91",
          sourceChannel: "__internal__",
          sourceTool: "subagent_announce",
        },
      },
    });
    const res = await run();

    const payload = Array.isArray(res) ? res[0] : res;
    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain("Fallback used google/gemini-2.5-flash");
    expect(sessionEntry.modelProvider).toBe("openai");
    expect(sessionEntry.model).toBe("gpt-5.5");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.fallbackNotice).toBeUndefined();
  });

  it("keeps fallback transition notices when block streaming has no final text", async () => {
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };
    const onBlockReply = vi.fn();

    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "streamed answer" });
      return { payloads: [], meta: {} };
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(
        makeCompletedFallbackRunner({
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
              error: "Provider fireworks is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        }),
      );
    try {
      const { run } = createMinimalRun({
        blockStreamingEnabled: true,
        opts: { onBlockReply },
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const res = await run();
      const payloads = Array.isArray(res) ? res : res ? [res] : [];

      expect(onBlockReply).toHaveBeenCalled();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.text).toContain("Model Fallback:");
      expect(payloads[0]?.text).not.toContain("streamed answer");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("threads fallback notices without consuming the first assistant reply slot", async () => {
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };

    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(
        makeCompletedFallbackRunner({
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
              error: "Provider fireworks is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        }),
      );
    try {
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        runOverrides: {
          config: {
            channels: {
              whatsapp: {
                replyToMode: "first",
              },
            },
          },
        },
      });
      const res = await run();
      const payloads = Array.isArray(res) ? res : res ? [res] : [];

      expect(payloads).toHaveLength(2);
      expect(payloads[0]?.text).toContain("Model Fallback:");
      expect(payloads[0]?.replyToId).toBe("msg");
      expect(payloads[1]?.text).toBe("final");
      expect(payloads[1]?.replyToId).toBe("msg");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "NO_REPLY",
      payload: { text: "NO_REPLY" },
      opts: undefined,
      streamed: false,
    },
    {
      label: "reasoning-only output with reasoning enabled",
      payload: { text: "internal reasoning", isReasoning: true },
      opts: { reasoningPayloadsEnabled: true },
      streamed: false,
    },
    {
      label: "streamed reasoning-only output with reasoning enabled",
      payload: { text: "internal reasoning", isReasoning: true },
      opts: { reasoningPayloadsEnabled: true, onBlockReply: vi.fn() },
      streamed: true,
    },
    {
      label: "commentary-only output with commentary enabled",
      payload: { text: "internal commentary", isCommentary: true },
      opts: { commentaryPayloadsEnabled: true },
      streamed: false,
    },
  ])("surfaces a configured backend failure when fallback produces $label", async (testCase) => {
    const onAgentRunTerminalOutcome = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      if (testCase.streamed) {
        await params.onBlockReply?.(testCase.payload);
      }
      return {
        payloads: [testCase.payload],
        meta: {},
      };
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        opts: { ...testCase.opts, onAgentRunTerminalOutcome },
        blockStreamingEnabled: testCase.streamed,
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          MessageSid: "1503645939964055592",
        },
      });
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).toBe(true);
      expect(payload?.text).toContain("configured model backend lmstudio/gemma-4-e4b-it");
      expect(payload?.text).toContain("Fallback used openai/gpt-5.5");
      expect(payload?.text).toContain("no visible reply");
      expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("surfaces a configured backend failure when fallback returns no payloads", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          MessageSid: "1503645939964055592",
        },
      });
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).toBe(true);
      expect(payload?.text).toContain("configured model backend lmstudio/gemma-4-e4b-it");
      expect(payload?.text).toContain("Fallback used openai/gpt-5.5");
      expect(payload?.text).toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("delivers an explicit yield acknowledgment from a fallback model", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          MessageSid: "1503645939964055592",
        },
      });
      const result = await run();
      const payloads = Array.isArray(result) ? result : result ? [result] : [];

      expect(payloads).toContainEqual(
        expect.objectContaining({
          text: "Research started; results will follow.",
          replyToId: "1503645939964055592",
        }),
      );
      expect(payloads).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            isError: true,
            text: expect.stringContaining("no visible reply"),
          }),
        ]),
      );
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("surfaces a persisted configured backend failure when the active fallback is silent", async () => {
    const sessionEntry = makeSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "lmstudio",
      modelOverrideFallbackOriginModel: "gemma-4-e4b-it",
    });
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      runOverrides: {
        provider: "openai",
        model: "gpt-5.5",
      },
      sessionEntry,
      sessionStore,
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        MessageSid: "1503677587568722061",
      },
    });
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain("configured model backend lmstudio/gemma-4-e4b-it");
    expect(payload?.text).toContain("Fallback used openai/gpt-5.5");
    expect(payload?.text).toContain("no visible reply");
  });

  it("announces fallback without silence failure when fallback already replied through a messaging tool", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "already sent" }],
      messagingToolSentTexts: ["already sent"],
      messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel:C1" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
          messageProvider: "discord",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:C1",
          AccountId: "primary",
          MessageSid: "1503645939964055592",
        },
      });

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("does not report silent fallback failure after a did-send-only side effect", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      didSendViaMessagingTool: true,
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          MessageSid: "1503645939964055592",
        },
      });

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("does not treat whitespace-only messaging evidence as fallback delivery", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["  "],
      messagingToolSentMediaUrls: ["\t"],
      messagingToolSentTargets: [
        { tool: "message", provider: "discord", to: "channel:C1", text: "  " },
      ],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
          messageProvider: "discord",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:C1",
          AccountId: "primary",
          MessageSid: "1503645939964055592",
        },
      });
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).toBe(true);
      expect(payload?.text).toContain("configured model backend lmstudio/gemma-4-e4b-it");
      expect(payload?.text).toContain("Fallback used openai/gpt-5.5");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("announces fallback without silence failure when fallback already completed a cron side effect", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      successfulCronAdds: 1,
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
          messageProvider: "discord",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:C1",
          AccountId: "primary",
          MessageSid: "1503645939964055592",
        },
      });

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("announces fallback without silence failure when fallback committed target-only messaging delivery", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel:C1" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
          messageProvider: "discord",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:C1",
          AccountId: "primary",
          MessageSid: "1503645939964055592",
        },
      });

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("announces fallback without silence failure when fallback already delivered an approval prompt", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      didSendDeterministicApprovalPrompt: true,
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          MessageSid: "1503645939964055592",
        },
      });

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("preserves intentional fallback silence when the turn permits silent replies", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(makeCompletedFallbackRunner());

    try {
      const { run } = createMinimalRun({
        runOverrides: {
          provider: "lmstudio",
          model: "gemma-4-e4b-it",
          allowEmptyAssistantReplyAsSilent: true,
        },
        sessionCtx: {
          Provider: "discord",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:C1",
          ChatType: "channel",
          WasMentioned: false,
          MessageSid: "1503645939964055592",
        },
      });

      await expect(run()).resolves.toBeUndefined();
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("announces model fallback only once per active fallback state", async () => {
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };

    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementation(
      makeCompletedFallbackRunner({
        provider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
        attempts: [
          {
            provider: "fireworks",
            model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            error: "Provider fireworks is in cooldown (all profiles unavailable)",
            reason: "rate_limit",
          },
        ],
      }),
    );
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "on",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const fallbackEvents: Array<Record<string, unknown>> = [];
      const off = onAgentEvent((evt) => {
        if (evt.stream === "lifecycle" && evt.data?.phase === "fallback") {
          fallbackEvents.push(evt.data);
        }
      });
      const first = await run();
      const second = await run();
      off();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).not.toContain("Model Fallback:");
      expect(fallbackEvents).toHaveLength(1);
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("re-announces model fallback after returning to selected model", async () => {
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };
    let callCount = 0;

    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(async (params: TestModelFallbackRunnerParams) => {
        const { provider, model } = params;
        callCount += 1;
        if (callCount === 2) {
          return {
            outcome: "completed" as const,
            result: await runInitialModelFallbackAttempt(params),
            provider,
            model,
            attempts: [],
          };
        }
        return {
          outcome: "completed" as const,
          result: await runFallbackModelAttempt(
            params,
            "deepinfra",
            "moonshotai/Kimi-K2.5",
            "rate_limit",
          ),
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
              error: "Provider fireworks is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        };
      });
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "on",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const first = await run();
      const second = await run();
      const third = await run();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      const thirdText = Array.isArray(third) ? third[0]?.text : third?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).not.toContain("Model Fallback:");
      expect(thirdText).toContain("Model Fallback:");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it.each([
    { label: "direct chats", chatType: "direct" as const, noticeVisible: true },
    { label: "group chats", chatType: "group" as const, noticeVisible: false },
    { label: "channels", chatType: "channel" as const, noticeVisible: false },
  ])(
    "controls fallback notices for $label without changing state or lifecycle",
    async ({ chatType, noticeVisible }) => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
      let callCount = 0;

      state.runEmbeddedAgentMock.mockResolvedValue({
        payloads: [{ text: "final" }],
        meta: {},
      });
      const fallbackSpy = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementation(async (params: TestModelFallbackRunnerParams) => {
          const { provider, model } = params;
          callCount += 1;
          if (callCount === 1) {
            return {
              outcome: "completed" as const,
              result: await runFallbackModelAttempt(
                params,
                "deepinfra",
                "moonshotai/Kimi-K2.5",
                "rate_limit",
              ),
              provider: "deepinfra",
              model: "moonshotai/Kimi-K2.5",
              attempts: [
                {
                  provider: "fireworks",
                  model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                  error: "Provider fireworks is in cooldown (all profiles unavailable)",
                  reason: "rate_limit",
                },
              ],
            };
          }
          return {
            outcome: "completed" as const,
            result: await runInitialModelFallbackAttempt(params),
            provider,
            model,
            attempts: [],
          };
        });
      try {
        const { run } = createMinimalRun({
          resolvedVerboseLevel: "on",
          sessionEntry,
          sessionStore,
          sessionKey: "main",
          storePath,
          sessionCtx: { ChatType: chatType },
        });
        const phases: string[] = [];
        const off = onAgentEvent((evt) => {
          const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
          if (evt.stream === "lifecycle" && phase) {
            phases.push(phase);
          }
        });
        const first = await run();
        const activeFallback = {
          kind: "active" as const,
          selectedModel: "anthropic/claude",
          activeModel: "deepinfra/moonshotai/Kimi-K2.5",
          reason: "rate limit",
        };
        expect(sessionEntry.fallbackNotice).toEqual(activeFallback);
        expect(requireStoredSessionEntry(storePath).fallbackNotice).toEqual(activeFallback);
        const second = await run();
        const third = await run();
        off();

        const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
        const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
        const thirdText = Array.isArray(third) ? third[0]?.text : third?.text;
        expect(firstText?.includes("Model Fallback:")).toBe(noticeVisible);
        expect(secondText?.includes("Model Fallback cleared:")).toBe(noticeVisible);
        expect(thirdText).not.toContain("Model Fallback cleared:");
        if (!noticeVisible) {
          expect(firstText).toBe("final");
          expect(secondText).toBe("final");
        }
        expect(countMatching(phases, (phase) => phase === "fallback")).toBe(1);
        expect(countMatching(phases, (phase) => phase === "fallback_cleared")).toBe(1);
        expect(sessionEntry.fallbackNotice).toBeUndefined();
        expect(requireStoredSessionEntry(storePath).fallbackNotice).toBeUndefined();
      } finally {
        fallbackSpy.mockRestore();
      }
    },
  );

  it("clears native fallback state without attributing finalizer response usage to the native model", async () => {
    const runtimeModelSelection = { provider: "openai", model: "gpt-5.6-sol" };
    const response = { provider: "google", model: "gemini-2.5-flash" };
    const selectedModelRef = `${runtimeModelSelection.provider}/${runtimeModelSelection.model}`;
    const responseModelRef = `${response.provider}/${response.model}`;
    const runId = "native-fallback-cleared";
    const usage = { input: 120, output: 8 };
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      modelProvider: runtimeModelSelection.provider,
      model: runtimeModelSelection.model,
      fallbackNotice: {
        kind: "active",
        selectedModel: selectedModelRef,
        activeModel: responseModelRef,
        reason: "timeout",
      },
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "finalized answer" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          ...response,
          agentHarnessId: "codex",
          runtimeModelSelection,
          usage,
        },
      },
    });
    const { run } = createMinimalRun({
      opts: { runId },
      sessionEntry,
      sessionStore,
      storePath,
      runOverrides: runtimeModelSelection,
      sessionCtx: { ChatType: "direct" },
    });
    const fallbackEvents: Array<Record<string, unknown>> = [];
    const off = onAgentEvent((event) => {
      if (
        event.runId === runId &&
        event.stream === "lifecycle" &&
        (event.data.phase === "fallback" || event.data.phase === "fallback_cleared")
      ) {
        fallbackEvents.push(event.data);
      }
    });
    try {
      const result = await run();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text ?? "")
        .join("\n");

      expect(requireStoredSessionEntry(storePath).fallbackNotice).toBeUndefined();
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          phase: "fallback_cleared",
          selectedProvider: runtimeModelSelection.provider,
          selectedModel: runtimeModelSelection.model,
          activeProvider: runtimeModelSelection.provider,
          activeModel: runtimeModelSelection.model,
          previousActiveModel: responseModelRef,
        }),
      ]);
      expect(text).toContain(`Model Fallback cleared: ${selectedModelRef}`);
      expect(text).toContain("finalized answer");
      expect(consumeReplyUsageState(runId)).toMatchObject({ ...response, usage });
    } finally {
      off();
    }
  });

  it("announces fallback transitions and emits lifecycle events while verbose is off", async () => {
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };
    let callCount = 0;

    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(async (params: TestModelFallbackRunnerParams) => {
        const { provider, model } = params;
        callCount += 1;
        if (callCount === 1) {
          return {
            outcome: "completed" as const,
            result: await runFallbackModelAttempt(
              params,
              "deepinfra",
              "moonshotai/Kimi-K2.5",
              "rate_limit",
            ),
            provider: "deepinfra",
            model: "moonshotai/Kimi-K2.5",
            attempts: [
              {
                provider: "fireworks",
                model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                error: "Provider fireworks is in cooldown (all profiles unavailable)",
                reason: "rate_limit",
              },
            ],
          };
        }
        return {
          outcome: "completed" as const,
          result: await runInitialModelFallbackAttempt(params),
          provider,
          model,
          attempts: [],
        };
      });
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const first = await run();
      const second = await run();
      off();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).toContain("Model Fallback cleared:");
      expect(countMatching(phases, (phase) => phase === "fallback")).toBe(1);
      expect(countMatching(phases, (phase) => phase === "fallback_cleared")).toBe(1);
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("updates fallback reason summary while fallback stays active", async () => {
    const cases = [
      {
        existingReason: undefined,
        reportedReason: "rate_limit",
        expectedReason: "rate limit",
      },
      {
        existingReason: undefined,
        reportedReason: "overloaded",
        expectedReason: "overloaded",
      },
      {
        existingReason: "rate limit",
        reportedReason: "timeout",
        expectedReason: "timeout",
      },
    ] as const;

    for (const testCase of cases) {
      const sessionEntry = makeSessionEntry({
        fallbackNotice: {
          kind: "active" as const,
          selectedModel: "anthropic/claude",
          activeModel: "deepinfra/moonshotai/Kimi-K2.5",
          ...(testCase.existingReason ? { reason: testCase.existingReason } : {}),
        },
        modelProvider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
      });
      const sessionStore = { main: sessionEntry };

      state.runEmbeddedAgentMock.mockResolvedValue({
        payloads: [{ text: "final" }],
        meta: {},
      });
      const fallbackSpy = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
          outcome: "completed" as const,
          result: await runFallbackModelAttempt(
            params,
            "deepinfra",
            "moonshotai/Kimi-K2.5",
            testCase.reportedReason,
          ),
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "anthropic",
              model: "claude",
              error: "Provider anthropic is in cooldown (all profiles unavailable)",
              reason: testCase.reportedReason,
            },
          ],
        }));
      try {
        const { run } = createMinimalRun({
          resolvedVerboseLevel: "on",
          sessionEntry,
          sessionStore,
          sessionKey: "main",
        });
        const res = await run();
        const firstText = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(firstText).not.toContain("Model Fallback:");
        expect(sessionEntry.fallbackNotice?.reason).toBe(testCase.expectedReason);
      } finally {
        fallbackSpy.mockRestore();
      }
    }
  });

  it("marks prior context usage stale when CLI usage is only cumulative", async () => {
    const sessionEntry = makeSessionEntry({
      totalTokens: 42_000,
      totalTokensFresh: true,
      fallbackNotice: {
        kind: "active",
        selectedModel: "anthropic/claude-opus-4-7",
        activeModel: "claude-cli/claude-opus-4-7",
        reason: "selected model unavailable",
      },
    });
    const sessionStore = { main: sessionEntry };
    const dir = await mkdtemp(join(tmpdir(), "openclaw-agent-runner-cli-alias-"));
    const storePath = join(dir, "sessions.json");
    await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);

    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-7",
          usage: { input: 205_000, output: 19_000 },
        },
      },
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      runOverrides: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        config: {},
      },
    });
    await run();

    const stored = requireStoredSessionEntry(storePath);
    expect(sessionEntry.fallbackNotice).toBeUndefined();
    expect(stored.fallbackNotice).toBeUndefined();
    expect(stored.modelProvider).toBe("claude-cli");
    expect(stored.model).toBe("claude-opus-4-7");
    expect(stored.totalTokens).toBe(42_000);
    expect(stored.totalTokensFresh).toBe(false);
  });

  it("surfaces overflow fallback when embedded run returns empty payloads", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("Auto-compaction could not recover this turn");
    expect(payload.text).toContain("fresh session or using a model with a larger context window");
    expect(payload.text).toContain("/new");
  });

  it("surfaces overflow fallback when embedded payload text is whitespace-only", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: "   \n\t  ", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("Auto-compaction could not recover this turn");
    expect(payload.text).toContain("fresh session or using a model with a larger context window");
    expect(payload.text).toContain("/new");
  });

  it("returns friendly message for role ordering errors thrown as exceptions", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      throw new Error("400 Incorrect role information");
    });

    const { run } = createMinimalRun({});
    const res = await run();

    const payload = requireRecord(res, "ordering conflict payload");
    expect(payload.text).toContain("model provider rejected the conversation state");
    expect(payload.text).not.toContain("400");
  });

  it("rewrites Bun socket errors into friendly text", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: "TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
          isError: true,
        },
      ],
      meta: {},
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payloads = Array.isArray(res) ? res : res ? [res] : [];
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.text).toContain("LLM connection failed");
    expect(payloads[0]?.text).toContain("socket connection was closed unexpectedly");
    expect(payloads[0]?.text).toContain("```");
  });
});

import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
