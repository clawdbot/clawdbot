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
  persistRunSessionUsage: vi.fn(async (_params: unknown) => undefined),
  refreshQueuedFollowupSession: vi.fn(),
  scheduleContinuation: vi.fn(),
}));

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: () => false,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: vi.fn(async () => {}),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./agent-runner-continuation-schedule.js", () => ({
  scheduleReplyContinuation: (...args: unknown[]) => state.scheduleContinuation(...args),
}));

vi.mock("../fallback-state.js", () => ({
  resolveFallbackTransition: () => ({
    stateChanged: true,
    nextState: {
      selectedModel: "anthropic/claude",
      activeModel: "openai/gpt-4o",
      reason: "rate limit",
    },
  }),
}));

vi.mock("./agent-runner-core.js", () => ({
  resolveFallbackOriginModel: () => ({
    provider: "anthropic",
    model: "claude",
  }),
}));

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: (...args: unknown[]) => state.incrementRunCompactionCount(...args),
  persistRunSessionUsage: (params: unknown) => state.persistRunSessionUsage(params),
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

vi.mock("../../sessions/input-provenance.js", () => ({
  shouldPreserveUserFacingSessionStateForInputProvenance: () => false,
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) => state.refreshQueuedFollowupSession(...args),
}));

vi.mock("./reply-usage-state.js", () => ({
  buildReplyUsageState: () => ({}),
  recordReplyUsageState: vi.fn(),
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
    commentaryPayloadsEnabled: false,
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

  it("forwards typed runtime context provenance to session persistence", async () => {
    const params = createFallbackParams();
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    };

    await accountFollowupTurn(params);

    expect(state.persistRunSessionUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        contextTokensUsed: 1_000_000,
        contextTokensSource: "runtime",
      }),
    );
  });

  it("prefers a delegate token retained only in raw terminal text over typed continue_work", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;
    const execution = createExecution();
    if (execution.execution.outcome.kind !== "settled") {
      throw new Error("expected settled execution");
    }
    execution.execution.outcome.result.payloads = [{ text: "handoff queued" }];
    execution.execution.outcome.rawContinuationText =
      "handoff queued\n[[CONTINUE_DELEGATE: inspect followup state]]";

    await accountFollowupTurn({ turn, defaults, execution });

    expect(state.scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveContinuationSignal: expect.objectContaining({
          kind: "delegate",
          task: "inspect followup state",
        }),
        continuationExtractionFromBracket: true,
        effectiveContinueWorkRequests: [{ reason: "finish queued work", delaySeconds: 30 }],
        continuationWorkReason: undefined,
      }),
    );
  });

  it("forwards a work token retained only in raw terminal text", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;
    const execution = createExecution({ continueWorkRequests: [] });
    if (execution.execution.outcome.kind !== "settled") {
      throw new Error("expected settled execution");
    }
    execution.execution.outcome.result.payloads = [{ text: "more remains" }];
    execution.execution.outcome.rawContinuationText = "more remains\n[[CONTINUE_WORK:45]]";

    await accountFollowupTurn({ turn, defaults, execution });

    expect(state.scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveContinuationSignal: { kind: "work", delayMs: 45_000 },
        continuationExtractionFromBracket: true,
        continuationWorkReason: undefined,
      }),
    );
  });

  it("does not recover a non-terminal delegate token from raw text", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;
    const execution = createExecution({ continueWorkRequests: [] });
    if (execution.execution.outcome.kind !== "settled") {
      throw new Error("expected settled execution");
    }
    execution.execution.outcome.result.payloads = [{ text: "final answer" }];
    execution.execution.outcome.rawContinuationText =
      "[[CONTINUE_DELEGATE: stale task]]\nfinal answer";

    await accountFollowupTurn({ turn, defaults, execution });

    expect(state.scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveContinuationSignal: null,
        continuationExtractionFromBracket: false,
      }),
    );
  });

  it("does not recover selected raw text when the settled fallback result is replay-unsafe", async () => {
    const turn = createTurn();
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "anthropic/claude",
      opts: { isHeartbeat: true },
    } satisfies FollowupRunnerParams;
    const execution = createExecution({ continueWorkRequests: [] });
    if (execution.execution.outcome.kind !== "settled") {
      throw new Error("expected settled execution");
    }
    execution.execution.outcome.result.payloads = [{ text: "partial" }];
    execution.execution.outcome.result.meta.error = {
      kind: "incomplete_turn",
      message: "latest fallback interrupted",
    };
    execution.execution.outcome.result.meta.replayInvalid = true;
    execution.execution.outcome.rawContinuationText =
      "preferred\n[[CONTINUE_DELEGATE: stale selected task]]";

    await accountFollowupTurn({ turn, defaults, execution });

    expect(state.scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveContinuationSignal: null,
        continuationExtractionFromBracket: false,
        effectiveContinueWorkRequests: [],
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

  function createFallbackParams(
    authProfileOverrideCompactionCount?: number,
  ): Parameters<typeof accountFollowupTurn>[0] {
    let entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      authProfileOverride: "openai:work",
      ...(authProfileOverrideCompactionCount === undefined
        ? {}
        : { authProfileOverrideCompactionCount }),
    };
    const sessionStore = { main: entry };
    const turn = {
      runId: "run-1",
      queued: {
        prompt: "queued prompt",
        enqueuedAt: 1,
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session-1",
          sessionKey: "main",
          sessionFile: "main",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
        },
      },
      operation: {},
      config: {},
      session: {
        kind: "session",
        key: "main",
        current: () => entry,
        publish: (next: SessionEntry | undefined) => {
          if (next) {
            entry = next;
            sessionStore.main = next;
          }
        },
        adopt: (next: SessionEntry) => {
          entry = next;
          sessionStore.main = next;
        },
      },
      sessionStore,
      sendPolicy: "allow",
      preflightCompactionApplied: false,
    } as unknown as AdmittedFollowupTurn;
    const defaults = {
      typing: {} as FollowupRunnerParams["typing"],
      typingMode: "never",
      defaultModel: "claude",
      sessionKey: "main",
    } satisfies FollowupRunnerParams;
    const execution = {
      commentaryPayloadsEnabled: false,
      execution: {
        runId: "run-1",
        outcome: {
          kind: "settled",
          status: "ok",
          result: { payloads: [], meta: { durationMs: 0 } },
          resolved: { provider: "openai", model: "gpt-4o" },
          fallback: {
            exhausted: false,
            attempts: [
              {
                provider: "anthropic",
                model: "claude",
                error: "rate limited",
                reason: "rate_limit",
              },
            ],
          },
          autoCompactionCount: 0,
          didLogHeartbeatStrip: false,
        },
      },
      runStartedAt: 1,
      sessionCtx: {},
      pendingToolTasks: new Set(),
      progress: {
        drain: vi.fn(async () => {}),
        visibleToolErrorObserved: () => false,
      },
    } as FollowupExecutionResult;
    return { turn, defaults, execution };
  }

  describe("accountFollowupTurn fallback auth provenance", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it.each([
      {
        name: "source-less legacy user pin",
        authProfileOverrideCompactionCount: undefined,
        expectedSource: "user",
      },
      {
        name: "source-less compaction-marked auto pin",
        authProfileOverrideCompactionCount: 0,
        expectedSource: "auto",
      },
    ] as const)(
      "forwards a $name with canonical provenance during fallback queue refresh",
      async ({ authProfileOverrideCompactionCount, expectedSource }) => {
        await accountFollowupTurn(createFallbackParams(authProfileOverrideCompactionCount));

        expect(state.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
        expect(state.refreshQueuedFollowupSession).toHaveBeenCalledWith(
          expect.objectContaining({
            key: "main",
            nextProvider: "openai",
            nextModel: "gpt-4o",
            nextAuthProfileId: "openai:work",
            nextAuthProfileIdSource: expectedSource,
          }),
        );
      },
    );
  });
});
