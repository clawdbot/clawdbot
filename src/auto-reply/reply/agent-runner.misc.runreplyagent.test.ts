import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
// Tests miscellaneous run-reply-agent behaviors and artifact output.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  beginForegroundSessionMaintenance,
  waitForSessionMaintenance,
} from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onAgentEvent as subscribeAgentEvent,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { GatewayDrainingError } from "../../process/command-queue.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type { VerboseLevel } from "../thinking.shared.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "./agent-runner.test-fixtures.js";
import { clearPendingFinalDeliveryAfterSuccess } from "./dispatch-from-config.pending-final.js";
import type { FollowupRun } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply-operation-run-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let rootDir: string;

function createCliBackendTestConfig() {
  return {};
}

function registerCliBackendsForTest(): void {
  const backends = [
    {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    },
    {
      id: "google-gemini-cli",
      modelProvider: "google",
      pluginId: "google",
      config: { command: "gemini" },
      bundleMcp: false,
    },
  ] as const;
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend }) => {
      const resolved = backends.find((entry) => entry.id === backend);
      return resolved ? { pluginId: resolved.pluginId, backend: resolved } : undefined;
    },
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [...backends],
  });
}

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

const runEmbeddedAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: (params: TestModelFallbackRunnerParams) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/embedded-agent.js", () => {
  return {
    compactEmbeddedAgentSession: (
      ...args: Parameters<
        typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession
      >
    ) => compactState.compactEmbeddedAgentSessionMock(...args),
    runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
    abortEmbeddedAgentRun: (sessionId: string) => {
      abortEmbeddedAgentRunMock(sessionId);
      return abortEmbeddedAgentRun(sessionId);
    },
    isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActive(sessionId),
  };
});

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
      const normalized = provider.trim().toLowerCase();
      return (
        normalized === "claude-cli" ||
        normalized === "google-gemini-cli" ||
        normalized === "codex-cli"
      );
    },
  };
});

vi.mock("../../agents/thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/thinking-runtime.js")>();
  return {
    ...actual,
    resolveCandidateThinkingLevel: (
      params: Parameters<typeof actual.resolveCandidateThinkingLevel>[0],
    ) => params.level,
    resolveEffectiveAgentRuntime: () => "openclaw",
  };
});

vi.mock("../../runtime.js", () => {
  return {
    defaultRuntime: {
      log: vi.fn(),
      error: (...args: unknown[]) => runtimeErrorMock(...args),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", () => {
  return {
    admitFollowupRunLifecycle: vi.fn(async () => {}),
    enqueueFollowupRun: vi.fn(),
    parkSteerCandidate: vi.fn(() => ({
      admit: async () => "steer",
      accepted: vi.fn(),
      fallback: vi.fn(),
      consume: vi.fn(),
    })),
    resolveFollowupAbortSignal: vi.fn(() => undefined),
    scheduleFollowupDrain: vi.fn(),
    clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
  };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

// Dedicated suites cover these sidecars; misc runner cases keep them inert to avoid unrelated graphs.
vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));

vi.mock("./followup-runner.js", () => ({
  createFollowupRunner: () => vi.fn(async () => undefined),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => {
  const resolveCronPath = (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json";
  return {
    loadCronJobsStore: (...args: unknown[]) => loadCronStoreMock(...args),
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
    resolveCronJobsStorePath: resolveCronPath,
    resolveCronStorePath: resolveCronPath,
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    getSwarmRunByLaunchReplayKey: () => undefined,
    markSubagentRunTerminated: () => 0,
  };
});
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
}));

// #85714: keep the real private-final decision but spy the WARN emitter so we
// can assert it fires only through the substantive text suppression branch.
const warnPrivateFinalSpy = vi.hoisted(() => vi.fn());
vi.mock("./private-message-tool-final.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./private-message-tool-final.js")>();
  return { ...actual, warnPrivateMessageToolFinal: warnPrivateFinalSpy };
});

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = TestModelFallbackRunnerParams;

type BaseRunOptions = {
  context?: Parameters<typeof createTestTemplateContext>[0];
  followup?: Partial<Omit<Parameters<typeof createTestQueuedFollowupRun>[0], "run">>;
  run?: Parameters<typeof createTestQueuedFollowupRun>[0]["run"];
  reply?: Partial<
    Omit<
      Parameters<typeof runReplyAgent>[0],
      "followupRun" | "resolvedQueue" | "sessionCtx" | "typing"
    >
  >;
};

function createBaseRun(options: BaseRunOptions = {}) {
  const sessionKey = options.run?.sessionKey ?? "main";
  const messageProvider = options.run?.messageProvider ?? "whatsapp";
  const typing = createMockTypingController();
  const sessionCtx = createTestTemplateContext(
    options.context ?? {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    },
  );
  const resolvedQueue = createTestQueueSettings({ mode: "interrupt" });
  const followupRun = createTestQueuedFollowupRun({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    ...options.followup,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider,
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "claude-cli", id: "opus-4.5", input: ["text", "image"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text", "image"] },
        { provider: "google", id: "gemini-2.5-pro", input: ["text", "image"] },
        { provider: "google-gemini-cli", id: "gemini-3", input: ["text", "image"] },
        {
          provider: "amazon-bedrock",
          id: "us.anthropic.claude-sonnet-4-6",
          input: ["text", "image"],
        },
      ],
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      ...options.run,
    },
  });
  const replyParams = {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    ...options.reply,
  } satisfies Parameters<typeof runReplyAgent>[0];
  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun,
    run: () => runReplyAgent(replyParams),
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function expectReplyText(result: unknown, text: string): void {
  expectRecordFields(result, { text }, "reply result");
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

function firstMockCallArg(mock: MockCallSource, label: string): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} to have at least one call`);
  }
  return call[0];
}

function setupAgentRunnerMocks(): void {
  rootDir = tempDirs.make("openclaw-run-reply-agent-");
  vi.useRealTimers();
  registerCliBackendsForTest();
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedAgentMock.mockReset();
  warnPrivateFinalSpy.mockClear();
  runCliAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runtimeErrorMock.mockReset();
  abortEmbeddedAgentRunMock.mockClear();
  compactState.compactEmbeddedAgentSessionMock.mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  clearSessionQueuesMock.mockReset();
  clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  vi.mocked(enqueueFollowupRun).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  loadCronStoreMock.mockReset();
  // Default: no cron jobs in store.
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });

  // Default: no provider switch; execute the chosen provider+model.
  runWithModelFallbackMock.mockImplementation(async (params: RunWithModelFallbackParams) => ({
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }));
}

beforeEach(setupAgentRunnerMocks);

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  vi.useRealTimers();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

describe("runReplyAgent pending operator input", () => {
  it("refuses an unbound question without falling through to active-run queueing", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "answered" }));
    const reservation = registerPendingAgentQuestion({
      questionId: "ask_direct_cli_answer",
      sessionKey: "main",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [{ label: "Blue" }, { label: "Green" }],
        },
      ],
      gatewayCall,
      answer: Promise.resolve({ status: "pending" }),
    });
    reservation.attachRegistration(Promise.resolve({ id: "ask_direct_cli_answer" }));
    const replyOperationRunState = {};
    const testRun = createBaseRun({
      context: { agentText: "Green" },
      followup: { transcriptPrompt: "Green" },
      reply: {
        commandBody: "Green",
        transcriptCommandBody: "Green",
        sessionKey: "main",
        isActive: true,
        shouldSteer: true,
        opts: { [REPLY_OPERATION_RUN_STATE]: replyOperationRunState },
      },
    });

    try {
      await expect(testRun.run()).resolves.toEqual({
        text: expect.stringContaining("pending question has no prepared creator authority"),
        isError: true,
      });
      expect(gatewayCall).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).not.toHaveBeenCalled();
      expect(testRun.typing.cleanup).toHaveBeenCalledOnce();
      expect(replyOperationRunState).toEqual({
        admission: { status: "skipped", reason: "question-response-refused" },
      });
    } finally {
      reservation.dispose();
    }
  });
});

describe("runReplyAgent auto-compaction token update", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await replaceSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      params.entry as unknown as SessionEntry,
    );
  }

  async function runEmptyDirectReply(
    agentResult: Record<string, unknown>,
    options?: {
      agentEvents?: Array<{ stream: string; data: Record<string, unknown> }>;
      config?: OpenClawConfig;
      onBlockReply?: (payload: unknown) => Promise<void> | void;
      onAgentRunTerminalOutcome?: (outcome: "completed" | "failed") => void;
    },
  ) {
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };
    const resultMeta = requireRecord(agentResult.meta, "agent result meta");
    const agentMeta = requireRecord(resultMeta.agentMeta, "agent result agent meta");
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const onAgentEvent = requireRecord(params, "embedded agent params").onAgentEvent;
      if (typeof onAgentEvent === "function") {
        for (const event of options?.agentEvents ?? []) {
          await onAgentEvent(event);
        }
      }
      return {
        payloads: [],
        ...agentResult,
        meta: {
          ...resultMeta,
          agentMeta: {
            provider: "anthropic",
            model: "claude",
            ...agentMeta,
          },
          finalAssistantVisibleText: "",
        },
      };
    });

    return createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        config: options?.config ?? {},
        reasoningLevel: "on",
      },
      reply: {
        opts: {
          onBlockReply: options?.onBlockReply,
          onAgentRunTerminalOutcome: options?.onAgentRunTerminalOutcome,
        },
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
      },
    }).run();
  }

  async function runBaseReplyWithAgentMeta(params: {
    agentMeta: Record<string, unknown>;
    collectDiagnostics?: boolean;
    config?: OpenClawConfig;
    tmpPrefix: string;
    workspaceDir?: string;
  }) {
    const tmp = tempDirs.make(params.tmpPrefix);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: params.agentMeta,
      },
    });

    const diagnostics: DiagnosticEventPayload[] = [];
    const unsubscribe = params.collectDiagnostics
      ? onInternalDiagnosticEvent((event) => {
          diagnostics.push(event);
        })
      : undefined;
    const baseRun = createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        config: params.config ?? {},
        reasoningLevel: "on",
        workspaceDir: params.workspaceDir ?? rootDir,
      },
      reply: {
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
      },
    });

    try {
      await baseRun.run();
    } finally {
      unsubscribe?.();
    }

    const persisted = loadSessionEntry({ storePath, sessionKey });
    const stored = persisted ? { [sessionKey]: persisted } : {};
    const usageEvent = diagnostics.find((event) => event.type === "model.usage");
    return { sessionKey, stored, usageEvent };
  }

  it("updates totalTokens from lastCallUsage even without compaction", async () => {
    const { sessionKey, stored } = await runBaseReplyWithAgentMeta({
      tmpPrefix: "openclaw-usage-last-",
      agentMeta: {
        // Tool-use loop: accumulated input is higher than last call's input
        usage: { input: 75_000, output: 5_000, total: 80_000 },
        lastCallUsage: { input: 55_000, output: 2_000, total: 57_000 },
      },
    });

    // totalTokens should use lastCallUsage (55k), not accumulated (75k)
    expect(stored[sessionKey as keyof typeof stored]?.totalTokens).toBe(55_000);
  }, 180_000);

  it("keeps an unarmed preflight drain visible instead of dropping the reply", async () => {
    const tmp = tempDirs.make("openclaw-preflight-drain-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: true,
      totalTokensVersion: 1 as const,
    };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    compactState.compactEmbeddedAgentSessionMock.mockRejectedValueOnce(new GatewayDrainingError());

    const result = await createBaseRun({
      run: { agentId: "main", agentDir: path.join(rootDir, "agent"), reasoningLevel: "on" },
      reply: {
        queueKey: sessionKey,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
      },
    }).run();

    expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expectReplyText(result, "⚠️ Gateway is restarting. Please wait a few seconds and try again.");
  });

  it.each([
    { preempted: false, retiredGateway: false },
    { preempted: true, retiredGateway: false },
    { preempted: false, retiredGateway: true },
    { preempted: false, retiredGateway: false, compactAfterFlush: true },
  ])(
    "defers optional memory until real delivery settles ($preempted, retired=$retiredGateway, compact=$compactAfterFlush)",
    async ({ preempted, retiredGateway, compactAfterFlush = false }) => {
      const tmp = tempDirs.make("openclaw-early-flush-");
      const logPath = path.join(tmp, "maintenance.log");
      setLoggerOverride({ level: "debug", consoleLevel: "silent", file: logPath });
      const storePath = path.join(tmp, "sessions.json");
      const sessionKey = "agent:main:main";
      const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 10_920,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        compactionCount: 0,
      };
      const prompt = "What is two plus two? Answer in one short sentence without tools.";
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "session",
        resetTriggered: false,
      });
      const delivery = createDeferred();
      const requestBudget = {
        contextWindow: 32_768,
        reserveTokens: 8_192,
        fixedTokens: 9_500,
        pendingTokens: 512,
        pendingUserIdempotencyKey: "processed-user",
      };
      let memoryParams: RunEmbeddedAgentInternalParams | undefined;
      let memoryScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
      let gatewayActive = true;
      const gatewayContext = {
        terminalSessions: {},
        resolveGatewayContext: () => (gatewayActive ? gatewayContext : undefined),
      } as never;
      const resolveGatewayContext = () => gatewayContext;
      let releaseForeground: (() => void) | undefined;
      const config: OpenClawConfig = {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://example.test",
              models: [
                {
                  id: "claude-opus-4-6",
                  name: "Test model",
                  contextTokens: 32_768,
                  reasoning: false,
                  input: ["text"],
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      registerMemoryFlushPlanResolverForTest(({ cfg, contextWindowTokens }) => {
        expect(cfg?.models?.providers?.anthropic?.models).toMatchObject([
          { id: "claude-opus-4-6", contextTokens: 32_768 },
        ]);
        expect(contextWindowTokens).toBe(32_768);
        return {
          softThresholdTokens: 4_000,
          reserveTokensFloor: 20_000,
          forceFlushTranscriptBytes: 1_000_000_000,
          prompt: "Pre-compaction memory flush.",
          systemPrompt: "Write durable memory, then reply NO_REPLY.",
          relativePath: "memory/active.md",
        };
      });
      // The usage counters are from bounded QA metadata. This assembled prompt and
      // transcript are synthetic; their estimates are not an observed second-turn budget.
      const terminalMessage = (input: number, output: number) =>
        makeAssistantMessageFixture({
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
          errorMessage: undefined,
          usage: {
            input,
            output,
            totalTokens: input + output,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
      runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.config?.models?.providers?.anthropic?.models).toEqual(
          config.models?.providers?.anthropic?.models,
        );
        if (params.trigger === "memory") {
          memoryParams = params;
          memoryScope = getPluginRuntimeGatewayRequestScope();
          const privateTranscript = expectDefined(params.sessionManager, "memory transcript");
          expect(privateTranscript.getSessionTarget()).toBeUndefined();
          privateTranscript.appendMessage(terminalMessage(7_039, 34));
          return {
            payloads: [],
            meta: { agentMeta: { lastCallUsage: { input: 7_039, output: 34 } } },
          };
        }
        expect(params.prompt).toContain(prompt);
        params.onSuccessfulAuthProfile?.(undefined);
        params.onCompactionRequestBudget?.(requestBudget);
        return {
          payloads: [{ text: "Two plus two is four." }],
          meta: {
            agentMeta: {
              sessionId: "session",
              agentHarnessId: "openclaw",
              provider: "anthropic",
              model: "claude-opus-4-6",
              lastCallUsage: { input: compactAfterFlush ? 26_000 : 10_920, output: 10 },
            },
          },
        };
      });
      try {
        // Memory-flush persistence reads runtime config again; share its authoritative source
        // with the queued turn so the selected model cannot escape into real catalog discovery.
        setRuntimeConfigSnapshot(config, config);
        await replaceSessionEntry(scope, sessionEntry);
        SessionManager.open(scope, tmp).appendMessage(terminalMessage(10_920, 10));
        const turn = createBaseRun({
          followup: { prompt },
          run: {
            agentId: "main",
            agentDir: path.join(tmp, "agent"),
            sessionKey,
            sessionFile: path.join(tmp, "session.jsonl"),
            workspaceDir: tmp,
            model: "claude-opus-4-6",
            config,
            timeoutMs: 600_000,
            senderIsOwner: true,
          },
          reply: {
            commandBody: prompt,
            sessionEntry,
            sessionStore: { [sessionKey]: sessionEntry },
            sessionKey,
            storePath,
            replyOperation: operation,
          },
        });
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            resolveGatewayContext,
            nodePlacementGrantAuthority: {
              agentId: "main",
              sessionKey,
              runId: "foreground",
              assertCurrent: () => {},
            },
          },
          turn.run,
        );

        expect(compactState.compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
        expect(runtimeErrorMock).not.toHaveBeenCalled();
        expect(runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger)).toEqual(["user"]);
        expectReplyText(result, "Two plus two is four.");
        expect(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        let maintenanceSettled = false;
        const maintenance = waitForSessionMaintenance(sessionKey).then(() => {
          maintenanceSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(maintenanceSettled).toBe(false);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        operation.completeWithAfterClearBarrier(delivery.promise, 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger)).toEqual(["user"]);
        if (preempted) {
          releaseForeground = await beginForegroundSessionMaintenance(sessionKey);
        }
        vi.useRealTimers();
        const completion = getReplyPayloadMetadata(
          expectDefined(Array.isArray(result) ? result[0] : result, "delivered reply"),
        )?.pendingFinalDeliveryCompletion;
        expect(completion).toBeDefined();
        await settlePendingFinalDelivery({ kind: "pending-final", ...completion! }, "delivered");
        await clearPendingFinalDeliveryAfterSuccess(completion);
        gatewayActive = !retiredGateway;
        delivery.resolve();
        await operation.ownerSettlement;
        await maintenance;
        await flushLogger();
        const diagnostic = await fs.readFile(logPath, "utf8");
        expect(
          runEmbeddedAgentMock.mock.calls.map(([params]) => params.trigger),
          diagnostic,
        ).toEqual(preempted || retiredGateway ? ["user"] : ["user", "memory"]);
        if (preempted || retiredGateway) {
          expect(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        } else {
          expect(memoryParams?.senderIsOwner).toBe(false);
          expect(memoryScope?.nodePlacementGrantAuthority).toBeUndefined();
          expect(memoryScope?.resolveGatewayContext?.()).toBe(gatewayContext);
          expect(loadSessionEntry(scope)?.memoryFlush).toMatchObject({
            kind: "succeeded",
            compactionCount: 0,
          });
          if (compactAfterFlush) {
            expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledWith(
              expect.objectContaining({ trigger: "budget" }),
              expect.objectContaining({
                requestBudget: { ...requestBudget, pendingTokens: 0 },
              }),
            );
          }
        }
      } finally {
        vi.useRealTimers();
        delivery.resolve();
        operation.complete();
        releaseForeground?.();
        await waitForSessionMaintenance(sessionKey);
        setLoggerOverride(null);
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["without side effects", { meta: { agentMeta: {} } }, true],
    [
      "with only a reply directive",
      { payloads: [{ text: "[[reply_to_current]]" }], meta: { agentMeta: {} } },
      true,
    ],
    ["after hidden compaction", { meta: { agentMeta: { compactionCount: 1 } } }, true],
    [
      "after an intentional terminal tool batch",
      { meta: { agentMeta: {}, intentionalTerminalCompletion: "tool-batch" } },
      false,
    ],
  ] satisfies Array<[string, Record<string, unknown>, boolean]>)(
    "accounts for empty interactive direct replies %s",
    async (_label, agentResult, fallback) => {
      const onAgentRunTerminalOutcome = vi.fn();
      const result = await runEmptyDirectReply(agentResult, { onAgentRunTerminalOutcome });
      expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith(fallback ? "failed" : "completed");
      if (!fallback) {
        expect(result).toBeUndefined();
        return;
      }
      const payload = expectRecordFields(result, { isError: true }, "empty interactive fallback");
      expect(payload.text).toContain("did not produce a visible reply");
    },
  );

  it("threads the empty interactive direct fallback through normal final preparation", async () => {
    const result = await runEmptyDirectReply(
      { meta: { agentMeta: {} } },
      { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    );

    const payload = expectRecordFields(result, { isError: true }, "empty interactive fallback");
    expect(payload.replyToId).toBe("msg");
  });

  it.each([
    ["reasoning", { text: "internal reasoning", isReasoning: true }],
    ["commentary", { text: "internal commentary", isCommentary: true }],
  ])("surfaces a fallback for disabled %s-only direct output", async (_label, payload) => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply(
      {
        payloads: [payload],
        meta: { agentMeta: {} },
      },
      { onBlockReply },
    );

    const fallback = expectRecordFields(result, { isError: true }, "empty interactive fallback");
    expect(fallback.text).toContain("did not produce a visible reply");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps spawn-only empty direct replies silent", async () => {
    expect(
      await runEmptyDirectReply({
        acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:child" }],
        meta: { agentMeta: {} },
      }),
    ).toBeUndefined();
  });

  it("surfaces terminal direct failures after runtime compaction progress", async () => {
    const onBlockReply = vi.fn();
    const result = await runEmptyDirectReply(
      {
        meta: {
          agentMeta: {},
          error: { kind: "tool_result_mismatch", message: "terminal failure after notice" },
        },
      },
      {
        agentEvents: [
          { stream: "compaction", data: { phase: "start" } },
          { stream: "compaction", data: { phase: "end", completed: true } },
        ],
        config: {
          agents: { defaults: { compaction: { notifyUser: true } } },
        },
        onBlockReply,
      },
    );

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expectRecordFields(result, { isError: true }, "terminal failure");
  });

  it("surfaces empty direct replies when runtime compaction notice delivery fails", async () => {
    const result = await runEmptyDirectReply(
      { meta: { agentMeta: {} } },
      {
        agentEvents: [{ stream: "compaction", data: { phase: "start" } }],
        config: {
          agents: { defaults: { compaction: { notifyUser: true } } },
        },
        onBlockReply: vi.fn().mockRejectedValue(new Error("delivery failed")),
      },
    );

    const payload = expectRecordFields(result, { isError: true }, "empty interactive fallback");
    expect(payload.text).toContain("did not produce a visible reply");
  });

  it("starts queued followup drain only after clearing the active reply operation", async () => {
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: {} },
    });

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    });

    const result = await createBaseRun({
      run: { agentId: "main", agentDir: path.join(rootDir, "agent"), reasoningLevel: "on" },
      reply: {
        queueKey: sessionKey,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
      },
    }).run();

    expectReplyText(result, "ok");
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });

  it("loads post-compaction context before starting a queued followup drain", async () => {
    const workspaceDir = tempDirs.make("openclaw-post-compaction-queued-followup-");
    try {
      await fs.writeFile(
        path.join(workspaceDir, "AGENTS.md"),
        "## Session Startup\nRead the queued workspace startup file.\n\n## Red Lines\nNever skip startup context after compaction.\n",
        "utf-8",
      );
      const sessionKey = "main";
      const sessionEntry = { sessionId: "session", updatedAt: Date.now(), totalTokens: 50_000 };
      runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
        const onAgentEvent = requireRecord(params, "embedded agent params").onAgentEvent;
        if (typeof onAgentEvent === "function") {
          await onAgentEvent({ stream: "compaction", data: { phase: "start" } });
          await onAgentEvent({ stream: "compaction", data: { phase: "end", completed: true } });
        }
        return { payloads: [{ text: "ok" }], meta: { agentMeta: {} } };
      });

      vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
        const events = peekSystemEvents(key);
        expect(events).toHaveLength(1);
        expect(events[0]).toContain("Read the queued workspace startup file.");
        expect(events[0]).toContain("Never skip startup context after compaction.");
      });

      const baseRun = createBaseRun({
        run: {
          agentId: "main",
          agentDir: path.join(rootDir, "agent"),
          workspaceDir,
          reasoningLevel: "on",
          config: {
            agents: {
              defaults: {
                compaction: { postCompactionSections: ["Session Startup", "Red Lines"] },
              },
            },
          },
        },
        reply: {
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
        },
      });

      await baseRun.run();

      expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps a provided reply operation active until final delivery completes", async () => {
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: sessionEntry.sessionId,
      resetTriggered: false,
    });
    const deliveryOrder: string[] = [];
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: {} },
    });

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      deliveryOrder.push("followup");
    });

    const result = await createBaseRun({
      run: { agentId: "main", agentDir: path.join(rootDir, "agent"), reasoningLevel: "on" },
      reply: {
        queueKey: sessionKey,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        replyOperation,
      },
    }).run();

    expectReplyText(result, "ok");
    expect(replyRunRegistry.get(sessionKey)).toBe(replyOperation);
    expect(replyOperation.result).toBeNull();
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    deliveryOrder.push("final");
    replyOperation.complete();

    expect(deliveryOrder).toEqual(["final", "followup"]);
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "its upstream signal",
      superseded: false,
      expectedCode: "aborted_by_user" as const,
    },
    {
      label: "a visible-turn supersession",
      superseded: true,
      expectedCode: "aborted_for_supersession" as const,
    },
  ])(
    "records a settled fallback cancelled by $label without losing committed compaction",
    async ({ superseded, expectedCode }) => {
      const root = tempDirs.make("openclaw-aborted-compaction-");
      const storePath = path.join(root, "sessions.json");
      const upstreamAbort = new AbortController();
      const sessionKey = `${superseded ? "superseded" : "upstream-cancelled"}-settled-fallback`;
      const sessionEntry = {
        sessionId: "session-upstream-cancelled",
        lifecycleRevision: "original-generation",
        updatedAt: Date.now(),
        compactionCount: 3,
        totalTokens: 50_000,
      };
      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
      const replyOperation = createReplyOperation({
        sessionKey,
        sessionId: sessionEntry.sessionId,
        resetTriggered: false,
        upstreamAbortSignal: upstreamAbort.signal,
      });
      let releaseFallback: () => void = () => undefined;
      let markCandidateSettled: () => void = () => undefined;
      const candidateSettled = new Promise<void>((resolve) => {
        markCandidateSettled = resolve;
      });
      const fallbackRelease = new Promise<void>((resolve) => {
        releaseFallback = resolve;
      });
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          params.onCompactionAccounting?.({
            kind: "durable",
            count: 1,
            currentContextSnapshot: { tokens: 40 },
            target: {
              agentId: "main",
              sessionId: sessionEntry.sessionId,
              sessionKey,
              storePath,
              lifecycleRevision: sessionEntry.lifecycleRevision,
              activeWriterRunId: undefined,
            },
          });
          return {
            payloads: [{ text: "late reply" }],
            meta: { agentMeta: { compactionCount: 1, compactionTokensAfter: 40 } },
          };
        },
      );
      runWithModelFallbackMock.mockImplementationOnce(
        async (params: RunWithModelFallbackParams) => {
          const result = await runInitialModelFallbackAttempt(params);
          markCandidateSettled();
          await fallbackRelease;
          return { result, provider: params.provider, model: params.model, attempts: [] };
        },
      );
      const baseRun = createBaseRun({
        run: {
          agentId: "main",
          agentDir: path.join(rootDir, "agent"),
          sessionId: sessionEntry.sessionId,
          sessionKey,
          reasoningLevel: "on",
        },
        reply: {
          queueKey: sessionKey,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
          replyOperation,
        },
      });

      try {
        const pending = baseRun.run();
        await candidateSettled;
        if (superseded) {
          replyOperation.supersede();
        } else {
          upstreamAbort.abort(new Error("caller cancelled"));
        }
        releaseFallback();

        expectReplyText(await pending, SILENT_REPLY_TOKEN);
        expect(replyOperation.result).toEqual({ kind: "aborted", code: expectedCode });
        expect(
          loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId: sessionEntry.sessionId,
          lifecycleRevision: "original-generation",
          compactionCount: 4,
          totalTokens: 40,
          totalTokensFresh: true,
        });
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      } finally {
        releaseFallback();
        replyOperation.complete();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reports live diagnostic context from promptTokens, not provider usage totals", async () => {
    const { sessionKey, stored, usageEvent } = await runBaseReplyWithAgentMeta({
      tmpPrefix: "openclaw-usage-diagnostic-",
      collectDiagnostics: true,
      agentMeta: {
        usage: { input: 75_000, output: 5_000, cacheRead: 25_000, total: 105_000 },
        diagnosticUsage: {
          input: 90_000,
          output: 8_000,
          cacheRead: 30_000,
          cacheWrite: 2_000,
          total: 130_000,
        },
        lastCallUsage: { input: 55_000, output: 2_000, cacheRead: 25_000, total: 82_000 },
        promptTokens: 44_000,
      },
    });

    const usagePayload = expectRecordFields(
      usageEvent,
      {
        type: "model.usage",
        agentId: "main",
      },
      "usage diagnostic event",
    );
    expectRecordFields(
      usagePayload.usage,
      {
        input: 90_000,
        output: 8_000,
        cacheRead: 30_000,
        cacheWrite: 2_000,
        promptTokens: 122_000,
        total: 130_000,
      },
      "usage diagnostic usage",
    );
    expectRecordFields(
      usagePayload.context,
      {
        limit: 200_000,
        used: 44_000,
      },
      "usage diagnostic context",
    );
    expect(stored[sessionKey as keyof typeof stored]?.totalTokens).toBe(44_000);
  });

  it.each([0, 0.25])(
    "preserves cost-only total %s in reply diagnostics and persistence",
    async (total) => {
      const { sessionKey, stored, usageEvent } = await runBaseReplyWithAgentMeta({
        tmpPrefix: "openclaw-usage-diagnostic-cost-only-",
        collectDiagnostics: true,
        agentMeta: { usage: { cost: { total } } },
      });

      expect(usageEvent).toMatchObject({ type: "model.usage", costUsd: total });
      expect(usageEvent).not.toHaveProperty("context.used");
      const entry = stored[sessionKey as keyof typeof stored];
      expect(entry?.estimatedCostUsd).toBe(total);
      for (const key of ["inputTokens", "outputTokens", "cacheRead", "cacheWrite"] as const) {
        expect(entry?.[key]).toBeUndefined();
      }
      expect(entry?.totalTokensFresh).not.toBe(true);
    },
  );

  it("falls back to last-call prompt usage for live diagnostic context", async () => {
    const { usageEvent } = await runBaseReplyWithAgentMeta({
      tmpPrefix: "openclaw-usage-diagnostic-last-",
      collectDiagnostics: true,
      agentMeta: {
        usage: { input: 75_000, output: 5_000, cacheRead: 25_000, total: 105_000 },
        lastCallUsage: {
          input: 55_000,
          output: 2_000,
          cacheRead: 25_000,
          cacheWrite: 1_000,
          total: 83_000,
        },
      },
    });

    const usagePayload = expectRecordFields(
      usageEvent,
      {
        type: "model.usage",
      },
      "usage diagnostic event",
    );
    expectRecordFields(
      usagePayload.usage,
      {
        input: 75_000,
        output: 5_000,
        cacheRead: 25_000,
        promptTokens: 100_000,
        total: 105_000,
      },
      "usage diagnostic usage",
    );
    expectRecordFields(
      usagePayload.context,
      {
        limit: 200_000,
        used: 81_000,
      },
      "usage diagnostic context",
    );
  });

  it("does not treat diagnostic compaction metadata as a context-refresh trigger", async () => {
    const workspaceDir = tempDirs.make("openclaw-post-compaction-workspace-");
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Read the queued workspace startup file.",
        "",
        "## Red Lines",
        "Never use the process cwd for this refresh.",
      ].join("\n"),
      "utf-8",
    );

    const { sessionKey } = await runBaseReplyWithAgentMeta({
      tmpPrefix: "openclaw-post-compaction-workspace-root-",
      workspaceDir,
      config: {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["Session Startup", "Red Lines"] },
          },
        },
      },
      agentMeta: {
        compactionCount: 1,
        lastCallUsage: { input: 10_000, output: 500, total: 10_500 },
      },
    });

    // agentMeta.compactionCount is diagnostic metadata from the harness result;
    // post-compaction context refresh belongs to runner-owned compaction paths.
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });
});

describe("runReplyAgent block streaming", () => {
  it("coalesces duplicate text_end block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Hello" });
      block?.({ text: "Hello" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const result = await createBaseRun({
      context: {
        Provider: "discord",
        OriginatingTo: "channel:C1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        messageProvider: "discord",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
        thinkLevel: "low",
        reasoningLevel: "on",
        blockReplyBreak: "text_end",
      },
      reply: {
        opts: { onBlockReply },
        blockStreamingEnabled: true,
        blockReplyChunking: {
          minChars: 1,
          maxChars: 200,
          breakPreference: "paragraph",
        },
        resolvedBlockStreamingBreak: "text_end",
      },
    }).run();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect((firstMockCallArg(onBlockReply, "block reply") as { text?: string }).text).toBe("Hello");
    // The block pipeline streamed "Hello" but never sent "Final message",
    // so the unsent text-only final is preserved (not dropped).
    expect(result).toBeDefined();
    expect((result as { text?: string }).text).toBe("Final message");
  });

  it("returns the final payload when onBlockReply times out", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const blockReplyStarted = createDeferred();

    const onBlockReply = vi.fn((_payload, context) => {
      return new Promise<void>((resolve) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
        blockReplyStarted.resolve();
      });
    });

    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Chunk" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const resultPromise = createBaseRun({
      context: {
        Provider: "discord",
        OriginatingTo: "channel:C1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        messageProvider: "discord",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
        thinkLevel: "low",
        reasoningLevel: "on",
        blockReplyBreak: "text_end",
      },
      reply: {
        opts: { onBlockReply, blockReplyTimeoutMs: 1 },
        blockStreamingEnabled: true,
        blockReplyChunking: {
          minChars: 1,
          maxChars: 200,
          breakPreference: "paragraph",
        },
        resolvedBlockStreamingBreak: "text_end",
      },
    }).run();

    await blockReplyStarted.promise;
    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expectReplyText(result, "Final message");
  });
});

describe("runReplyAgent inline tool verbosity", () => {
  it.each([
    { stored: "off", override: "full", expected: ["Tool summary", "Tool output"] },
    { stored: "full", override: "off", expected: [] },
    { stored: "full", override: "on", expected: ["Tool summary"] },
  ] as const)(
    "delivers tool progress with inline $override over stored $stored",
    async ({ stored, override, expected }) => {
      const storePath = path.join(rootDir, "sessions.json");
      const sessionKey = "main";
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        verboseLevel: stored,
      };
      await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
      const onToolResult = vi.fn(async (_payload: ReplyPayload) => {});
      const onRunVerbosityResolved = vi.fn();
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          expect(onRunVerbosityResolved).toHaveBeenCalledExactlyOnceWith({
            verboseLevelOverride: override,
            resolvedVerboseLevel: override,
          });
          if (params.shouldEmitToolResult?.()) {
            await params.onToolResult?.({ text: "Tool summary" });
          }
          if (params.shouldEmitToolOutput?.()) {
            await params.onToolResult?.({ text: "Tool output" });
          }
          return { payloads: [{ text: "Done" }], meta: {} };
        },
      );
      const result = await createBaseRun({
        run: { sessionKey, verboseLevel: override, verboseLevelOverride: override },
        reply: {
          sessionKey,
          storePath,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          resolvedVerboseLevel: override,
          opts: { onToolResult, onRunVerbosityResolved },
        },
      }).run();
      expect(onToolResult.mock.calls.map(([payload]) => payload.text)).toEqual(expected);
      expect(loadSessionEntry({ storePath, sessionKey })?.verboseLevel).toBe(stored);
      expectReplyText(result, "Done");
    },
  );
});

describe("runReplyAgent Active Memory inline debug", () => {
  // Seeds the plugin-owned debug rows through the canonical session accessor.
  async function writeActiveMemoryDebugEntry(params: {
    sessionEntry: SessionEntry;
    sessionKey: string;
    storePath: string;
  }): Promise<void> {
    await replaceSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      {
        ...params.sessionEntry,
        pluginDebugEntries: [
          {
            pluginId: "active-memory",
            lines: [
              "🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars",
              "🔎 Active Memory Debug: Lemon pepper wings with blue cheese.",
            ],
          },
        ],
      },
    );
  }

  async function runActiveMemoryDebugCase(
    sessionEntry: SessionEntry,
    options: {
      run?: BaseRunOptions["run"];
      liveTraceLevel?: SessionEntry["traceLevel"];
      resolvedVerboseLevel?: VerboseLevel;
    } = {},
  ) {
    const tmp = tempDirs.make("openclaw-active-memory-inline-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const resolvedVerboseLevel =
      options.resolvedVerboseLevel ?? normalizeVerboseLevel(sessionEntry.verboseLevel) ?? "off";
    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      await writeActiveMemoryDebugEntry({
        sessionEntry: {
          ...sessionEntry,
          traceLevel: options.liveTraceLevel ?? sessionEntry.traceLevel,
        },
        sessionKey,
        storePath,
      });
      return {
        payloads: [{ text: "Normal reply" }],
        meta: { requestShaping: { trace: sessionEntry.traceLevel } },
      };
    });
    const result = await createBaseRun({
      context: {
        Provider: "telegram",
        OriginatingTo: "chat:1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        agentId: "main",
        sessionKey,
        messageProvider: "telegram",
        traceAuthorized: true,
        thinkLevel: "low",
        verboseLevel: resolvedVerboseLevel,
        ...options.run,
      },
      reply: {
        queueKey: sessionKey,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
        resolvedVerboseLevel,
      },
    }).run();
    expect(loadSessionEntry({ storePath, sessionKey })?.traceLevel).toBe(
      options.liveTraceLevel ?? sessionEntry.traceLevel,
    );
    return result;
  }

  it.each([
    { stored: "off", override: "on", authorized: true, trace: true, raw: false },
    { stored: "on", override: "off", authorized: true, trace: false, raw: false },
    { stored: "off", override: "raw", authorized: true, trace: true, raw: true },
    { stored: "raw", override: "off", authorized: true, trace: false, raw: false },
    { stored: "raw", override: "on", authorized: true, trace: true, raw: false },
    { stored: "off", override: "on", authorized: false, trace: false, raw: false },
    { stored: "raw", override: "raw", authorized: false, trace: false, raw: false },
  ] as const)(
    "honors turn trace $override over stored $stored with authorization=$authorized",
    async ({ stored, override, authorized, trace, raw }) => {
      const result = await runActiveMemoryDebugCase(
        { sessionId: "session", updatedAt: Date.now(), traceLevel: stored },
        { run: { traceLevelOverride: override, traceAuthorized: authorized } },
      );
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).toContain("Normal reply");
      expect(text.includes("Active Memory Debug:")).toBe(trace);
      expect(text.includes("Model Input (User Role)")).toBe(raw);
      if (raw) {
        expect(text).toContain("trace=raw");
      }
    },
  );

  it.each([
    { stored: "off", live: "on", override: undefined, trace: true },
    { stored: "on", live: "off", override: undefined, trace: false },
    { stored: "off", live: "on", override: "off", trace: false },
    { stored: "on", live: "off", override: "on", trace: true },
  ] as const)(
    "uses live session trace $live after $stored unless turn override is $override",
    async ({ stored, live, override, trace }) => {
      const result = await runActiveMemoryDebugCase(
        { sessionId: "session", updatedAt: Date.now(), traceLevel: stored },
        { run: { traceLevelOverride: override }, liveTraceLevel: live },
      );
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text.includes("Active Memory Debug:")).toBe(trace);
    },
  );

  it.each([
    { stored: "off", selected: "on", traceLevel: "off", status: true },
    { stored: "on", selected: "off", traceLevel: "raw", status: false },
  ] as const)(
    "selects plugin status using turn verbosity $selected over stored $stored",
    async ({ stored, selected, traceLevel, status }) => {
      const result = await runActiveMemoryDebugCase(
        { sessionId: "session", updatedAt: Date.now(), verboseLevel: stored, traceLevel },
        { resolvedVerboseLevel: selected, run: { verboseLevelOverride: selected } },
      );
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text.includes("🧩 Active Memory: status=ok")).toBe(status);
      expect(text.includes("Model Input (User Role)")).toBe(traceLevel === "raw");
    },
  );

  function runRawTraceCase(params: {
    commandBody: string;
    reasoningLevel?: "off" | "on";
    senderIsOwner?: boolean;
    sessionEntry: SessionEntry;
    sessionFile: string;
    storePath: string;
    thinkLevel: "low" | "off";
    traceAuthorized: boolean;
  }) {
    const sessionKey = "main";
    return createBaseRun({
      context: {
        Provider: "telegram",
        OriginatingTo: "chat:1",
        AccountId: "primary",
        MessageSid: "msg",
        CommandBody: params.commandBody,
      },
      run: {
        agentId: "main",
        sessionKey,
        messageProvider: "telegram",
        sessionFile: params.sessionFile,
        ...(params.senderIsOwner === undefined ? {} : { senderIsOwner: params.senderIsOwner }),
        traceAuthorized: params.traceAuthorized,
        thinkLevel: params.thinkLevel,
        ...(params.reasoningLevel ? { reasoningLevel: params.reasoningLevel } : {}),
      },
      reply: {
        queueKey: sessionKey,
        sessionEntry: params.sessionEntry,
        sessionStore: { [sessionKey]: params.sessionEntry },
        sessionKey,
        storePath: params.storePath,
      },
    }).run();
  }

  it("appends inline Active Memory status payload when verbose is enabled", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      verboseLevel: "on",
    };
    const result = await runActiveMemoryDebugCase(sessionEntry);

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[]).map((payload) => payload.text)).toEqual([
      "Normal reply",
      "🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars",
    ]);
  });

  it("appends inline Active Memory status and trace payloads when verbose and trace are enabled", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      verboseLevel: "on",
      traceLevel: "on",
    };

    const result = await runActiveMemoryDebugCase(sessionEntry);

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[]).map((payload) => payload.text)).toEqual([
      "Normal reply",
      "🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars\n🔎 Active Memory Debug: Lemon pepper wings with blue cheese.",
    ]);
  });

  it("appends inline Active Memory trace payload when only trace is enabled", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "on",
    };

    const result = await runActiveMemoryDebugCase(sessionEntry);

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[]).map((payload) => payload.text)).toEqual([
      "Normal reply",
      "🔎 Active Memory Debug: Lemon pepper wings with blue cheese.",
    ]);
  });

  it("appends raw trace payloads when trace raw is enabled", async () => {
    const tmp = tempDirs.make("openclaw-trace-raw-usage-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "raw",
      compactionCount: 3,
    };

    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          message: {
            role: "user",
            content: "Earlier turn",
            usage: { input: 400, output: 20, cacheRead: 100, cacheWrite: 50, total: 570 },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Earlier reply",
            usage: { input: 200, output: 10, cacheRead: 20, cacheWrite: 5, total: 235 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => ({
      result: await runFallbackModelAttempt(params, "anthropic", "claude", "timeout"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "LLM request timed out.",
          reason: "timeout",
          status: 408,
        },
      ],
    }));
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      params.onCompactionAccounting?.({
        kind: "durable",
        count: 1,
        currentContextSnapshot: { tokens: 1250 },
        target: {
          agentId: "main",
          sessionId: sessionEntry.sessionId,
          sessionKey,
          storePath,
          lifecycleRevision: sessionEntry.lifecycleRevision,
          activeWriterRunId: undefined,
        },
      });
      return {
        payloads: [{ text: "Visible reply" }],
        meta: {
          finalPromptText:
            "Context:\n<active_memory_plugin>\nPrefer from/to failover logs.\n</active_memory_plugin>\n\n/trace raw show me everything",
          finalAssistantVisibleText: "Visible reply",
          finalAssistantRawText: "<final>Visible reply</final>",
          executionTrace: {
            winnerProvider: "anthropic",
            winnerModel: "claude",
            runner: "embedded",
            fallbackUsed: false,
            attempts: [
              {
                provider: "anthropic",
                model: "claude",
                result: "success",
                stage: "assistant",
                elapsedMs: 4200,
              },
            ],
          },
          toolSummary: {
            calls: 2,
            tools: ["active-memory", "github-search"],
            failures: 0,
            totalToolTimeMs: 481,
          },
          completion: {
            finishReason: "stop",
            stopReason: "end_turn",
            refusal: false,
          },
          agentMeta: {
            sessionId: "session",
            provider: "anthropic",
            model: "claude",
            usage: { input: 1200, output: 45, cacheRead: 800, cacheWrite: 200, total: 2245 },
            lastCallUsage: {
              input: 1000,
              output: 45,
              cacheRead: 750,
              cacheWrite: 150,
              total: 1945,
            },
            promptTokens: 1250,
            compactionCount: 1,
          },
        },
      };
    });

    const result = await runRawTraceCase({
      commandBody: "/trace raw show me everything",
      reasoningLevel: "on",
      sessionEntry,
      sessionFile,
      storePath,
      thinkLevel: "low",
      traceAuthorized: true,
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[])[0]?.text).toBe("Visible reply");
    const traceText = (result as { text?: string }[])[1]?.text ?? "";
    expect(traceText).toContain("🔎 Usage (Session Total):");
    expect(traceText).toContain("🔎 Usage (Last Turn Total):");
    expect(traceText).toContain("🔎 Context Window (Last Model Request):");
    expect(traceText).toContain("used=1,250 tok (1.3k)");
    expect(traceText).toContain("🔎 Execution Result:");
    expect(traceText).toContain("winner=anthropic/claude");
    expect(traceText).toContain("fallbackUsed=yes");
    expect(traceText).toContain("attempts=2");
    expect(traceText).toContain("runner=embedded");
    expect(traceText).toContain("🔎 Fallback Chain:");
    expect(traceText).toContain("1. openai/gpt-5.5");
    expect(traceText).toContain("result=timeout");
    expect(traceText).toContain("status=408");
    expect(traceText).toContain("2. anthropic/claude");
    expect(traceText).toContain("result=success");
    expect(traceText).toContain("🔎 Request Shaping:");
    expect(traceText).toContain("provider=anthropic");
    expect(traceText).toContain("model=claude");
    expect(traceText).toContain("thinking=low");
    expect(traceText).toContain("reasoning=on");
    expect(traceText).toContain("verbose=off");
    expect(traceText).toContain("trace=raw");
    expect(traceText).toContain("blockStreaming=message_end");
    expect(traceText).toContain("🔎 Prompt Segments:");
    expect(traceText).toContain("active_memory_plugin=");
    expect(traceText).toContain("user_message=");
    expect(traceText).toContain("totalPromptText=");
    expect(traceText).toContain("🔎 Tool Summary:");
    expect(traceText).toContain("calls=2");
    expect(traceText).toContain("tools=active-memory, github-search");
    expect(traceText).toContain("failures=0");
    expect(traceText).toContain("totalToolTimeMs=481");
    expect(traceText).toContain("🔎 Completion:");
    expect(traceText).toContain("finishReason=stop");
    expect(traceText).toContain("stopReason=end_turn");
    expect(traceText).toContain("refusal=no");
    expect(traceText).toContain("🔎 Context Management:");
    expect(traceText).toContain("sessionCompactions=4");
    expect(traceText).toContain("lastTurnCompactions=1");
    expect(traceText).toContain("🔎 Model Input (User Role):");
    expect(traceText).toContain("🔎 Model Output (Assistant Role):");
    expect(traceText).toContain(
      "Summary: winner=claude 🧠 low fallback=yes attempts=2 stop=end_turn prompt=1.3k/200k ⬇️ 1.2k ⬆️ 45 ♻️ 800 🆕 200 🔢 2.2k tools=2 compactions=1",
    );
    expect(traceText.indexOf("🔎 Execution Result:")).toBeGreaterThan(
      traceText.indexOf("🔎 Context Window (Last Model Request):"),
    );
    expect(traceText.indexOf("🔎 Fallback Chain:")).toBeGreaterThan(
      traceText.indexOf("🔎 Execution Result:"),
    );
    expect(traceText.indexOf("🔎 Request Shaping:")).toBeGreaterThan(
      traceText.indexOf("🔎 Fallback Chain:"),
    );
    expect(traceText.indexOf("🔎 Prompt Segments:")).toBeGreaterThan(
      traceText.indexOf("🔎 Request Shaping:"),
    );
    expect(traceText.indexOf("🔎 Tool Summary:")).toBeGreaterThan(
      traceText.indexOf("🔎 Prompt Segments:"),
    );
    expect(traceText.indexOf("🔎 Completion:")).toBeGreaterThan(
      traceText.indexOf("🔎 Tool Summary:"),
    );
    expect(traceText.indexOf("🔎 Context Management:")).toBeGreaterThan(
      traceText.indexOf("🔎 Completion:"),
    );
    expect(traceText.indexOf("🔎 Model Input (User Role):")).toBeGreaterThan(
      traceText.indexOf("🔎 Context Management:"),
    );
    expect(traceText.indexOf("🔎 Model Output (Assistant Role):")).toBeGreaterThan(
      traceText.indexOf("🔎 Model Input (User Role):"),
    );
    expect(traceText.indexOf("Summary: winner=claude 🧠 low")).toBeGreaterThan(
      traceText.indexOf("🔎 Model Output (Assistant Role):"),
    );
  });

  it("does not emit persisted trace output to an unauthorized sender", async () => {
    const tmp = tempDirs.make("openclaw-trace-raw-unauthorized-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "raw",
    };

    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    await fs.writeFile(sessionFile, "", "utf-8");

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible reply" }],
      meta: {
        finalPromptText: "secret prompt context",
        finalAssistantVisibleText: "Visible reply",
        finalAssistantRawText: "secret raw output",
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3, total: 15 },
        },
      },
    });

    const result = await runRawTraceCase({
      commandBody: "show me the answer",
      senderIsOwner: false,
      sessionEntry,
      sessionFile,
      storePath,
      thinkLevel: "low",
      traceAuthorized: false,
    });

    expectReplyText(result, "Visible reply");
    expect(Array.isArray(result)).toBe(false);
  });

  it("shows session and last-turn usage totals without per-call usage blocks", async () => {
    const tmp = tempDirs.make("openclaw-trace-raw-usage-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "raw",
    };

    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "Earlier reply",
          usage: { input: 20, output: 5, cacheRead: 3, total: 28 },
        },
      })}\n`,
      "utf-8",
    );

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible reply" }],
      meta: {
        finalPromptText: "/trace raw",
        finalAssistantVisibleText: "Visible reply",
        finalAssistantRawText: "Visible reply",
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          usage: { input: 34834, output: 49, cacheRead: 64, total: 34947 },
          lastCallUsage: { input: 34834, output: 49, cacheRead: 64, cacheWrite: 0, total: 34947 },
        },
      },
    });

    const result = await runRawTraceCase({
      commandBody: "/trace raw",
      sessionEntry,
      sessionFile,
      storePath,
      thinkLevel: "low",
      traceAuthorized: true,
    });

    const traceText = (Array.isArray(result) ? result[1] : result)?.text ?? "";
    expect(traceText).toContain("🔎 Usage (Session Total):");
    expect(traceText).toContain("🔎 Usage (Last Turn Total):");
    expect(traceText).not.toContain("🔎 Provider Usage (Turn Total):");
    expect(traceText).not.toContain("🔎 Provider Usage (Last Provider Call):");
  });

  it("escapes markdown fence delimiters inside raw trace blocks", async () => {
    const tmp = tempDirs.make("openclaw-trace-raw-fence-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "raw",
    };

    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
    await fs.writeFile(sessionFile, "", "utf-8");

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible reply" }],
      meta: {
        finalPromptText: "show me\n~~~\nnot a fence",
        finalAssistantVisibleText: "Visible reply",
        finalAssistantRawText: "assistant\n~~~\nresponse",
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          usage: { input: 10, output: 2, total: 12 },
        },
      },
    });

    const result = await runRawTraceCase({
      commandBody: "/trace raw",
      reasoningLevel: "off",
      sessionEntry,
      sessionFile,
      storePath,
      thinkLevel: "off",
      traceAuthorized: true,
    });

    const traceText = (result as { text?: string }[])[1]?.text ?? "";
    expect(traceText).toContain("show me\n\\~~~\nnot a fence");
    expect(traceText).toContain("assistant\n\\~~~\nresponse");
  });
});

describe("runReplyAgent claude-cli routing", () => {
  function createRun() {
    return createBaseRun({
      context: {
        Provider: "webchat",
        OriginatingTo: "session:1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        messageProvider: "webchat",
        provider: "claude-cli",
        model: "opus-4.5",
        thinkLevel: "low",
      },
      reply: { defaultModel: "claude-cli/opus-4.5" },
    }).run();
  }

  it("uses the CLI runner for claude-cli provider", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
      },
    });

    const result = await createRun();

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expectReplyText(result, "ok");
  });

  it("does not leak hook-blocked CLI input in raw trace payloads", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
          isError: true,
        },
      ],
      meta: {
        error: {
          kind: "hook_block",
          message:
            "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
        },
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
        executionTrace: {
          winnerProvider: "claude-cli",
          winnerModel: "opus-4.5",
          attempts: [
            {
              provider: "claude-cli",
              model: "opus-4.5",
              result: "error",
              reason: "before_agent_run blocked the run",
            },
          ],
          fallbackUsed: false,
          runner: "cli",
        },
      },
    });

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      traceLevel: "raw",
    } as SessionEntry;
    const result = await createBaseRun({
      context: {
        Provider: "webchat",
        OriginatingTo: "session:1",
        AccountId: "primary",
        MessageSid: "msg",
        CommandBody: "secret hitl prompt",
        RawBody: "secret hitl prompt",
        BodyForAgent: "secret hitl prompt",
        Body: "secret hitl prompt",
      },
      followup: { prompt: "secret hitl prompt", summaryLine: "secret hitl prompt" },
      run: {
        agentId: "main",
        messageProvider: "webchat",
        config: createCliBackendTestConfig(),
        traceAuthorized: true,
        provider: "claude-cli",
        model: "opus-4.5",
        thinkLevel: "low",
      },
      reply: {
        commandBody: "secret hitl prompt",
        sessionEntry,
        sessionStore: { main: sessionEntry },
        defaultModel: "claude-cli/opus-4.5",
      },
    }).run();

    const texts = Array.isArray(result)
      ? result.map((payload) => payload.text ?? "").join("\n")
      : (result?.text ?? "");
    expect(texts).toContain(
      "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
    );
    expect(texts).toContain("Summary: fallback=no attempts=1");
    expect(texts).not.toContain("winner=");
    expect(texts).toContain("Model Input (User Role):\n~~~text\n<empty>\n~~~");
    expect(texts).toContain("Model Output (Assistant Role):\n~~~text\n<empty>\n~~~");
    expect(texts).not.toContain("secret hitl prompt");
  });

  it("uses the selected CLI runtime for canonical Anthropic models", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
    });

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    } as SessionEntry;
    const result = await createBaseRun({
      context: {
        Provider: "webchat",
        OriginatingTo: "session:1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        messageProvider: "webchat",
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        },
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinkLevel: "low",
      },
      reply: { sessionEntry, defaultModel: "anthropic/claude-opus-4-7" },
    }).run();

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectRecordFields(
      firstMockCallArg(runCliAgentMock, "CLI run params"),
      { provider: "claude-cli" },
      "CLI run params",
    );
    expectReplyText(result, "ok");
  });
});

describe("runReplyAgent messaging tool dedupe", () => {
  function createRun(
    messageProvider = "slack",
    opts: { storePath?: string; sessionKey?: string } = {},
  ) {
    const sessionKey = opts.sessionKey ?? "main";
    return createBaseRun({
      context: {
        Provider: messageProvider,
        OriginatingTo: "channel:C1",
        AccountId: "primary",
        MessageSid: "msg",
      },
      run: {
        sessionKey,
        messageProvider,
        config: createCliBackendTestConfig(),
        thinkLevel: "low",
      },
      reply: { queueKey: "main", sessionKey, storePath: opts.storePath },
    }).run();
  }

  it("delivers distinct replies when a messaging tool sent via the same provider + target", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expectReplyText(result, "hello world!");
  });

  it("drops duplicate replies when a messaging tool sent the same text via the same provider + target", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toBeUndefined();
  });

  it("delivers replies when tool provider does not match", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expectReplyText(result, "hello world!");
  });

  it("keeps final reply when text matches a cross-target messaging send", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expectReplyText(result, "hello world!");
  });

  it("delivers replies when account ids do not match", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          accountId: "alt",
        },
      ],
      meta: {},
    });

    const result = await createRun("slack");

    expectReplyText(result, "hello world!");
  });
});

describe("runReplyAgent reminder commitment guard", () => {
  function createRun(params?: { sessionKey?: string; omitSessionKey?: boolean }) {
    return createBaseRun({
      context: {
        Provider: "telegram",
        OriginatingTo: "chat",
        AccountId: "primary",
        MessageSid: "msg",
        Surface: "telegram",
      },
      run: {
        messageProvider: "telegram",
        config: createCliBackendTestConfig(),
        thinkLevel: "low",
      },
      reply: params?.omitSessionKey ? {} : { sessionKey: params?.sessionKey ?? "main" },
    }).run();
  }

  it("appends guard note when reminder commitment is not backed by cron.add", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expectReplyText(
      result,
      "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    );
  });

  it("does not append a reminder note to a plain memory promise", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remember that preference." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expectReplyText(result, "I'll remember that preference.");
  });

  it("keeps reminder commitment unchanged when cron.add succeeded", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 1,
    });

    const result = await createRun();
    expectReplyText(result, "I'll remind you tomorrow morning.");
  });

  it("suppresses guard note when session already has an active cron job", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you when it's done." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expectReplyText(result, "I'll ping you when it's done.");
  });

  it("still appends guard note when cron jobs exist but not for the current session", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "unrelated-job",
          name: "daily-news",
          enabled: true,
          sessionKey: "other-session",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expectReplyText(
      result,
      "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    );
  });

  it("still appends guard note when cron jobs for session exist but are disabled", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "disabled-job",
          name: "old-monitor",
          enabled: false,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll check back in an hour." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expectReplyText(
      result,
      "I'll check back in an hour.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    );
  });

  it("still appends guard note when sessionKey is missing", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you later." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ omitSessionKey: true });
    expectReplyText(
      result,
      "I'll ping you later.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    );
  });

  it("still appends guard note when cron store read fails", async () => {
    loadCronStoreMock.mockRejectedValueOnce(new Error("store read failed"));

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you after lunch." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ sessionKey: "main" });
    expectReplyText(
      result,
      "I'll remind you after lunch.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    );
  });
});

describe("runReplyAgent fallback reasoning tags", () => {
  type EmbeddedAgentParams = {
    enforceFinalTag?: boolean;
    prompt?: string;
  };

  function createRun(params?: { sessionEntry?: SessionEntry; sessionKey?: string }) {
    const sessionKey = params?.sessionKey ?? "main";
    return createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionKey,
        config: createCliBackendTestConfig(),
      },
      reply: { queueKey: "main", sessionEntry: params?.sessionEntry, sessionKey },
    }).run();
  }

  it("enforces <final> when the fallback provider requires reasoning tags", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    runWithModelFallbackMock.mockImplementationOnce(async (params: RunWithModelFallbackParams) => ({
      result: await runFallbackModelAttempt(params, "google", "gemini-2.5-pro", "unknown"),
      provider: "google",
      model: "gemini-2.5-pro",
      attempts: [],
    }));

    const result = await createRun();
    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.filter((payload) => payload?.text === "ok")).toHaveLength(1);

    const call = firstMockCallArg(
      runEmbeddedAgentMock,
      "embedded run params",
    ) as EmbeddedAgentParams;
    expect(call.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-memory-flush-tags-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:memory-flush-tags";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1_000_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    try {
      await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
      registerMemoryFlushPlanResolverForTest(() => ({
        softThresholdTokens: 1_000,
        forceFlushTranscriptBytes: 1_000_000_000,
        reserveTokensFloor: 20_000,
        prompt: "Pre-compaction memory flush.",
        systemPrompt: "Flush memory into the configured memory file.",
        relativePath: "memory/active.md",
      }));
      runEmbeddedAgentMock.mockResolvedValue({ payloads: [], meta: {} });
      runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "ok" }], meta: {} });
      runWithModelFallbackMock.mockImplementation(async (params: RunWithModelFallbackParams) => ({
        result: await runFallbackModelAttempt(params, "google-gemini-cli", "gemini-3", "unknown"),
        provider: "google-gemini-cli",
        model: "gemini-3",
        attempts: [],
      }));
      compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { tokensAfter: 1_000_000 },
      });

      const result = await createBaseRun({
        run: {
          agentId: "main",
          agentDir: path.join(root, "agent"),
          sessionKey,
          workspaceDir: root,
          config: createCliBackendTestConfig(),
        },
        reply: {
          queueKey: sessionKey,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
        },
      }).run();

      const flushCall = runEmbeddedAgentMock.mock.calls.find(([params]) =>
        (params as EmbeddedAgentParams | undefined)?.prompt?.includes(
          "Pre-compaction memory flush.",
        ),
      )?.[0] as EmbeddedAgentParams | undefined;
      expect(flushCall?.enforceFinalTag).toBe(true);
      expect(runCliAgentMock).toHaveBeenCalledOnce();
      const payloads = Array.isArray(result) ? result : [result];
      expect(payloads.filter((payload) => payload?.text === "ok")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runReplyAgent response usage footer", () => {
  function createRun(params: {
    responseUsage: "tokens" | "full";
    sessionKey: string;
    config?: unknown;
    provider?: string;
    model?: string;
  }) {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      responseUsage: params.responseUsage,
    };
    return createBaseRun({
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionKey: params.sessionKey,
        config: params.config ?? createCliBackendTestConfig(),
        provider: params.provider ?? "anthropic",
        model: params.model ?? "claude",
        thinkLevel: "low",
      },
      reply: { queueKey: "main", sessionEntry, sessionKey: params.sessionKey },
    }).run();
  }

  it("uses the built-in compact footer when responseUsage=full", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 2 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "full", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    const text = payload?.text ?? "";
    expect(text).toContain("ok\nanthropic🤖claude🌘🐌");
    expect(text).not.toContain("ok\n\nanthropic");
    expect(text).toContain("anthropic🤖claude🌘🐌");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("🗄");
    expect(text).not.toContain("Usage:");
    expect(text).not.toContain("· session ");
  });

  it("does not append session key when responseUsage=tokens", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "amazon-bedrock",
          model: "us.anthropic.claude-sonnet-4-6",
          usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 2 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({
      responseUsage: "tokens",
      sessionKey,
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              auth: "aws-sdk",
              models: [
                {
                  id: "us.anthropic.claude-sonnet-4-6",
                  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                },
              ],
            },
          },
        },
      },
    });
    const payload = Array.isArray(res) ? res[0] : res;
    const text = payload?.text ?? "";
    expect(text).toContain("Usage:");
    expect(text).toContain("cache 4 cached / 2 new");
    expect(text).not.toContain("est $");
    expect(text).not.toContain("· session ");
  });

  it("omits partial token counts from the built-in full footer", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { output: 125 },
        },
      },
    });

    const res = await createRun({
      responseUsage: "full",
      sessionKey: "agent:main:whatsapp:dm:+1000",
    });
    const payload = Array.isArray(res) ? res[0] : res;
    const text = payload?.text ?? "";
    expect(text).toContain("anthropic🤖claude");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("Usage:");
  });

  it("omits aggregate-only token totals in the built-in full footer", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { total: 1250 },
        },
      },
    });

    const res = await createRun({
      responseUsage: "full",
      sessionKey: "agent:main:whatsapp:dm:+1000",
      config: {
        models: {
          providers: {
            anthropic: {
              models: [{ id: "claude", cost: { input: 3, output: 15 } }],
            },
          },
        },
      },
    });
    const payload = Array.isArray(res) ? res[0] : res;
    const text = payload?.text ?? "";
    expect(text).toContain("anthropic🤖claude");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("💰");
    expect(text).not.toContain("Usage:");
  });

  it("shows configured costs for aws-sdk providers when responseUsage=full", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "amazon-bedrock",
          model: "us.anthropic.claude-sonnet-4-6",
          usage: { input: 1_000, output: 2_000, cacheRead: 500, cacheWrite: 2_000 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({
      responseUsage: "full",
      sessionKey,
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              auth: "aws-sdk",
              models: [
                {
                  id: "us.anthropic.claude-sonnet-4-6",
                  cost: {
                    input: 3,
                    output: 15,
                    cacheRead: 0.3,
                    cacheWrite: 3.75,
                  },
                },
              ],
            },
          },
        },
      },
    });
    const payload = Array.isArray(res) ? res[0] : res;
    const text = payload?.text ?? "";

    expect(text).toContain("amazon-bedrock🤖us.anthropic.claude-sonnet-4-6🌘🐌");
    expect(text).not.toContain("↕️");
    expect(text).not.toContain("🗄");
    expect(text).toContain("💰0.0406");
    expect(text).not.toContain("Usage:");
    expect(text).not.toContain("· session ");
  });
});

describe("runReplyAgent transient HTTP failures", () => {
  it("does not retry a transient provider failure in the reply layer", async () => {
    runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        `521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>`,
      ),
    );

    const runPromise = createBaseRun({
      context: { Provider: "telegram", MessageSid: "msg" },
      run: {
        messageProvider: "telegram",
        config: createCliBackendTestConfig(),
        thinkLevel: "low",
      },
    }).run();

    const result = await runPromise;

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("provider internal error");
  });
});

describe("runReplyAgent billing error classification", () => {
  // Regression guard for the runner-level catch block in executeAgentTurn.
  // Billing errors from providers like OpenRouter can contain token/size wording that
  // matches context overflow heuristics. This test verifies the final user-visible
  // message is the billing-specific one, not the "Context overflow" fallback.
  it("returns billing message for mixed-signal error (billing text + overflow patterns)", async () => {
    runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("402 Payment Required: request token limit exceeded for this billing plan"),
    );

    const result = await createBaseRun({
      context: { Provider: "telegram", MessageSid: "msg" },
      run: {
        messageProvider: "telegram",
        config: createCliBackendTestConfig(),
        thinkLevel: "low",
      },
      reply: { defaultModel: "anthropic/claude" },
    }).run();

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("billing error");
    expect(payload?.text).not.toContain("Context overflow");
  });
});

describe("runReplyAgent mid-turn rate-limit fallback", () => {
  function createRun() {
    return createBaseRun({
      context: { Provider: "telegram", MessageSid: "msg" },
      run: {
        messageProvider: "telegram",
        config: createCliBackendTestConfig(),
        thinkLevel: "low",
      },
      reply: { defaultModel: "anthropic/claude" },
    }).run();
  }

  it("surfaces a final error when only reasoning preceded a mid-turn rate limit", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reasoning", isReasoning: true }],
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload?.text).toContain("API rate limit reached");
  });

  it("preserves successful media-only replies that use legacy mediaUrl", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ mediaUrl: "https://example.test/image.png" }],
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expectRecordFields(
      payload,
      { mediaUrl: "https://example.test/image.png" },
      "media-only retry-limit payload",
    );
    expect(payload?.text).toBeUndefined();
  });
});

describe("runReplyAgent private message_tool_only final warning (#85714)", () => {
  const strandedDiagnosticText =
    "I generated a reply but could not deliver it to this chat. Please try again.";

  function normalizeReplyPayloads(result: unknown): Record<string, unknown>[] {
    const payloads = Array.isArray(result) ? result : [result];
    return payloads.map((payload, index) => requireRecord(payload, `reply payload ${index}`));
  }

  async function runPrivateFinalCase(params: {
    messagingToolSentTargets?: unknown[];
    messagingToolSourceReplyPayloads?: Array<{ text?: string }>;
    didDeliverSourceReplyViaMessageTool?: boolean;
    finalAssistantText?: string;
    finalAssistantRawText?: string;
    payloads?: ReplyPayload[];
    payloadText?: string;
    successfulCronAdds?: number;
    resolvedVerboseLevel?: VerboseLevel;
    isNewSession?: boolean;
    inboundEventKind?: InboundEventKind;
    transcriptPrompt?: string;
    summaryLine?: string;
    strandedReplyRetry?: boolean;
    sendPolicyDenied?: boolean;
    isHeartbeat?: boolean;
    pendingContinuation?: boolean;
    onDeliberateSilentTerminalReply?: () => void;
    onObservedReplyDelivery?: () => Promise<void> | void;
    replyOperation?: ReturnType<typeof createReplyOperation>;
    turnAdoptionLifecycle?: FollowupRun["turnAdoptionLifecycle"];
  }) {
    const tmp = tempDirs.make("openclaw-stranded-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "stranded";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1_000,
      ...(params.sendPolicyDenied ? { sendPolicy: "deny" as const } : {}),
    };
    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);

    const finalAssistantText =
      params.finalAssistantText ??
      "Here is the answer the user asked for. It includes enough detail to read like a user-facing response rather than a short private note. This should have been sent with the message tool if the channel expected a visible reply.";
    runEmbeddedAgentMock.mockResolvedValue({
      // payloadText can differ from the assistant text to simulate metadata-only
      // payloads (verbose notices, usage line) that must NOT trigger the warn —
      // detection keys off the assistant final text, not the payload bundle.
      payloads: params.payloads ?? [{ text: params.payloadText ?? finalAssistantText }],
      meta: {
        agentMeta: {},
        finalAssistantVisibleText: finalAssistantText,
        ...(params.pendingContinuation ? { yielded: true } : {}),
        ...(params.finalAssistantRawText
          ? { finalAssistantRawText: params.finalAssistantRawText }
          : {}),
      },
      ...(params.messagingToolSentTargets
        ? { messagingToolSentTargets: params.messagingToolSentTargets }
        : {}),
      ...(params.messagingToolSourceReplyPayloads
        ? { messagingToolSourceReplyPayloads: params.messagingToolSourceReplyPayloads }
        : {}),
      ...(params.didDeliverSourceReplyViaMessageTool
        ? { didDeliverSourceReplyViaMessageTool: true }
        : {}),
      ...(params.successfulCronAdds === undefined
        ? {}
        : { successfulCronAdds: params.successfulCronAdds }),
    });

    const sessionCtx = createTestTemplateContext({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
      ChatType: "direct",
      ...(params.inboundEventKind ? { InboundEventKind: params.inboundEventKind } : {}),
    });
    const followupRun = createTestQueuedFollowupRun({
      prompt: "hello",
      summaryLine: params.summaryLine ?? "hello",
      ...(params.strandedReplyRetry ? { strandedReplyRetry: true } : {}),
      enqueuedAt: Date.now(),
      ...(params.transcriptPrompt ? { transcriptPrompt: params.transcriptPrompt } : {}),
      ...(params.turnAdoptionLifecycle
        ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
        : {}),
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionId: "session",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: path.join(rootDir, "session.jsonl"),
        workspaceDir: tmp,
        // Carry the canonical tool-only run fact and keep downstream policy aligned,
        // so the private final is never eligible for automatic source delivery.
        config: { messages: { visibleReplies: "message_tool" } },
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
        thinkLevel: "low",
        reasoningLevel: "on",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    // Seeding the SQLite session entry above resolves the runtime config
    // (getRuntimeConfig) and pins an empty `{}` snapshot; leaving it in place
    // would make resolveQueuedReplyExecutionConfig override the run's
    // visibleReplies=message_tool config and mis-resolve delivery to automatic.
    clearRuntimeConfigSnapshot();

    const runId = `stranded-${path.basename(tmp)}`;
    const agentEvents: AgentEventPayload[] = [];
    const unsubscribe = subscribeAgentEvent((event) => {
      if (event.runId === runId) {
        agentEvents.push(event);
      }
    });
    try {
      const result = await runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: sessionKey,
        resolvedQueue: createTestQueueSettings({ mode: "interrupt" }),
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        typing: createMockTypingController(),
        sessionCtx,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params.resolvedVerboseLevel ?? "off",
        isNewSession: params.isNewSession ?? false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
        opts: {
          runId,
          ...(params.isHeartbeat ? { isHeartbeat: true } : {}),
          ...(params.onDeliberateSilentTerminalReply
            ? { onDeliberateSilentTerminalReply: params.onDeliberateSilentTerminalReply }
            : {}),
          ...(params.onObservedReplyDelivery
            ? { onObservedReplyDelivery: params.onObservedReplyDelivery }
            : {}),
        },
        ...(params.replyOperation ? { replyOperation: params.replyOperation } : {}),
      });
      const terminalEvent = agentEvents.find(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
      return { storePath, tmp, sessionKey, result, finalAssistantText, terminalEvent };
    } finally {
      unsubscribe();
    }
  }

  it("warns when a substantive private final reply never used the message tool", async () => {
    await runPrivateFinalCase({});
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(warnPrivateFinalSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKey: "stranded" });
  });

  it("attests observed delivery for message-tool source replies outside message_tool_only", async () => {
    // A source-routed message-tool answer plus NO_REPLY must not draw the
    // no-visible-reply fallback into the source conversation (#114799).
    const onObservedReplyDelivery = vi.fn(async () => {});
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      onObservedReplyDelivery,
    });
    expect(onObservedReplyDelivery).toHaveBeenCalledTimes(1);
  });

  it("enqueues a one-shot recovery retry by default for substantive stranded finals", async () => {
    const parentOnComplete = vi.fn();
    const parentLifecycle = { onAdopted: async () => {}, onSettled: parentOnComplete };
    const { finalAssistantText } = await runPrivateFinalCase({
      turnAdoptionLifecycle: parentLifecycle,
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    const messagesConfig = retryRun?.run?.config?.messages as Record<string, unknown> | undefined;
    expect(messagesConfig).toEqual({ visibleReplies: "message_tool" });
    expect(retryRun?.summaryLine).toBe("stranded-reply-retry");
    expect(retryRun?.strandedReplyRetry).toBe(true);
    expect(retryRun?.prompt).toContain("message(action=send)");
    expect(retryRun?.prompt).toContain(finalAssistantText);
    // System retry must not inherit the client turn's one-shot lifecycle identity.
    expect(retryRun?.turnAdoptionLifecycle).toBeUndefined();
    expect(parentLifecycle.onSettled).toBe(parentOnComplete);
    expect(parentOnComplete).not.toHaveBeenCalled();
  });

  it("uses visible final text, not raw assistant text, in the recovery retry prompt", async () => {
    const visibleFinal =
      "Visible answer that has already been normalized for the user-facing final response and is long enough to trigger recovery. It includes a second complete sentence so the substantive-final detector treats it as a real reply.";
    await runPrivateFinalCase({
      finalAssistantText: visibleFinal,
      finalAssistantRawText: `<final>${visibleFinal}</final>`,
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(visibleFinal);
    expect(retryRun?.prompt).not.toContain("<final>");
  });

  it("uses normalized delivery text, not reply directive tags, in the recovery retry prompt", async () => {
    const normalizedFinal =
      "Visible answer that should be threaded to the current message and is long enough to trigger recovery. It includes another complete sentence so the substantive-final detector treats it as a real reply.";
    await runPrivateFinalCase({
      finalAssistantText: `[[reply_to_current]] ${normalizedFinal}`,
      payloadText: `[[reply_to_current]] ${normalizedFinal}`,
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(normalizedFinal);
    expect(retryRun?.prompt).not.toContain("[[reply_to_current]]");
  });

  it("excludes raw trace and status payloads from the recovery retry prompt", async () => {
    const visibleFinal =
      "Visible answer that should be delivered to the source chat. It includes another complete sentence so the substantive-final detector treats it as a real reply.";
    const rawTraceText =
      "🔎 Model Input (User Role):\n```text\nsecret user trace that must not reach chat\n```";
    const statusText = "🧩 Active Memory: status=ok query=private-context";
    await runPrivateFinalCase({
      finalAssistantText: visibleFinal,
      payloads: [
        { text: visibleFinal },
        { text: rawTraceText },
        { text: statusText, isStatusNotice: true },
      ],
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(visibleFinal);
    expect(retryRun?.prompt).not.toContain("secret user trace");
    expect(retryRun?.prompt).not.toContain("Active Memory");
  });

  it("suppresses retry prompt persistence and keeps the retry out of collect batches", async () => {
    await runPrivateFinalCase({ transcriptPrompt: "original user question" });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.transcriptPrompt).toBeUndefined();
    expect(retryRun?.userTurnTranscriptRecorder).toBeUndefined();
    expect(retryRun?.currentInboundContext).toBeUndefined();
    expect(retryRun?.run?.suppressNextUserMessagePersistence).toBe(true);
    expect(retryRun?.run?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(retryRun?.disableCollectBatching).toBe(true);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[3]).toBe("none");
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[6]).toEqual({ position: "front" });
  });

  it("records a short private final without a message call as non-delivery", async () => {
    const { terminalEvent } = await runPrivateFinalCase({
      finalAssistantText: "Nothing to send here.",
    });
    expect(terminalEvent?.data.terminalReply).toEqual({
      disposition: "empty",
      code: "message-tool-not-called",
    });
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not warn or enqueue retry when the message tool delivered this turn", async () => {
    const { terminalEvent, finalAssistantText } = await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
    });
    expect(terminalEvent?.data.terminalReply).toEqual({
      disposition: "visible",
      text: finalAssistantText,
    });
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not record message-tool non-delivery while the run has a continuation", async () => {
    const { terminalEvent } = await runPrivateFinalCase({
      finalAssistantText: "Nothing to send here.",
      pendingContinuation: true,
    });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
  });

  it("still recovers a private final after only a message-tool progress delivery", async () => {
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "+15550001111",
          sourceReplyFinal: false,
        },
      ],
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("does not recover again after an explicit final message-tool delivery", async () => {
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "+15550001111",
          sourceReplyFinal: true,
        },
      ],
    });

    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("still retries when the message tool sent only to a non-source target", async () => {
    await runPrivateFinalCase({
      messagingToolSentTargets: [{ tool: "message", provider: "whatsapp", to: "+15559998888" }],
    });
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("still retries when only an unrelated cron side effect succeeded", async () => {
    await runPrivateFinalCase({ successfulCronAdds: 1 });
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("does not warn or enqueue retry on an intentional NO_REPLY turn even when metadata payloads remain", async () => {
    // Assistant went silent (NO_REPLY), but a verbose/usage metadata payload
    // survives in finalPayloads. The warn must key off the assistant text, not
    // the payload bundle, so no private-final warning should fire.
    const onDeliberateSilentTerminalReply = vi.fn();
    const { terminalEvent } = await runPrivateFinalCase({
      finalAssistantText: "no_reply",
      onDeliberateSilentTerminalReply,
      payloadText: "Auto-compaction complete (count 1).",
    });
    expect(terminalEvent?.data.terminalReply).toEqual({ disposition: "silent" });
    expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not warn or enqueue retry for room_event turns", async () => {
    const { terminalEvent } = await runPrivateFinalCase({ inboundEventKind: "room_event" });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not warn, enqueue retry, or emit diagnostic for heartbeat runs", async () => {
    const { result, terminalEvent } = await runPrivateFinalCase({ isHeartbeat: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = result === undefined ? [] : normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("does not warn or enqueue retry when send policy denied source delivery", async () => {
    const { terminalEvent } = await runPrivateFinalCase({ sendPolicyDenied: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not enqueue a second retry when a stranded-reply retry strands again", async () => {
    const { result, finalAssistantText } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = normalizeReplyPayloads(result);
    const original = payloads.find((payload) => payload.text === finalAssistantText);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
  });

  it("does not treat user-controlled summary text as the internal retry marker", async () => {
    await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("does not emit retry-failure diagnostic after internal source reply delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      messagingToolSourceReplyPayloads: [{ text: "visible recovered reply" }],
      finalAssistantText: "",
      payloadText: "",
    });

    const payloads = result === undefined ? [] : normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("emits the sanitized diagnostic when a stranded-reply retry produces no source delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      finalAssistantText: "",
      payloadText: "",
    });

    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = normalizeReplyPayloads(result);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
  });

  it("emits the same sanitized diagnostic when the retry cannot be enqueued", async () => {
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(false);

    const { result, finalAssistantText } = await runPrivateFinalCase({});

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const payloads = normalizeReplyPayloads(result);
    const original = payloads.find((payload) => payload.text === finalAssistantText);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
  });

  it("schedules the stranded-reply retry drain only after the active reply operation clears", async () => {
    const sessionKey = "stranded";
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);

    const drainOrder: string[] = [];
    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      drainOrder.push("drain");
    });

    await runPrivateFinalCase({ replyOperation });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.get(sessionKey)).toBe(replyOperation);
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    drainOrder.push("clear");
    replyOperation.complete();

    expect(drainOrder[0]).toBe("clear");
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
