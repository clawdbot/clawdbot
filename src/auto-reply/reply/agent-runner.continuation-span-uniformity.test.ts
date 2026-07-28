// Integration pin for delegate-dispatch span shape across continuation modes.
//
// The current tracer contract names the span `continuation.delegate.dispatch`.
// This test drives the runner-side tool delegate path for silent modes and
// leaves the post-compaction mode as a production-gap TODO.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { enqueuePendingDelegate } from "../continuation/delegate-store.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

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
const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());
const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) =>
    compactState.compactEmbeddedAgentSessionMock(params),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  abortEmbeddedAgentRun: (sessionId: string) => {
    abortEmbeddedAgentRunMock(sessionId);
    return abortEmbeddedAgentRun(sessionId);
  },
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActive(sessionId),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

type RecordedSpan = {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus | undefined;
  ended: boolean;
};

type DelegateModeUnderTest = "silent" | "silent-wake";

const PARENT_CHAIN_ID = "019dcf57-b536-77cc-834b-b803d9262032";

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, opts?: StartSpanOptions): Span {
      const rec: RecordedSpan = {
        name,
        attributes: { ...opts?.attributes },
        status: undefined,
        ended: false,
      };
      spans.push(rec);
      const span: Span = {
        setAttributes(attrs: SpanAttributes): void {
          Object.assign(rec.attributes, attrs);
        },
        setStatus(status: SpanStatus, _message?: string): void {
          rec.status = status;
        },
        recordException(_err: unknown): void {
          // unused by the delegate dispatch accept path
        },
        end(): void {
          rec.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();
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
  loadCronStoreMock.mockClear();
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  requestHeartbeatNowMock.mockReset();
  spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:spawned",
    runId: "run-spawned",
  });
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetContinuationTracer();
});

function createContinuationRun(params: {
  mode: DelegateModeUnderTest;
  sessionKey: string;
  currentChainCount: number;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
    continuationChainId: PARENT_CHAIN_ID,
    continuationChainCount: params.currentChainCount,
    continuationChainStartedAt: 1_700_000_000_000,
    continuationChainTokens: 0,
  } satisfies SessionEntry;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      sessionId: "session",
      sessionKey: params.sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: true,
              minDelayMs: 0,
              maxDelayMs: 5_000,
              defaultDelayMs: 1_000,
              maxChainLength: 6,
              maxDelegatesPerTurn: 4,
            },
          },
        },
      },
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

  return {
    sessionKey: params.sessionKey,
    sessionEntry,
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun,
  };
}

async function runDelegateTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
): Promise<unknown> {
  setRuntimeConfigSnapshot(run.followupRun.run.config);
  return runReplyAgent({
    commandBody: "hello",
    followupRun: run.followupRun,
    queueKey: run.sessionKey,
    resolvedQueue: run.resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing: run.typing,
    sessionCtx: run.sessionCtx,
    sessionEntry: run.sessionEntry,
    sessionStore,
    sessionKey: run.sessionKey,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    // These scenarios seed a mid-chain entry (continuationChainCount ≥ 1) and
    // continue it, so the turn is a continuation WAKE: the chain-break
    // reset must NOT fire and the parent chain.id / step math carry forward.
    isContinuationWake: true,
  });
}

async function dispatchToolDelegateMode(params: {
  mode: DelegateModeUnderTest;
  currentChainCount: number;
}): Promise<RecordedSpan> {
  const { tracer, spans } = createRecordingTracer();
  setContinuationTracer(tracer);
  const sessionKey = `continuation-span-uniformity-${params.mode}`;
  const run = createContinuationRun({
    mode: params.mode,
    sessionKey,
    currentChainCount: params.currentChainCount,
  });
  runEmbeddedAgentMock.mockImplementationOnce(async () => {
    enqueuePendingDelegate(sessionKey, {
      task: `check span uniformity for ${params.mode}`,
      mode: params.mode,
    });
    return {
      payloads: [{ text: "Queued delegate." }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    };
  });

  await runDelegateTurn(run, { [sessionKey]: run.sessionEntry });

  const dispatchSpans = spans.filter((s) => s.name === "continuation.delegate.dispatch");
  expect(dispatchSpans).toHaveLength(1);
  const dispatchSpan = dispatchSpans[0];
  if (!dispatchSpan) {
    throw new Error(`expected continuation.delegate.dispatch span for ${params.mode}`);
  }
  return dispatchSpan;
}

describe("runReplyAgent :: delegate dispatch span uniformity", () => {
  it("emits uniform continuation.delegate.dispatch spans for silent and silent-wake tool delegates", async () => {
    const silent = await dispatchToolDelegateMode({ mode: "silent", currentChainCount: 1 });
    const silentWake = await dispatchToolDelegateMode({
      mode: "silent-wake",
      currentChainCount: 2,
    });

    for (const [mode, span] of [
      ["silent", silent],
      ["silent-wake", silentWake],
    ] as const) {
      expect(span.status).toBe("OK");
      expect(span.ended).toBe(true);
      expect(span.attributes["chain.id"]).toBe(PARENT_CHAIN_ID);
      expect(span.attributes["delay.ms"]).toBe(0);
      expect(span.attributes["delegate.delivery"]).toBe("immediate");
      expect(span.attributes["delegate.mode"]).toBe(mode);
    }

    expect(Object.keys(silent.attributes).toSorted()).toEqual(
      Object.keys(silentWake.attributes).toSorted(),
    );

    const stableKeys = Object.keys(silent.attributes).filter(
      (key) =>
        key !== "delegate.mode" &&
        key !== "chain.step.remaining" &&
        key !== "reason.length" &&
        key !== "reason.hash" &&
        key !== "reason.redacted",
    );
    for (const key of stableKeys) {
      expect(silent.attributes[key]).toBe(silentWake.attributes[key]);
    }
    expect(silent.attributes["chain.step.remaining"]).toBe(4);
    expect(silentWake.attributes["chain.step.remaining"]).toBe(3);
  });

  // Post-compaction delegate delivery persists continuation chain state but
  // does not yet emit `continuation.delegate.dispatch` with
  // `delegate.mode = "post-compaction"`. Keep this todo as the coverage marker
  // for the production lane.
  it.todo(
    "emits exactly one continuation.delegate.dispatch span for post-compaction delegates with the same attribute-key shape",
  );
});
