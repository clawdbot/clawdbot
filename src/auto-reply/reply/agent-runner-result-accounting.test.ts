import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";

const state = vi.hoisted(() => ({
  dispatchPostCompactionDelegates: vi.fn(),
  emitContinuationCompactionReleasedSpan: vi.fn(),
  incrementRunCompactionCount: vi.fn(),
  recordNoOpRearmOutcome: vi.fn(),
  scheduleContinuation: vi.fn(),
}));

vi.mock("./agent-runner-continuation-schedule.js", () => ({
  scheduleReplyContinuation: (...args: unknown[]) => state.scheduleContinuation(...args),
}));

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: (...args: unknown[]) => state.incrementRunCompactionCount(...args),
  persistRunSessionUsage: vi.fn(),
}));

vi.mock("./no-op-rearm-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./no-op-rearm-guard.js")>();
  return {
    ...actual,
    recordNoOpRearmOutcome: (...args: unknown[]) => state.recordNoOpRearmOutcome(...args),
    summarizeEmbeddedRunOutcome: () => ({
      hasVisibleReply: true,
      toolNames: [],
      structuredCompletion: false,
      errorOnlyNoGain: false,
    }),
  };
});

vi.mock("./post-compaction-delegate-dispatch.js", () => ({
  dispatchPostCompactionDelegates: (...args: unknown[]) =>
    state.dispatchPostCompactionDelegates(...args),
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationCompactionReleasedSpan: (...args: unknown[]) =>
    state.emitContinuationCompactionReleasedSpan(...args),
  formatActiveContinuationTraceparent: vi.fn(),
  resolveContinuationTraceparent: vi.fn(),
}));

const { accountFollowupTurn } = await import("./agent-runner-result-accounting.js");

const continuationConfig = {
  agents: {
    defaults: {
      continuation: {
        enabled: true,
        maxChainLength: 10,
        defaultDelayMs: 15_000,
        minDelayMs: 5_000,
        maxDelayMs: 86_400_000,
        costCapTokens: 50_000,
        maxDelegatesPerTurn: 5,
      },
    },
  },
} satisfies OpenClawConfig;

function createTurn(): AdmittedFollowupTurn {
  let currentEntry: SessionEntry | undefined = {
    sessionId: "session-1",
    updatedAt: 1,
    pendingPostCompactionDelegates: [{ task: "release after compaction", createdAt: 1 }],
  };
  const sessionStore: Record<string, SessionEntry> = { main: currentEntry };
  return {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session-1",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: continuationConfig,
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: continuationConfig,
    sessionStore,
    session: {
      kind: "session",
      key: "main",
      current: () => currentEntry,
      publish: (entry) => {
        currentEntry = entry;
        if (entry) {
          sessionStore.main = entry;
        }
      },
      adopt: (entry) => {
        currentEntry = entry;
        sessionStore.main = entry;
      },
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    noOpRearmWakeClass: { kind: "fresh_human_edge", messageId: "message-1" },
  };
}

function createExecution(
  overrides: {
    autoCompactionCount?: number;
    compactionTraceparent?: string;
    continueWorkRequests?: Array<{ reason: string; delaySeconds: number }>;
  } = {},
): FollowupExecutionResult {
  return {
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 0,
            agentMeta: {
              provider: "anthropic",
              model: "claude",
              sessionId: "session-1",
              usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
            },
          },
        },
        continueWorkRequests: overrides.continueWorkRequests ?? [
          { reason: "finish queued work", delaySeconds: 30 },
        ],
        compactionTraceparent: overrides.compactionTraceparent,
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: overrides.autoCompactionCount ?? 0,
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: Date.now() - 10,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(),
      visibleToolErrorObserved: () => false,
    },
  } as FollowupExecutionResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.dispatchPostCompactionDelegates.mockResolvedValue({
    queuedDelegates: 1,
    droppedDelegates: 0,
  });
  state.incrementRunCompactionCount.mockResolvedValue(7);
  state.scheduleContinuation.mockResolvedValue(undefined);
});

describe("accountFollowupTurn", () => {
  it("forwards queued continue_work requests into continuation scheduling", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;

    await accountFollowupTurn({
      turn,
      defaults,
      execution: createExecution(),
    });

    expect(state.scheduleContinuation).toHaveBeenCalledOnce();
    expect(state.recordNoOpRearmOutcome).toHaveBeenCalledWith({
      sessionKey: "main",
      wakeClass: { kind: "fresh_human_edge", messageId: "message-1" },
      runId: "run-1",
      facts: {
        hasVisibleReply: true,
        toolNames: [],
        structuredCompletion: false,
        errorOnlyNoGain: false,
      },
    });
    expect(state.scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: continuationConfig,
        sessionKey: "main",
        followupRun: turn.queued,
        runId: "run-1",
        usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
        effectiveContinuationSignal: expect.objectContaining({
          kind: "work",
          delayMs: 30_000,
        }),
        effectiveContinueWorkRequests: [{ reason: "finish queued work", delaySeconds: 30 }],
        continuationWorkReason: "finish queued work",
      }),
    );
  });

  it("releases staged delegates before scheduling same-turn post-compaction work", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;
    const order: string[] = [];
    state.dispatchPostCompactionDelegates.mockImplementation(async () => {
      order.push("release");
      return { queuedDelegates: 1, droppedDelegates: 0 };
    });
    state.scheduleContinuation.mockImplementation(async () => {
      order.push("schedule");
    });

    await accountFollowupTurn({
      turn,
      defaults,
      execution: createExecution({
        autoCompactionCount: 1,
        compactionTraceparent: "00-trace",
      }),
    });

    expect(order).toEqual(["release", "schedule"]);
    expect(state.dispatchPostCompactionDelegates).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: continuationConfig,
        compactionCount: 7,
        continuationSignalKind: "work",
        followupRun: turn.queued,
        releaseTraceparent: "00-trace",
        sessionKey: "main",
        sessionStore: turn.sessionStore,
      }),
    );
    expect(state.emitContinuationCompactionReleasedSpan).toHaveBeenCalledWith({
      releasedCount: 1,
      compactionId: 7,
      traceparent: "00-trace",
      log: expect.any(Function),
    });
  });
});
