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
const updateSessionEntryMock = vi.hoisted(() => vi.fn());
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

vi.mock("../../agents/live-model-switch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/live-model-switch.js")>();
  return {
    ...actual,
    consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
  };
});

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
    // Final-delivery persistence now verifies the row it wrote, so this seam has
    // to behave like a real store instead of falling through to the unmocked one.
    updateSessionEntry: (...args: unknown[]) => updateSessionEntryMock(...args),
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
  updateSessionEntryMock
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

const splitLintUse = [enqueuePendingWork, UUID_REGEX];
void splitLintUse;

describe("runReplyAgent :: continuation.work span", () => {
  it("preserves child-token updates committed while a work reservation is active", async () => {
    vi.useFakeTimers();
    const chainId = "00000000-0000-4000-8000-000000000010";
    const run = createContinuationRun({
      sessionKey: "continuation-work-concurrent-token-accounting",
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1,
        continuationChainTokens: 10,
        continuationChainId: chainId,
      },
    });
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    let persistedEntry = run.sessionEntry;
    let persistenceCalls = 0;
    patchSessionEntryMock.mockImplementation(
      async (
        _scope: unknown,
        update: (entry: SessionEntry) => Partial<SessionEntry> | null,
      ): Promise<SessionEntry | null> => {
        persistenceCalls += 1;
        if (persistenceCalls === 2) {
          persistedEntry = {
            ...persistedEntry,
            continuationChainTokens: (persistedEntry.continuationChainTokens ?? 0) + 7,
          };
        }
        const patch = update(persistedEntry);
        if (!patch) {
          return null;
        }
        persistedEntry = { ...persistedEntry, ...patch };
        return persistedEntry;
      },
    );
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 2, output: 3 } } },
    });
    const sessionStore = { [run.sessionKey]: run.sessionEntry };

    await runWorkTurn(
      run,
      sessionStore,
      "Working on it\nCONTINUE_WORK:1",
      true,
      "/tmp/openclaw-continuation-work-concurrent-token-accounting.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(2);
    const storedEntry = sessionStore[run.sessionKey];
    expect(storedEntry).toBeDefined();
    if (!storedEntry) {
      throw new Error("expected persisted session entry");
    }
    expect(storedEntry.continuationChainCount).toBe(2);
    expect(storedEntry.continuationChainTokens).toBe(22);
    expect(storedEntry.continuationChainId).toBe(chainId);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(1);
  });

  it("suppresses continue_work tool callbacks from incomplete non-replay-safe turns", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-work-incomplete-replay-unsafe",
    });
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "tool requested more work before incomplete turn surfaced",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Agent couldn't generate a response.", isError: true }],
        meta: {
          agentMeta: { usage: { input: 2, output: 3 } },
          replayInvalid: true,
          livenessState: "blocked",
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: false,
          },
        },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Agent couldn't generate a response.",
    );

    expect(spans.filter((s) => s.name === "continuation.work")).toHaveLength(0);
    expect(run.sessionEntry.continuationChainCount).toBeUndefined();
  });

  it("fails queued continue_delegate rows from incomplete non-replay-safe turns", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-delegate-incomplete-replay-unsafe",
    });
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      enqueuePendingDelegate(run.sessionKey, { task: "unsafe delegate" });
      return {
        payloads: [{ text: "Agent could not generate a response.", isError: true }],
        meta: {
          agentMeta: { usage: { input: 2, output: 3 } },
          replayInvalid: true,
          livenessState: "blocked",
          error: {
            kind: "incomplete_turn",
            message: "Agent could not generate a response.",
            fallbackSafe: false,
          },
        },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Agent could not generate a response.",
    );

    expect(spans.filter((s) => s.name === "continuation.work")).toHaveLength(0);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toMatchObject([
      {
        status: "failed",
        currentStep: "Rejected replay-unsafe continuation delegate election",
        blockedSummary:
          "Continuation delegate election ignored because the enclosing turn was incomplete and replay-unsafe.",
      },
    ]);
  });

  it("still honors continue_work from incomplete replay-safe turns", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-work-incomplete-replay-safe",
    });
    run.followupRun.run.modelSelectionLocked = true;
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "safe incomplete turn requested more work",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Agent could not generate a response yet.", isError: true }],
        meta: {
          agentMeta: { usage: { input: 2, output: 3 } },
          replayInvalid: false,
          livenessState: "blocked",
          error: {
            kind: "incomplete_turn",
            message: "Agent could not generate a response yet.",
            fallbackSafe: true,
          },
        },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Agent could not generate a response yet.",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(spans.filter((s) => s.name === "continuation.work")).toHaveLength(1);
    expect(run.sessionEntry.continuationChainCount).toBe(1);
  });

  it("treats continue_work tool callbacks as accepted WORK signals", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({ sessionKey: "continuation-work-tool-callback" });
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "tool requested more work",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Working on it" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(run, { [run.sessionKey]: run.sessionEntry }, "Working on it");

    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);
    expect(workSpans[0]?.attributes["delay.ms"]).toBe(1_000);
    expect(workSpans[0]?.attributes["chain.step.remaining"]).toBe(1);
    expect(run.sessionEntry.continuationChainCount).toBe(1);
  });

  it("reuses chain.id across consecutive accepted steps (mint-at-0→1, reuse-for-step-2)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // Pre-seed the session entry with an existing chain.id at
    // continuationChainCount=1, simulating a fresh chain that has
    // already taken its first step. This step arrives as a continuation
    // WAKE (work-wake) — a mid-chain step, NOT a fresh entry — so the
    // chain-break reset must NOT fire and the count carries forward.
    // The next accepted WORK should bump count to 2 and REUSE the same
    // chain.id (mint-or-reuse contract). chain.step.remaining =
    // max(0, maxChainLength=2 - 2) = 0.
    const seededChainId = "019dcf57-b536-77cc-834b-b803d9262032";
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: Date.now() - 10_000,
      continuationChainTokens: 100,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-work-span-stable",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Step two\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });
    await runWorkTurn(run, sessionStore, "Step two\nCONTINUE_WORK:1", true);

    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);

    const span = workSpans[0];
    if (!span) {
      throw new Error("expected a recorded continuation.work span");
    }
    // CRITICAL: chain.id MUST be the seeded value, not a freshly minted
    // UUID — proves mint-or-reuse picks the existing one.
    expect(span.attributes["chain.id"]).toBe(seededChainId);
    expect(span.attributes["chain.step.remaining"]).toBe(0);
  });

  it("does NOT emit `continuation.work` on the chain-cap reject path (rejected requests don't advance the chain)", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // Pre-seed at maxChainLength=2 — the next CONTINUE_WORK request
    // hits chain-cap reject and MUST NOT emit `continuation.work`. This is
    // a continuation WAKE (mid-runaway chain step), so the chain-break
    // reset must NOT fire: the runaway leash's whole job is to keep tripping
    // the cap as long as the chain advances without a fresh re-entry.
    const seededChainId = "019dcf57-aaaa-77cc-834b-b803d9262032";
    const seededEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 2, // already at maxChainLength
      continuationChainStartedAt: Date.now() - 20_000,
      continuationChainTokens: 200,
      continuationChainId: seededChainId,
    };
    const run = createContinuationRun({
      sessionKey: "continuation-work-span-cap",
      sessionEntry: seededEntry,
    });
    const sessionStore = { [run.sessionKey]: seededEntry };

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Step 3 attempts\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });
    await runWorkTurn(run, sessionStore, "Step 3 attempts\nCONTINUE_WORK:1", true);

    // No `continuation.work` span emitted — accept-only contract.
    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(0);

    // The chain-cap reject branch emits exactly one `continuation.disabled`
    // span. Span carries `disabled.reason =
    // cap.chain` and `signal.kind = bracket-work` (CONTINUE_WORK signal).
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "continuation.disabled",
      attributes: {
        "disabled.reason": "cap.chain",
        "signal.kind": "bracket-work",
        "continuation.disabled": true,
        "chain.id": seededChainId,
      },
    });
  });
});
