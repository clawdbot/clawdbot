// Integration test pinning the runner-side `continuation.work` span emission
// contract.
//
// We install a recording tracer via `setContinuationTracer`, drive the
// runner with CONTINUE_WORK over multiple chain steps, and assert:
//   1. accepted WORK turn → exactly one `continuation.work` span, with
//      a UUID `chain.id` and clamped `chain.step.remaining`
//   2. the chain.id is stable across two consecutive accepted steps
//      (mint-at-0→1, reuse-for-step-2 contract)
//   3. crossing `maxChainLength` → cap-reject path → no new
//      `continuation.work` span emitted (rejected requests don't
//      advance the chain, so they MUST NOT emit `continuation.work`)

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
import { listTaskFlowsForOwnerKey } from "../../tasks/task-flow-runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { resetDelegateDispatchHedgesForTests } from "../continuation/delegate-dispatch.js";
import { enqueuePendingDelegate } from "../continuation/delegate-store.js";
import { enqueuePendingWork } from "../continuation/work-store.js";
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
const patchSessionEntryMock = vi.hoisted(() => vi.fn());
const loadSessionEntryMock = vi.hoisted(() => vi.fn());

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

vi.mock("../../agents/embedded-agent.js", () => {
  return {
    compactEmbeddedAgentSession: (params: unknown) =>
      compactState.compactEmbeddedAgentSessionMock(params),
    queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
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

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: Parameters<typeof actual.loadSessionEntry>) => {
      const implementation = loadSessionEntryMock.getMockImplementation();
      return implementation ? loadSessionEntryMock(...args) : actual.loadSessionEntry(...args);
    },
    patchSessionEntry: (...args: unknown[]) => patchSessionEntryMock(...args),
  };
});

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
          // not used by `continuation.work` accept path
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
  resetTaskFlowRegistryForTests({ persist: false });
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
  patchSessionEntryMock
    .mockReset()
    .mockImplementation(
      async (
        _scope: unknown,
        update: (entry: SessionEntry) => Partial<SessionEntry> | null,
      ): Promise<SessionEntry | null> => {
        const entry = { sessionId: "session", updatedAt: Date.now() } satisfies SessionEntry;
        const patch = update(entry);
        return patch ? { ...entry, ...patch } : null;
      },
    );
  loadSessionEntryMock.mockReset();
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
  resetDelegateDispatchHedgesForTests();
  resetTaskFlowRegistryForTests({ persist: false });
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createContinuationRun(params?: {
  sessionKey?: string;
  config?: Record<string, unknown>;
  sessionEntry?: SessionEntry;
}) {
  const sessionKey = params?.sessionKey ?? "continuation-work-span";
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry =
    params?.sessionEntry ??
    ({
      sessionId: "session",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config:
        params?.config ??
        ({
          agents: {
            defaults: {
              continuation: {
                enabled: true,
                minDelayMs: 0,
                maxDelayMs: 1_000,
                defaultDelayMs: 1_000,
                maxChainLength: 2,
              },
            },
          },
        } satisfies Record<string, unknown>),
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

  return { sessionKey, sessionEntry, typing, sessionCtx, resolvedQueue, followupRun };
}

async function runWorkTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
  _payloadText: string,
  isContinuationWake = false,
  storePath?: string,
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
    ...(storePath ? { storePath } : {}),
    sessionKey: run.sessionKey,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    isContinuationWake,
  });
}

const splitLintUse = [listTaskFlowsForOwnerKey, enqueuePendingDelegate, enqueuePendingWork];
void splitLintUse;

describe("runReplyAgent :: continuation chain-break reset", () => {
  const UNRELEASED_CHAIN_CONFIG = {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 1_000,
          defaultDelayMs: 1_000,
          // High cap so a preserved wake count can still take its next step
          // (the point under test is preservation, not the cap itself).
          maxChainLength: 200,
        },
      },
    },
  } satisfies Record<string, unknown>;

  it("resets the chain budget to 0 on a fresh (non-wake) turn-entry, upstream of inference", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // A long session has accumulated a stale runaway budget (count=50,
    // tokens=400k, chain id minted long ago). A genuine fresh inbound turn
    // (NOT a continuation wake) means the prior chain ended.
    const seededChainId = "019dcf57-cccc-77cc-834b-b803d9262032";
    const seededStartedAt = Date.now() - 3_600_000;
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 50,
      continuationChainStartedAt: seededStartedAt,
      continuationChainTokens: 400_000,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-chain-reset-fresh",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    // Capture the entry state DURING inference — the reset must already have
    // landed before the model call, so the resetting turn itself opens at 0.
    let countDuringInference: number | undefined;
    let tokensDuringInference: number | undefined;
    let chainIdDuringInference: string | undefined;
    let startedAtDuringInference: number | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      countDuringInference = run.sessionEntry.continuationChainCount;
      tokensDuringInference = run.sessionEntry.continuationChainTokens;
      chainIdDuringInference = run.sessionEntry.continuationChainId;
      startedAtDuringInference = run.sessionEntry.continuationChainStartedAt;
      return {
        payloads: [{ text: "Fresh task\nCONTINUE_WORK:1" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(run, sessionStore, "Fresh task\nCONTINUE_WORK:1");

    // Budget zeroed, fresh chain id minted, chainStartedAt advanced — all
    // visible at inference time (i.e. before the post-inference chain load).
    expect(countDuringInference).toBe(0);
    expect(tokensDuringInference).toBe(0);
    expect(chainIdDuringInference).not.toBe(seededChainId);
    expect(chainIdDuringInference as string).toMatch(UUID_REGEX);
    expect(startedAtDuringInference).toBe(Date.now());

    // The fresh chain then took its FIRST work step (0 -> 1) instead of being
    // rejected against the stale count=50 cap (maxChainLength=2 → remaining=1).
    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);
    expect(workSpans[0]?.attributes["chain.step.remaining"]).toBe(1);
    expect(workSpans[0]?.attributes["chain.id"]).toBe(chainIdDuringInference);
    expect(run.sessionEntry.continuationChainCount).toBe(1);
    expect(run.sessionEntry.continuationChainStartedAt).toBeGreaterThan(seededStartedAt);
  });

  it("does NOT reset the chain budget on a continuation-wake turn-entry (count carries forward)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // A mid-chain step arriving as a continuation wake: count=50 must be
    // preserved and advance normally (51), reusing the chain id.
    const seededChainId = "019dcf57-dddd-77cc-834b-b803d9262032";
    const seededStartedAt = Date.now() - 3_600_000;
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 50,
      continuationChainStartedAt: seededStartedAt,
      continuationChainTokens: 12_345,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-chain-reset-wake",
      sessionEntry: seededEntry,
      config: UNRELEASED_CHAIN_CONFIG,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    let countDuringInference: number | undefined;
    let chainIdDuringInference: string | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      countDuringInference = run.sessionEntry.continuationChainCount;
      chainIdDuringInference = run.sessionEntry.continuationChainId;
      return {
        payloads: [{ text: "Next step\nCONTINUE_WORK:1" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(run, sessionStore, "Next step\nCONTINUE_WORK:1", true);

    // No reset: the wake turn sees the inherited count/chain id unchanged...
    expect(countDuringInference).toBe(50);
    expect(chainIdDuringInference).toBe(seededChainId);
    // ...and the chain advances 50 -> 51, reusing the same chain id.
    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);
    expect(workSpans[0]?.attributes["chain.id"]).toBe(seededChainId);
    expect(run.sessionEntry.continuationChainCount).toBe(51);
    expect(run.sessionEntry.continuationChainStartedAt).toBe(seededStartedAt);
  });

  it("leaves an already-empty chain budget untouched on a fresh turn (no churn, no spurious mint)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // count=0 and tokens=0 → nothing to reset; the fresh turn must NOT mint a
    // spurious chain id or write the entry just to re-zero it.
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 0,
      continuationChainTokens: 0,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-chain-reset-noop",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    let chainIdDuringInference: string | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      chainIdDuringInference = run.sessionEntry.continuationChainId;
      return {
        payloads: [{ text: "Just a reply" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    await runWorkTurn(run, sessionStore, "Just a reply");

    // No CONTINUE signal and nothing to reset: chain id stays absent.
    expect(chainIdDuringInference).toBeUndefined();
    expect(spans.filter((s) => s.name === "continuation.work")).toHaveLength(0);
    expect(run.sessionEntry.continuationChainCount ?? 0).toBe(0);
    expect(run.sessionEntry.continuationChainId).toBeUndefined();
  });

  it("resets a stale at-cap chain budget on an ordinary subagent-return so a fresh continuation passes the cap (doom-lock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // The "195-forever" doom-lock: a long-lived session carries a
    // stale chain count pinned at the cap. An ordinary inter-session subagent
    // completes and returns — that arrives as `continuationTrigger:
    // "subagent-return"`, which get-reply-run maps to isContinuationWake=false
    // (proven in get-reply-run.media-only.test.ts). So at this reset gate it is
    // an external turn-entry: the chain budget must rewind to 0, otherwise the
    // fresh continuation elected from the subagent return is rejected forever
    // against the stale at-cap count. maxChainLength=200, count seeded at 200.
    const seededChainId = "019dcf57-9989-77cc-834b-b803d9262032";
    const seededStartedAt = Date.now() - 7_200_000;
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 200,
      continuationChainStartedAt: seededStartedAt,
      continuationChainTokens: 900_000,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-chain-reset-subagent-return",
      sessionEntry: seededEntry,
      config: UNRELEASED_CHAIN_CONFIG,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    let countDuringInference: number | undefined;
    let chainIdDuringInference: string | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      countDuringInference = run.sessionEntry.continuationChainCount;
      chainIdDuringInference = run.sessionEntry.continuationChainId;
      return {
        payloads: [{ text: "Continue after subagent return\nCONTINUE_WORK:1" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    // isContinuationWake=false models the ordinary subagent-return turn-entry.
    await runWorkTurn(run, sessionStore, "Continue after subagent return\nCONTINUE_WORK:1", false);

    // Budget zeroed before inference, fresh chain id minted, and the fresh chain
    // took its FIRST work step (0 -> 1) instead of being rejected against the
    // stale count=200 cap — the doom-lock is broken.
    expect(countDuringInference).toBe(0);
    expect(chainIdDuringInference).not.toBe(seededChainId);
    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);
    expect(run.sessionEntry.continuationChainCount).toBe(1);
  });
});
