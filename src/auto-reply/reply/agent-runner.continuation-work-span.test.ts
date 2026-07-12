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
  testing as embeddedRunTesting,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
} from "../../agents/embedded-agent-runner/runs.js";
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
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import { listTaskFlowsForOwnerKey } from "../../tasks/task-flow-runtime-internal.js";
import { enqueuePendingDelegate } from "../continuation-delegate-store.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { __testing as replyRunRegistryTesting } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

// Suppress unused-import diagnostic — registerMemoryFlushPlanResolver is
// imported because some siblings register a stub; not strictly required
// here, kept for parity with the misc.runreplyagent harness.
void registerMemoryFlushPlanResolver;

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
    // #987 chain-break reset must NOT fire and the count carries forward.
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
    // a continuation WAKE (mid-runaway chain step), so the #987 chain-break
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

describe("runReplyAgent :: continuation chain-break reset (#987)", () => {
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

  it("resets a stale at-cap chain budget on an ordinary subagent-return so a fresh continuation passes the cap (#989 doom-lock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);

    // The #987/#989 "195-forever" doom-lock: a long-lived session carries a
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
