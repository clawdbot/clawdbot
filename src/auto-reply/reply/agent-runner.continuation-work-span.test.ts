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

describe("runReplyAgent :: continuation.work span", () => {
  it("emits exactly one `continuation.work` span on accepted WORK with UUID chain.id and clamped chain.step.remaining", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({ sessionKey: "continuation-work-span-accept" });
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 2, output: 3 } } },
    });
    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it\nCONTINUE_WORK:1",
    );

    const workSpans = spans.filter((s) => s.name === "continuation.work");
    expect(workSpans).toHaveLength(1);

    const span = workSpans[0];
    if (!span) {
      throw new Error("expected a recorded continuation.work span");
    }
    expect(span.status).toBe("OK");
    expect(span.ended).toBe(true);

    const attrs = span.attributes;
    expect(attrs["delay.ms"]).toBe(1_000);
    // maxChainLength=2, nextChainCount=1 → remaining=1 (clamped to ≥0)
    expect(attrs["chain.step.remaining"]).toBe(1);
    // chain.id minted by persistContinuationChainState on the 0→1
    // transition; emitter consumes the same id (no re-derivation)
    expect(typeof attrs["chain.id"]).toBe("string");
    expect(attrs["chain.id"] as string).toMatch(UUID_REGEX);
  });

  it("uses a hot-reloaded continuation enablement value at the next enforcement point", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const staleChainId = "00000000-0000-4000-8000-000000000001";
    const run = createContinuationRun({
      sessionKey: "continuation-work-hot-reload",
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        continuationChainCount: 2,
        continuationChainStartedAt: 1,
        continuationChainTokens: 50,
        continuationChainId: staleChainId,
      },
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: false,
              minDelayMs: 0,
              maxDelayMs: 1_000,
              defaultDelayMs: 1_000,
              maxChainLength: 2,
            },
          },
        },
      },
    });
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      setRuntimeConfigSnapshot({
        ...run.followupRun.run.config,
        agents: {
          ...run.followupRun.run.config.agents,
          defaults: {
            ...run.followupRun.run.config.agents?.defaults,
            continuation: {
              ...run.followupRun.run.config.agents?.defaults?.continuation,
              enabled: true,
            },
          },
        },
      });
      return {
        payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it\nCONTINUE_WORK:1",
    );

    expect(spans.filter((span) => span.name === "continuation.work")).toHaveLength(1);
    expect(run.sessionEntry.continuationChainCount).toBe(1);
    expect(run.sessionEntry.continuationChainId).not.toBe(staleChainId);
  });

  it("does not arm continue_work after enablement is disabled at the scheduling seam", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-work-disabled-before-schedule",
    });
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const continuation = run.followupRun.run.config.agents?.defaults?.continuation;
      if (!continuation) {
        throw new Error("expected continuation config");
      }
      let enabledReads = 0;
      Object.defineProperty(continuation, "enabled", {
        configurable: true,
        get: () => {
          enabledReads += 1;
          if (enabledReads === 2) {
            queueMicrotask(() => {
              setRuntimeConfigSnapshot({
                ...run.followupRun.run.config,
                agents: {
                  ...run.followupRun.run.config.agents,
                  defaults: {
                    ...run.followupRun.run.config.agents?.defaults,
                    continuation: {
                      ...continuation,
                      enabled: false,
                    },
                  },
                },
              });
            });
          }
          return true;
        },
      });
      return {
        payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it\nCONTINUE_WORK:1",
    );

    expect(spans.filter((span) => span.name === "continuation.work")).toHaveLength(0);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(0);
    expect(run.sessionEntry.continuationChainCount).toBeUndefined();
  });

  it("does not arm continue_work when durable chain-state reservation fails", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-work-persistence-failure",
    });
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    patchSessionEntryMock.mockRejectedValueOnce(new Error("session database unavailable"));
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Working on it\nCONTINUE_WORK:1" }],
      meta: { agentMeta: { usage: { input: 2, output: 3 } } },
    });
    const sessionStore = { [run.sessionKey]: run.sessionEntry };

    await runWorkTurn(
      run,
      sessionStore,
      "Working on it\nCONTINUE_WORK:1",
      false,
      "/tmp/openclaw-continuation-work-persistence-failure.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(spans.filter((span) => span.name === "continuation.work")).toHaveLength(0);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(0);
    expect(run.sessionEntry.continuationChainCount).toBeUndefined();
  });

  it("rolls back the reservation when continuation is disabled during persistence", async () => {
    vi.useFakeTimers();
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    const run = createContinuationRun({
      sessionKey: "continuation-work-disabled-during-reservation",
    });
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    let persistedEntry = run.sessionEntry;
    let persistenceCalls = 0;
    patchSessionEntryMock.mockImplementation(
      async (
        _scope: unknown,
        update: (entry: SessionEntry) => Partial<SessionEntry> | null,
      ): Promise<SessionEntry | null> => {
        const patch = update(persistedEntry);
        persistenceCalls += 1;
        if (persistenceCalls === 1) {
          setRuntimeConfigSnapshot({
            ...run.followupRun.run.config,
            agents: {
              ...run.followupRun.run.config.agents,
              defaults: {
                ...run.followupRun.run.config.agents?.defaults,
                continuation: {
                  ...run.followupRun.run.config.agents?.defaults?.continuation,
                  enabled: false,
                },
              },
            },
          });
        }
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
      false,
      "/tmp/openclaw-continuation-work-disable-reservation.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(2);
    expect(spans.filter((span) => span.name === "continuation.work")).toHaveLength(0);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(0);
    const storedEntry = sessionStore[run.sessionKey];
    expect(storedEntry).toBeDefined();
    if (!storedEntry) {
      throw new Error("expected persisted session entry");
    }
    expect(storedEntry.continuationChainCount).toBe(0);
    expect(storedEntry.continuationChainTokens).toBe(0);
    expect(storedEntry.continuationChainId).toBeUndefined();
  });

  it("uses hot-reloaded continuation limits after durable reservation", async () => {
    vi.useFakeTimers();
    const run = createContinuationRun({
      sessionKey: "continuation-work-limits-reloaded-after-reservation",
    });
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    let persistedEntry = run.sessionEntry;
    let persistenceCalls = 0;
    patchSessionEntryMock.mockImplementation(
      async (
        _scope: unknown,
        update: (entry: SessionEntry) => Partial<SessionEntry> | null,
      ): Promise<SessionEntry | null> => {
        const patch = update(persistedEntry);
        persistenceCalls += 1;
        if (persistenceCalls === 1) {
          setRuntimeConfigSnapshot({
            ...run.followupRun.run.config,
            agents: {
              ...run.followupRun.run.config.agents,
              defaults: {
                ...run.followupRun.run.config.agents?.defaults,
                continuation: {
                  ...run.followupRun.run.config.agents?.defaults?.continuation,
                  maxChainLength: 1,
                },
              },
            },
          });
        }
        if (!patch) {
          return null;
        }
        persistedEntry = { ...persistedEntry, ...patch };
        return persistedEntry;
      },
    );
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "first reserved election",
        delaySeconds: 1,
      });
      options.continueWorkOpts?.requestContinuation?.({
        reason: "second election rejected by live limit",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Working on it" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });
    const sessionStore = { [run.sessionKey]: run.sessionEntry };

    await runWorkTurn(
      run,
      sessionStore,
      "Working on it",
      false,
      "/tmp/openclaw-continuation-work-live-limits.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(2);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(1);
    expect(sessionStore[run.sessionKey]?.continuationChainCount).toBe(1);
  });

  it("does not schedule beyond the durable reservation when the live chain limit increases", async () => {
    vi.useFakeTimers();
    const run = createContinuationRun({
      sessionKey: "continuation-work-limit-increased-after-reservation",
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: true,
              minDelayMs: 0,
              maxDelayMs: 1_000,
              defaultDelayMs: 1_000,
              maxChainLength: 1,
            },
          },
        },
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
          throw new Error("session database unavailable during reconciliation");
        }
        const patch = update(persistedEntry);
        setRuntimeConfigSnapshot({
          ...run.followupRun.run.config,
          agents: {
            ...run.followupRun.run.config.agents,
            defaults: {
              ...run.followupRun.run.config.agents?.defaults,
              continuation: {
                ...run.followupRun.run.config.agents?.defaults?.continuation,
                maxChainLength: 2,
              },
            },
          },
        });
        if (!patch) {
          return null;
        }
        persistedEntry = { ...persistedEntry, ...patch };
        return persistedEntry;
      },
    );
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "durably reserved election",
        delaySeconds: 1,
      });
      options.continueWorkOpts?.requestContinuation?.({
        reason: "election beyond durable reservation",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Working on it" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });
    const sessionStore = { [run.sessionKey]: run.sessionEntry };

    await runWorkTurn(
      run,
      sessionStore,
      "Working on it",
      false,
      "/tmp/openclaw-continuation-work-live-limit-increase.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(2);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toHaveLength(1);
    expect(persistedEntry.continuationChainCount).toBe(1);
    expect(sessionStore[run.sessionKey]?.continuationChainCount).toBe(1);
  });

  it("preserves parked work when concurrency leaves no newly reserved scheduling slots", async () => {
    vi.useFakeTimers();
    const chainId = "00000000-0000-4000-8000-000000000011";
    const run = createContinuationRun({
      sessionKey: "continuation-work-zero-new-reservation",
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: true,
              minDelayMs: 0,
              maxDelayMs: 1_000,
              defaultDelayMs: 1_000,
              maxChainLength: 1,
            },
          },
        },
      },
    });
    const existingWork = enqueuePendingWork({
      sessionKey: run.sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 1,
      chainStartedAt: 1,
      accumulatedChainTokens: 0,
      reason: "preserve existing parked work",
      chainId,
      anchorPending: true,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    });
    if (!existingWork?.flowId) {
      throw new Error("expected existing parked continuation work");
    }
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    let persistedEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1,
      continuationChainTokens: 0,
      continuationChainId: chainId,
    };
    patchSessionEntryMock.mockImplementation(
      async (
        _scope: unknown,
        update: (entry: SessionEntry) => Partial<SessionEntry> | null,
      ): Promise<SessionEntry | null> => {
        const patch = update(persistedEntry);
        if (!patch) {
          return null;
        }
        persistedEntry = { ...persistedEntry, ...patch };
        return persistedEntry;
      },
    );
    runEmbeddedAgentMock.mockImplementationOnce(async (args: unknown) => {
      const options = args as {
        continueWorkOpts?: {
          requestContinuation?: (request: { reason: string; delaySeconds: number }) => void;
        };
      };
      options.continueWorkOpts?.requestContinuation?.({
        reason: "concurrently capped election",
        delaySeconds: 1,
      });
      return {
        payloads: [{ text: "Working on it" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it",
      false,
      "/tmp/openclaw-continuation-work-zero-new-reservation.json",
    );

    expect(patchSessionEntryMock).toHaveBeenCalledTimes(2);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toMatchObject([
      { flowId: existingWork.flowId, status: "queued" },
    ]);
    expect(persistedEntry.continuationChainCount).toBe(1);
    expect(persistedEntry.continuationChainTokens).toBe(0);
  });

  it("keeps hedge-fired delegates recoverable when chain-state persistence fails", async () => {
    vi.useFakeTimers();
    const run = createContinuationRun({
      sessionKey: "continuation-delegate-hedge-persistence-failure",
    });
    loadSessionEntryMock.mockReturnValue(run.sessionEntry);
    patchSessionEntryMock.mockRejectedValueOnce(new Error("session database unavailable"));
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      enqueuePendingDelegate(run.sessionKey, {
        task: "persist before terminalizing this delayed delegate",
        delayMs: 1_000,
      });
      return {
        payloads: [{ text: "Working on it" }],
        meta: { agentMeta: { usage: { input: 2, output: 3 } } },
      };
    });

    await runWorkTurn(
      run,
      { [run.sessionKey]: run.sessionEntry },
      "Working on it",
      false,
      "/tmp/openclaw-continuation-delegate-hedge-persist.json",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(patchSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(listTaskFlowsForOwnerKey(run.sessionKey)).toMatchObject([{ status: "running" }]);
  });
});
